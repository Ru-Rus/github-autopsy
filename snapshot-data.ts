import { createHash } from "node:crypto";
import type { Report, SnapshotSummary } from "./types";
export const validSnapshotId = /^[a-f0-9]{64}$/;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function snapshotData(report: Report) {
  const { snapshotId: _id, history: _history, ...snapshot } = report;
  const content = JSON.stringify(snapshot);
  if (Buffer.byteLength(content) > 1_000_000)
    throw new Error("Report exceeds snapshot size limit.");
  const id = digest(content);
  const summary: SnapshotSummary = {
    id,
    repository: report.repository.full_name,
    analyzedAt: report.analyzedAt,
    revision: report.revision,
    score: report.scores.overall,
    sourceFiles: report.metrics?.sourceFiles ?? 0,
    testFiles: report.metrics?.testFiles ?? 0,
    contributors: report.metrics?.contributors ?? 0,
  };
  return { id, content, summary };
}
