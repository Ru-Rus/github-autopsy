const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
const cli = path.join(
  path.dirname(require.resolve("@playwright/test/package.json")),
  "cli.js",
);
async function run() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const embedded = new EmbeddedPostgres({
    databaseDir: path.resolve(".test-runtime", "browser-" + randomUUID()),
    port,
    user: "postgres",
    password: "browser-test-password",
    persistent: true,
    createPostgresUser: false,
    onLog: () => {},
    onError: () => {},
  });
  let pool;
  try {
    await embedded.initialise();
    await embedded.start();
    env.DATABASE_URL = `postgresql://postgres:browser-test-password@127.0.0.1:${port}/postgres`;
    env.TRUSTED_PROXY_SECRET = "browser-proxy-" + randomUUID();
    env.MONITORING_TOKEN = "browser-monitor-" + randomUUID();
    pool = new Pool({ connectionString: env.DATABASE_URL });
    await pool.query(
      fs.readFileSync(path.resolve("migrations/001-production.sql"), "utf8"),
    );
    const result = spawnSync(
      process.execPath,
      [cli, "test", ...process.argv.slice(2)],
      { env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await pool?.end();
    await embedded.stop();
  }
}
run().catch(() => {
  console.error("Browser test infrastructure failed.");
  process.exitCode = 1;
});
