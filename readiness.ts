import { database } from "./database";
export async function readiness() {
  const checks = {
    database: false,
    schema: false,
    durability: false,
    proxy: (process.env.TRUSTED_PROXY_SECRET?.length ?? 0) >= 32,
    monitoring: (process.env.MONITORING_TOKEN?.length ?? 0) >= 32,
    ai: !!process.env.OPENAI_API_KEY === !!process.env.OPENAI_MODEL,
  };
  try {
    const row = (
      await database().query(
        "SELECT EXISTS(SELECT 1 FROM autopsy_schema WHERE version=1) AS schema, current_setting('fsync') = 'on' AND current_setting('full_page_writes') = 'on' AS durability, (SELECT count(*) FROM autopsy_snapshots) AS snapshots, (SELECT count(*) FROM autopsy_limits) AS limits",
      )
    ).rows[0];
    checks.database = true;
    checks.schema = row.schema === true;
    checks.durability = row.durability === true;
  } catch {
    /* Dependency diagnostics must never expose credentials. */
  }
  return { ready: Object.values(checks).every(Boolean), checks };
}
