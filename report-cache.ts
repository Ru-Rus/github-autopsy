import type { Report } from "./types";

/** Short-lived, bounded cache. Issue metadata can change without a new commit. */
export function createReportCache(limit = 50, ttl = 60_000) {
  const entries = new Map<string, { report: Report; expires: number }>();
  return {
    get(key: string, now = Date.now()): Report | undefined {
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.expires <= now) { entries.delete(key); return; }
      return entry.report;
    },
    set(key: string, report: Report, now = Date.now()) {
      entries.delete(key);
      for (const [id, entry] of entries) if (entry.expires <= now) entries.delete(id);
      while (entries.size >= limit && entries.size) entries.delete(entries.keys().next().value!);
      if (limit > 0) entries.set(key, { report, expires: now + ttl });
    },
  };
}
export const reportCache = createReportCache();
