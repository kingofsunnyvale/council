import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../worker/index';
import { hash, random } from '../worker/crypto';
import type { AppEnv } from '../worker/env';
import { REQUESTED_MODELS, type Model } from '../shared/config';

class Statement {
  values: unknown[] = [];
  constructor(public db: DatabaseSync, public sql: string) {}
  bind(...values: unknown[]) { const s = new Statement(this.db,this.sql); s.values = values; return s; }
  execute() {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.values as (string|number|null)[]);
    return { results: rows, success: true, meta: { changes: this.db.prepare('SELECT changes() AS n').get()!.n } };
  }
  async first(column?: string) { const row = this.execute().results[0] || null; return column && row ? row[column] : row; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
}
export const fixtureModels: Model[] = REQUESTED_MODELS.map(m => ({ id: m.id, name: `${m.provider}: ${m.name}`, context_length: 200_000, top_provider: { max_completion_tokens: 128_000 }, supported_parameters: ['max_tokens','tools','reasoning'], pricing: { prompt: '0.000002', completion: '0.00001' }, reasoning: { supported_efforts: ['high','low'] } }));
export async function fixture() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../migrations/0001_council.sql',import.meta.url),'utf8'));
  const DB = {
    prepare: (query: string) => new Statement(sql,query),
    batch: async (statements: Statement[]) => {
      sql.exec('BEGIN'); try { const results = statements.map(s => s.execute()); sql.exec('COMMIT'); return results; } catch(e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  const env = { DB, SERVICE_SECRET: random(), ENCRYPTION_KEYS: JSON.stringify({ current: 'v1', keys: { v1: random() } }), OWNER_ID: 'private-workspace', APP_ORIGIN: 'https://council.example' } as unknown as AppEnv;
  const raw = random(); const sessionHash = await hash(raw); const owner = env.OWNER_ID;
  sql.prepare('INSERT INTO users VALUES(?,?,?)').run(owner,'owner',Date.now());
  sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sessionHash,owner,Date.now()+60_000);
  sql.prepare('INSERT INTO catalog_cache VALUES(1,?,?)').run(JSON.stringify(fixtureModels),Date.now());
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as ExecutionContext;
  async function request(path: string, method='GET', body?: unknown, extra?: Record<string,string|null>) {
    const headers = new Headers({ 'x-council-service': env.SERVICE_SECRET!, cookie: '__Host-council-session=' + raw, origin: env.APP_ORIGIN!, 'content-type':'application/json' });
    for (const [key,value] of Object.entries(extra || {})) { if (value === null) headers.delete(key); else headers.set(key,value); }
    return worker.fetch(new Request('https://worker.example'+path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  }
  return { env, sql, owner, raw, sessionHash, request, tasks, ctx };
}
