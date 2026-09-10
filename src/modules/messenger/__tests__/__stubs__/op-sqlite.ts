/**
 * Jest mock for `@op-engineering/op-sqlite` in the `messenger-crypto`
 * project.
 *
 * The real package is a JSI native module (SQLCipher). Under `node` it
 * cannot load, and because `crypto/db.ts` imports `open` at module
 * scope, EVERY module whose import graph touches the SQLCipher store is
 * unloadable by this project — including `productionRuntime.ts`.
 *
 * SCOPE. The messenger tree uses exactly one export: `open`. This mock
 * returns a handle that satisfies the `DbHandle` shape and THROWS on any
 * query.
 *
 * That throw is deliberate and is the whole design decision here. A
 * plausible in-memory SQLite fake would let suites assert against a
 * database that is not SQLCipher, has none of the compartment ATTACHes,
 * and none of the PRAGMA behaviour the production path depends on —
 * green tests describing a system that does not exist. Making `open`
 * resolve but `execute` throw achieves the narrow goal (modules become
 * IMPORTABLE, so their pure logic can be executed and their exports
 * inspected) without inviting anyone to build storage assertions on
 * sand. A suite that genuinely needs a working database should mock
 * `crypto/db` at the seam it cares about.
 */

export class OpSqliteMockError extends Error {
  constructor(operation: string) {
    super(
      `op-sqlite is not available under jest (${operation}). This mock exists so modules ` +
        'that import the SQLCipher store can be LOADED, not so they can query. Mock the ' +
        'store seam your suite actually needs.',
    );
    this.name = 'OpSqliteMockError';
  }
}

export interface MockDbHandle {
  execute: (sql?: string, params?: unknown[]) => Promise<{rows: never[]; rowsAffected: number}>;
  close: () => void;
  delete: () => void;
  attach: (...args: unknown[]) => void;
  detach: (...args: unknown[]) => void;
  transaction: (fn: unknown) => Promise<void>;
}

export function open(_options: {
  name: string;
  encryptionKey?: string;
  location?: string;
}): MockDbHandle {
  return {
    execute: () => Promise.reject(new OpSqliteMockError('execute')),
    close: () => {},
    delete: () => {},
    attach: () => {
      throw new OpSqliteMockError('attach');
    },
    detach: () => {
      throw new OpSqliteMockError('detach');
    },
    transaction: () => Promise.reject(new OpSqliteMockError('transaction')),
  };
}

export default {open};
