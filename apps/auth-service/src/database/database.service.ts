import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Pool, PoolClient, type QueryResultRow} from 'pg';

/**
 * Audit fix 1.1 — narrow query interface that BOTH the pool and a
 * checked-out client can satisfy. Callers that don't care whether
 * they're inside a transaction take this; the transaction body
 * receives a Tx that is identical at the type level.
 */
export interface Tx {
  q<T extends QueryResultRow = QueryResultRow>(
    sql: string, params?: unknown[],
  ): Promise<T[]>;
  qOne<T extends QueryResultRow = QueryResultRow>(
    sql: string, params?: unknown[],
  ): Promise<T | null>;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy, Tx {
  private readonly logger = new Logger(DatabaseService.name);
  private pool!: Pool;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.pool = new Pool({connectionString: this.config.get<string>('databaseUrl')});
    this.pool.on('error', (err) => this.logger.error('pg pool error', err.message));
    this.logger.log('PostgreSQL pool ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /** Run a query and return all rows. */
  async q<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  /** Run a query and return the first row, or null. */
  async qOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.q<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Audit fix 1.1 — run a function inside a single transaction.
   *
   *   await db.withTransaction(async tx => {
   *     const row = await tx.qOne('SELECT ... FOR UPDATE', [...]);
   *     await tx.q('UPDATE ...', [...]);
   *   });
   *
   * Behavior:
   *   - BEGIN before the callback, COMMIT on resolved value, ROLLBACK on
   *     thrown error — error is re-thrown so the caller still sees it.
   *   - Releases the pool client in `finally` so a leaked exception
   *     can't pin a connection.
   *   - The `Tx` object handed to the callback has the same `q` / `qOne`
   *     surface as the service itself, so service methods designed
   *     against `Tx` can run either standalone (passing `db`) or inside
   *     a transaction (passing the tx).
   *
   * Use FOR UPDATE inside the callback to lock rows against concurrent
   * writers — without that, two ops admins clicking "approve" at the
   * same moment will both pass the status check and double-write.
   */
  async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = makeTxFromClient(client);
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      // Log a swallowed ROLLBACK separately — if both the callback AND
      // the rollback fail (e.g. connection dropped mid-statement), the
      // rollback diagnostic is the only signal that the txn was left in
      // an inconsistent state on the server side. Re-throw the ORIGINAL
      // callback error since that's what the caller acted on.
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        this.logger.warn(`rollback failed after txn error: ${(rbErr as Error).message}`);
      }
      throw e;
    } finally {
      client.release();
    }
  }
}

function makeTxFromClient(client: PoolClient): Tx {
  return {
    async q<T extends QueryResultRow = QueryResultRow>(
      sql: string, params: unknown[] = [],
    ): Promise<T[]> {
      const r = await client.query<T>(sql, params);
      return r.rows;
    },
    async qOne<T extends QueryResultRow = QueryResultRow>(
      sql: string, params: unknown[] = [],
    ): Promise<T | null> {
      const r = await client.query<T>(sql, params);
      return r.rows[0] ?? null;
    },
  };
}
