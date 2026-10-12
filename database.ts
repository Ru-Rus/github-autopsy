import { Pool, type PoolClient } from "pg";
import { event } from "./observability";

let pool: Pool | undefined;
export function database() {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error("Shared database is not configured."), { status: 503 });
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 3000, statement_timeout: 5000, idle_in_transaction_session_timeout: 10000 });
    // Never log connection strings, authentication errors or query parameters.
    pool.on("error", () => event("database_connection_failed"));
  }
  return pool;
}
export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL synchronous_commit = on");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
export async function closeDatabase() {
  const current = pool;
  pool = undefined;
  await current?.end();
}
