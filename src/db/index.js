'use strict';
const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');
const migrations = require('./schema');

// Postgres type OIDs we normalise so the app works with plain JS numbers/strings.
const INT8 = 20;     // bigint / COUNT(*)
const NUMERIC = 1700; // SUM(bigint)
const DATE = 1082;

const toInt = (v) => (v === null ? null : Number(v));

let impl = null;

async function connect() {
  if (impl) return impl;

  if (config.databaseUrl.startsWith('pglite:')) {
    // Embedded PostgreSQL (WASM) - for local development & automated tests only.
    const { PGlite } = await import('@electric-sql/pglite');
    const target = config.databaseUrl.slice('pglite:'.length);
    const options = {
      parsers: { [INT8]: toInt, [NUMERIC]: toInt, [DATE]: (v) => v }
    };
    if (target && target !== 'memory') {
      const dir = path.resolve(target);
      fs.mkdirSync(dir, { recursive: true });
      options.dataDir = dir;
    }
    const pg = new PGlite(options);
    await pg.waitReady;
    impl = {
      kind: 'pglite',
      query: (text, params = []) => pg.query(text, params),
      exec: (sql) => pg.exec(sql),
      tx: (fn) => pg.transaction((t) => fn({ query: (text, params = []) => t.query(text, params) })),
      close: () => pg.close()
    };
  } else {
    const pgLib = require('pg');
    pgLib.types.setTypeParser(INT8, toInt);
    pgLib.types.setTypeParser(NUMERIC, toInt);
    pgLib.types.setTypeParser(DATE, (v) => v);
    const pool = new pgLib.Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false
    });
    pool.on('error', (err) => console.error('[db] idle client error', err.message));
    impl = {
      kind: 'postgres',
      query: (text, params = []) => pool.query(text, params),
      exec: (sql) => pool.query(sql),
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: (text, params = []) => client.query(text, params) });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end()
    };
  }
  return impl;
}

async function migrate() {
  const db = await connect();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    await db.tx(async (t) => {
      // Split on statement boundaries so it works with both drivers inside a transaction.
      const statements = m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
      for (const stmt of statements) await t.query(stmt);
      await t.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
    console.log(`[db] applied migration ${m.version}_${m.name}`);
  }
}

const db = {
  connect,
  migrate,
  query: async (text, params) => (await connect()).query(text, params),
  one: async (text, params) => (await (await connect()).query(text, params)).rows[0] || null,
  many: async (text, params) => (await (await connect()).query(text, params)).rows,
  tx: async (fn) => (await connect()).tx(fn),
  close: async () => {
    if (impl) await impl.close();
    impl = null;
  }
};

module.exports = db;

