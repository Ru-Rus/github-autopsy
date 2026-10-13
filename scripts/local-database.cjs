// Persistent development database; keep this process running while using the app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadEnvConfig } = require('@next/env');
const { Pool } = require('pg');

async function main() {
  const root = path.resolve(__dirname, '..');
  const envFile = path.join(root, '.env.local');
  loadEnvConfig(root, true);
  if (!process.env.DATABASE_URL) {
    const password = crypto.randomBytes(24).toString('hex');
    const values = [`DATABASE_URL=postgresql://autopsy:${password}@127.0.0.1:5432/autopsy`];
    // Direct local development uses anonymous rate limits, without a proxy.
    // Configuring TRUSTED_PROXY_SECRET would require proxy headers on every request.
    for (const key of ['MONITORING_TOKEN']) {
      if (!process.env[key]) values.push(`${key}=${crypto.randomBytes(24).toString('hex')}`);
    }
    fs.appendFileSync(envFile, '\n' + values.join('\n') + '\n', { mode: 0o600 });
    process.env.DATABASE_URL = values[0].slice('DATABASE_URL='.length);
  }
  const url = new URL(process.env.DATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/autopsy' || url.username !== 'autopsy') {
    throw new Error('Existing DATABASE_URL is not for the local autopsy database. Use your configured database instead.');
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const directory = path.join(root, '.local-postgres');
  const database = new EmbeddedPostgres({
    databaseDir: directory,
    port: Number(url.port || 5432),
    user: 'autopsy',
    password: decodeURIComponent(url.password),
    authMethod: 'scram-sha-256',
    persistent: true,
    createPostgresUser: false,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  });
  if (!fs.existsSync(path.join(directory, 'PG_VERSION'))) await database.initialise();
  await database.start();
  const stop = async () => { await database.stop(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const admin = new Pool({ connectionString: new URL('/postgres', url).href });
    try {
      const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'autopsy'");
      if (!existing.rowCount) await admin.query('CREATE DATABASE autopsy');
    } finally { await admin.end(); }
    const pool = new Pool({ connectionString: url.href });
    try {
      await pool.query(fs.readFileSync(path.join(root, 'migrations/001-production.sql'), 'utf8'));
      const result = await pool.query('SELECT current_database() AS name');
      console.log(`PostgreSQL ready: ${result.rows[0].name} at 127.0.0.1:${url.port || 5432}. Schema installed.`);
      console.log('DBeaver: PostgreSQL, host 127.0.0.1, database autopsy, user autopsy; password is in .env.local.');
      console.log('Keep this terminal open. Start the app in another terminal with npm run dev.');
    } finally { await pool.end(); }
  } catch (error) {
    await database.stop();
    throw error;
  }
}
main().catch((error) => {
  console.error('Local database startup failed. Check DATABASE_URL, port 5432 availability and .local-postgres permissions.');
  let message = String(error.message);
  if (process.env.DATABASE_URL) {
    message = message.replaceAll(process.env.DATABASE_URL, '[database URL]');
    message = message.replaceAll(decodeURIComponent(new URL(process.env.DATABASE_URL).password), '[password]');
  }
  console.error(message);
  process.exitCode = 1;
});
