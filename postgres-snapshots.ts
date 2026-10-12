import { database, transaction } from "./database";
import { digest, snapshotData, validSnapshotId } from "./snapshot-data";
import type { Report, SnapshotSummary } from "./types";

export function createPostgresSnapshotStore(limit = 1000) {
  return {
    async save(report: Report) {
      const { id, content, summary } = snapshotData(report);
      return transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(71423002)");
        const exists = await client.query(
          "SELECT id FROM autopsy_snapshots WHERE id=$1",
          [id],
        );
        if (exists.rowCount) return id;
        const count = Number(
          (
            await client.query(
              "SELECT count(*) AS count FROM autopsy_snapshots",
            )
          ).rows[0].count,
        );
        if (count >= limit) throw new Error("Snapshot storage is full.");
        // Report and history summary become visible together at COMMIT. A killed
        // connection rolls back both and releases the transaction-scoped lock.
        await client.query(
          "INSERT INTO autopsy_snapshots(id,repository,analyzed_at,content,summary) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            report.repository.full_name.toLowerCase(),
            report.analyzedAt,
            content,
            JSON.stringify(summary),
          ],
        );
        return id;
      });
    },
    async get(id: string): Promise<Report | undefined> {
      if (!validSnapshotId.test(id)) return;
      const row = (
        await database().query(
          "SELECT content FROM autopsy_snapshots WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!row) return;
      if (digest(row.content) !== id)
        throw new Error("Snapshot integrity verification failed.");
      return JSON.parse(row.content) as Report;
    },
    async list(repository: string): Promise<SnapshotSummary[]> {
      const rows = (
        await database().query(
          "SELECT summary FROM autopsy_snapshots WHERE repository=$1 ORDER BY analyzed_at DESC,id DESC LIMIT 50",
          [repository.toLowerCase()],
        )
      ).rows;
      return rows.map((row) => row.summary as SnapshotSummary).reverse();
    },
  };
}
