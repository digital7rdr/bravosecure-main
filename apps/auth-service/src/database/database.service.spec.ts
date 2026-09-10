import {DatabaseService} from './database.service';
import {NotFoundException} from '@nestjs/common';

/**
 * withTransaction became load-bearing for three membership methods (the I-a
 * audit change) and for configureChannel's `instanceof NotFoundException`
 * branch — with zero coverage until now (every other spec stubs it). A fake
 * pool client pins the four-part contract: BEGIN, COMMIT on success,
 * ROLLBACK + rethrow of the ORIGINAL error object on failure (a catch-and-
 * wrap here would turn a benign 404 into channel_tighten_incomplete), and
 * release in every path.
 */
describe('DatabaseService.withTransaction', () => {
  function mk() {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => { queries.push(sql); return {rows: []}; }),
      release: jest.fn(),
    };
    const svc = Object.create(DatabaseService.prototype) as DatabaseService;
    Object.assign(svc, {pool: {connect: async () => client}, logger: {warn: jest.fn()}});
    return {svc, client, queries};
  }

  it('BEGIN → callback → COMMIT, and releases the client', async () => {
    const {svc, client, queries} = mk();
    const out = await svc.withTransaction(async () => 'ok');
    expect(out).toBe('ok');
    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('a callback throw ROLLS BACK and rethrows the ORIGINAL error object', async () => {
    const {svc, client, queries} = mk();
    const boom = new NotFoundException('member_not_found');
    await expect(svc.withTransaction(async () => { throw boom; }))
      .rejects.toBe(boom); // identity, not just message — no wrapping layer
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('a failing ROLLBACK does not mask the original error', async () => {
    const {svc, client} = mk();
    const boom = new Error('original');
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') {throw new Error('rollback failed');}
      return {rows: []};
    });
    await expect(svc.withTransaction(async () => { throw boom; })).rejects.toBe(boom);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
