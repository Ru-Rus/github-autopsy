import {
  mkdir,
  open,
  readFile,
  readdir,
  link,
  unlink,
  rmdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { digest, snapshotData, validSnapshotId } from "./snapshot-data";
import { createPostgresSnapshotStore } from "./postgres-snapshots";
import type { Report, SnapshotSummary } from "./types";

/** Development-only file adapter. Production uses PostgreSQL transactions. */
export function createSnapshotStore(
  directory: string | undefined,
  options: { limit?: number; beforePublish?: () => Promise<void> } = {},
) {
  return {
    async save(report: Report): Promise<string | undefined> {
      if (!directory) return;
      const { id, content } = snapshotData(report);
      await mkdir(directory, { recursive: true });
      const lock = path.join(directory, ".write-lock");
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          await mkdir(lock);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (Date.now() >= deadline)
            throw new Error(
              "Snapshot writer is locked; offline recovery may be required.",
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const temporary = path.join(directory, ".pending-" + randomUUID());
      try {
        const files = (await readdir(directory)).filter((file) =>
          /^[a-f0-9]{64}\.json$/.test(file),
        );
        if (files.includes(id + ".json")) {
          const existing = await readFile(
            path.join(directory, id + ".json"),
            "utf8",
          );
          if (digest(existing) !== id)
            throw new Error("Existing snapshot is corrupt.");
          return id;
        }
        if (files.length >= (options.limit ?? 1000))
          throw new Error("Snapshot storage is full.");
        const handle = await open(temporary, "wx");
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await options.beforePublish?.();
        // Same-filesystem hard-link publication is atomic and cannot replace an
        // existing snapshot. Partial temporary files are never readable by ID.
        await link(temporary, path.join(directory, id + ".json"));
        // Sync directory entries where supported (Windows does not expose it).
        if (process.platform !== "win32") {
          const handle = await open(directory, "r");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        return id;
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rmdir(lock);
      }
    },
    async get(id: string): Promise<Report | undefined> {
      if (!directory || !validSnapshotId.test(id)) return;
      try {
        const content = await readFile(
          path.join(directory, id + ".json"),
          "utf8",
        );
        if (Buffer.byteLength(content) > 1_000_000 || digest(content) !== id)
          return;
        return JSON.parse(content) as Report;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    },
    async list(repository: string): Promise<SnapshotSummary[]> {
      if (!directory) return [];
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const summaries: SnapshotSummary[] = [];
      for (const file of files.filter((file) =>
        /^[a-f0-9]{64}\.json$/.test(file),
      )) {
        const report = await this.get(file.slice(0, 64));
        if (
          report?.repository.full_name.toLowerCase() ===
          repository.toLowerCase()
        )
          summaries.push(snapshotData(report).summary);
      }
      return summaries
        .sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt))
        .slice(0, 50)
        .reverse();
    },
  };
}
const fileStore = createSnapshotStore(process.env.REPORT_STORAGE_DIR);
const postgresStore = createPostgresSnapshotStore();
function configuredStore() {
  if (process.env.DATABASE_URL) return postgresStore;
  if (process.env.NODE_ENV === "production")
    throw new Error("Production snapshot storage requires DATABASE_URL.");
  return fileStore;
}
export const snapshotStore = {
  save: (report: Report) => configuredStore().save(report),
  get: (id: string) => configuredStore().get(id),
  list: (repository: string) => configuredStore().list(repository),
};
