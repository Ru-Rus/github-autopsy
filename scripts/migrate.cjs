const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
(async () => {
  try {
    await pool.query(
      fs.readFileSync(
        path.join(__dirname, "../migrations/001-production.sql"),
        "utf8",
      ),
    );
    console.log("Database schema version 1 installed.");
  } catch {
    console.error("Migration failed. Check database access and permissions.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
