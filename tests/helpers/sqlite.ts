import { createRequire } from 'node:module';
import type { SqlDb, SqlStatement } from '../../src/data/sql';

interface NativeStatement {
  get(...v: unknown[]): Record<string, unknown> | undefined;
  all(...v: unknown[]): Array<Record<string, unknown>>;
  run(...v: unknown[]): unknown;
}
interface NativeDb {
  prepare(sql: string): NativeStatement;
}

/** Adapter exposing Node's built-in SQLite through the same D1-style interface the SqlRepo uses. */
export function createSqliteDb(): SqlDb {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => NativeDb };
  const native = new DatabaseSync(':memory:');
  const wrap = (sql: string, params: unknown[] = []): SqlStatement => ({
    bind: (...v: unknown[]) => wrap(sql, v),
    first: async <T>() => (native.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async <T>() => ({ results: native.prepare(sql).all(...params) as T[] }),
    run: async () => native.prepare(sql).run(...params),
  });
  return { prepare: (sql: string) => wrap(sql) };
}
