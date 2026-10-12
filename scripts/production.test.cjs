const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { context } = require("./test-support.cjs");
const first = context(),
  second = context();
let embedded, pool;
let databaseLog = "";
const originalEnv = { ...process.env };
const report = (index = 0) => ({
  repository: { full_name: "sample/project" },
  analyzedAt: new Date(Date.UTC(2026, 9, 12, 0, 0, index)).toISOString(),
  scores: { overall: 72 },
  metrics: { sourceFiles: 5, testFiles: 2, contributors: 1 },
  caveats: [],
});
before(async () => {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  embedded = new EmbeddedPostgres({
    databaseDir: path.resolve(".test-runtime", "postgres-" + randomUUID()),
    port,
    user: "postgres",
    password: "isolated-test-password",
    persistent: true,
    createPostgresUser: false,
    onLog: (message) => {
      databaseLog = (databaseLog + message).slice(-4000);
    },
    onError: () => {},
  });
  await embedded.initialise();
  await embedded.start();
  process.env.DATABASE_URL = `postgresql://postgres:isolated-test-password@127.0.0.1:${port}/postgres`;
  process.env.TRUSTED_PROXY_SECRET = "test-proxy-secret-" + "x".repeat(32);
  process.env.MONITORING_TOKEN = "test-monitor-token-" + "x".repeat(32);
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    fs.readFileSync(path.resolve("migrations/001-production.sql"), "utf8"),
  );
});
beforeEach(async () => {
  await pool.query("TRUNCATE autopsy_limits, autopsy_snapshots");
});
after(async () => {
  await first.load("database.ts").closeDatabase();
  await second.load("database.ts").closeDatabase();
  await pool?.end();
  if (
    embedded?.process?.exitCode !== null &&
    embedded?.process?.exitCode !== undefined
  )
    embedded.process = undefined;
  await embedded?.stop();
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(originalEnv, key)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

test("spoofed forwarding headers cannot change trusted identity or bypass shared limits", async () => {
  const { clientIdentity, createLimiter } = first.load("rate-limit.ts");
  const limiter1 = createLimiter(),
    limiter2 = second.load("rate-limit.ts").createLimiter();
  const request = (index) =>
    new Request("http://localhost/api/analyze", {
      headers: {
        "x-forwarded-for": `1.2.3.${index}`,
        "x-real-ip": `9.8.7.${index}`,
        "x-autopsy-client-ip": "192.0.2.1",
        "x-autopsy-proxy-secret": process.env.TRUSTED_PROXY_SECRET,
      },
    });
  assert.equal(clientIdentity(request(1)), clientIdentity(request(2)));
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? limiter1 : limiter2).request(request(index), "analysis"),
    ),
  );
  assert.equal(results.filter((retry) => retry === 0).length, 5);
  assert.equal(results.filter((retry) => retry > 0).length, 7);
  assert.throws(
    () =>
      clientIdentity(
        new Request("http://localhost", {
          headers: { "x-forwarded-for": "192.0.2.9" },
        }),
      ),
    (error) => error.status === 403,
  );
});
test("global GitHub and OpenAI budgets cannot be exceeded across instances", async () => {
  delete process.env.GITHUB_TOKEN;
  const a = first.load("rate-limit.ts").createLimiter(),
    b = second.load("rate-limit.ts").createLimiter();
  const results = await Promise.all([a.analysis(), b.analysis(), a.analysis()]);
  assert.equal(results.filter((retry) => retry === 0).length, 1);
  const ai = await Promise.all(
    Array.from({ length: 40 }, (_, index) => (index % 2 ? a : b).ai()),
  );
  assert.equal(ai.filter((retry) => retry === 0).length, 30);
});
test("limiter fails closed during database failure and recovers after rollback", async () => {
  await pool.query(
    "ALTER TABLE autopsy_limits RENAME TO autopsy_limits_unavailable",
  );
  await assert.rejects(
    first
      .load("rate-limit.ts")
      .consumeShared([{ key: "test", limit: 1, windowMs: 10000 }]),
  );
  await pool.query(
    "ALTER TABLE autopsy_limits_unavailable RENAME TO autopsy_limits",
  );
  assert.equal(
    await first
      .load("rate-limit.ts")
      .consumeShared([{ key: "test", limit: 1, windowMs: 10000 }]),
    0,
  );
});
test("concurrent snapshot saves enforce one shared storage cap and publish complete rows", async () => {
  const a = first.load("postgres-snapshots.ts").createPostgresSnapshotStore(5);
  const b = second.load("postgres-snapshots.ts").createPostgresSnapshotStore(5);
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? a : b).save(report(index)),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    5,
  );
  assert.equal(
    (await pool.query("SELECT count(*) AS count FROM autopsy_snapshots"))
      .rows[0].count,
    "5",
  );
  for (const result of results.filter(
    (result) => result.status === "fulfilled",
  ))
    assert.ok((await a.get(result.value)).repository);
  assert.equal((await b.list("Sample/Project")).length, 5);
});
test("terminated database writers roll back snapshots and release locks", async () => {
  const writer = await pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT pg_advisory_xact_lock(71423002)");
  const { id, content, summary } = first
    .load("snapshot-data.ts")
    .snapshotData(report());
  await writer.query(
    "INSERT INTO autopsy_snapshots(id,repository,analyzed_at,content,summary) VALUES($1,$2,$3,$4,$5)",
    [
      id,
      "sample/project",
      report().analyzedAt,
      content,
      JSON.stringify(summary),
    ],
  );
  const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  writer.on("error", () => {});
  await pool.query("SELECT pg_terminate_backend($1)", [pid]);
  writer.release(true);
  const store = first
    .load("postgres-snapshots.ts")
    .createPostgresSnapshotStore();
  assert.equal(await store.get(id), undefined);
  assert.equal(await store.save(report()), id);
  assert.deepEqual(await store.get(id), report());
});
test("file snapshots hide interrupted writes and serialize concurrent capacity checks", async () => {
  const directory = path.resolve(".test-runtime", "snapshots-" + randomUUID());
  const { createSnapshotStore } = first.load("snapshot-store.ts");
  const failing = createSnapshotStore(directory, {
    beforePublish: async () => {
      throw Error("simulated interruption");
    },
  });
  await assert.rejects(failing.save(report()), /interruption/);
  assert.deepEqual(fs.readdirSync(directory), []);
  const a = createSnapshotStore(directory, { limit: 3 }),
    b = createSnapshotStore(directory, { limit: 3 });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) =>
      (index % 2 ? a : b).save(report(index)),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    3,
  );
  assert.equal(
    fs.readdirSync(directory).filter((file) => file.endsWith(".json")).length,
    3,
  );
});
test("readiness verifies configuration, schema failure and recovery", async () => {
  const { readiness } = first.load("readiness.ts");
  assert.equal((await readiness()).ready, true);
  await pool.query(
    "ALTER TABLE autopsy_schema RENAME TO autopsy_schema_unavailable",
  );
  assert.equal((await readiness()).ready, false);
  await pool.query(
    "ALTER TABLE autopsy_schema_unavailable RENAME TO autopsy_schema",
  );
  assert.equal((await readiness()).ready, true);
});
test("database backups can restore immutable reports with integrity verification", async () => {
  const store = first
    .load("postgres-snapshots.ts")
    .createPostgresSnapshotStore();
  const id = await store.save(report());
  // Logical row restore exercises the application's integrity contract. The
  // pg_dump/pg_restore container drill remains a separate deployment check.
  const rows = (await pool.query("SELECT * FROM autopsy_snapshots")).rows;
  await pool.query("TRUNCATE autopsy_snapshots");
  for (const row of rows)
    await pool.query(
      "INSERT INTO autopsy_snapshots(id,repository,analyzed_at,content,summary) VALUES($1,$2,$3,$4,$5)",
      [row.id, row.repository, row.analyzed_at, row.content, row.summary],
    );
  assert.deepEqual(await store.get(id), report());
});

test("database restart preserves snapshots and quotas and readiness recovers", async () => {
  const store = first
    .load("postgres-snapshots.ts")
    .createPostgresSnapshotStore();
  const id = await store.save(report());
  const consume = first.load("rate-limit.ts").consumeShared;
  assert.equal(
    await consume([{ key: "restart", limit: 1, windowMs: 60000 }]),
    0,
  );
  await embedded.stop();
  assert.equal((await first.load("readiness.ts").readiness()).ready, false);
  await assert.rejects(
    consume([{ key: "restart", limit: 1, windowMs: 60000 }]),
  );
  try {
    await embedded.start();
  } catch {
    throw new Error("Isolated database restart failed: " + databaseLog);
  }
  const deadline = Date.now() + 10000;
  let recovered = false;
  while (Date.now() < deadline) {
    if ((await first.load("readiness.ts").readiness()).ready) {
      recovered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(recovered, true);
  assert.deepEqual(await store.get(id), report());
  assert.ok(
    (await consume([{ key: "restart", limit: 1, windowMs: 60000 }])) > 0,
  );
});
