const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});

async function cleanSnapshots(daysToKeep = 90, maxCount = 1000) {
  const client = await pool.connect();
  try {
    console.log(`Starting snapshot cleanup (retention: ${daysToKeep} days, max capacity: ${maxCount})...`);

    // 1. Delete snapshots older than daysToKeep
    const timeResult = await client.query(
      "DELETE FROM autopsy_snapshots WHERE analyzed_at < NOW() - make_interval(days => $1) RETURNING id",
      [daysToKeep],
    );
    console.log(`Pruned ${timeResult.rowCount} expired snapshot(s) older than ${daysToKeep} days.`);

    // 2. If count exceeds maxCount, prune oldest excess snapshots
    const countResult = await client.query("SELECT count(*) AS count FROM autopsy_snapshots");
    const currentCount = parseInt(countResult.rows[0].count, 10);

    if (currentCount > maxCount) {
      const excess = currentCount - maxCount;
      const excessResult = await client.query(
        `DELETE FROM autopsy_snapshots
         WHERE id IN (
           SELECT id FROM autopsy_snapshots
           ORDER BY analyzed_at ASC, id ASC
           LIMIT $1
         ) RETURNING id`,
        [excess],
      );
      console.log(`Pruned ${excessResult.rowCount} excess snapshot(s) to maintain capacity.`);
    }

    // 3. Clean up expired autopsy_limits rate limiting keys
    const limitsResult = await client.query(
      "DELETE FROM autopsy_limits WHERE reset_at < NOW() RETURNING key",
    );
    console.log(`Cleared ${limitsResult.rowCount} expired rate limit tracker(s).`);

    console.log("Database maintenance completed successfully.");
  } catch (error) {
    console.error("Database maintenance error:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  const days = parseInt(process.env.RETENTION_DAYS || "90", 10);
  const max = parseInt(process.env.MAX_SNAPSHOTS || "1000", 10);
  cleanSnapshots(days, max);
}

module.exports = { cleanSnapshots };
