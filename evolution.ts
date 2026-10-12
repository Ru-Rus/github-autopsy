import type { Data } from "./github";
import type { EvolutionHistory } from "./types";

function monthOf(value: string | number): string | null {
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 7)
    : null;
}
export function buildEvolution(
  data: Pick<
    Data,
    "codeFrequency" | "details" | "issueHistory" | "issueHistoryTruncated"
  > & { commits?: Data["commits"] },
  now = new Date(),
): EvolutionHistory {
  const months = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1))
      .toISOString()
      .slice(0, 7),
  );
  const monthSet = new Set(months);
  const buckets = new Map(
    months.map((month) => [
      month,
      { additions: 0, deletions: 0, opened: 0, closed: 0 },
    ]),
  );

  const issues = data.issueHistory ?? [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const createdMonth = monthOf(issue.created_at);
    if (createdMonth && monthSet.has(createdMonth)) {
      const bucket = buckets.get(createdMonth);
      if (bucket) bucket.opened++;
    }
    const closedMonth = issue.closed_at ? monthOf(issue.closed_at) : null;
    if (closedMonth && monthSet.has(closedMonth)) {
      const bucket = buckets.get(closedMonth);
      if (bucket) bucket.closed++;
    }
  }

  const weekly = data.codeFrequency ?? null;
  let codeSource: EvolutionHistory["codeSource"] = "unavailable";
  if (weekly?.length) {
    codeSource = "weekly-stats";
    for (const row of weekly) {
      if (
        row.length < 3 ||
        !Number.isFinite(row[0]) ||
        !Number.isFinite(row[1]) ||
        !Number.isFinite(row[2])
      )
        continue;
      const month = monthOf(row[0]);
      const bucket = month ? buckets.get(month) : null;
      if (!bucket) continue;
      bucket.additions += Math.max(0, Math.round(row[1]));
      bucket.deletions += Math.abs(Math.round(row[2]));
    }
  } else {
    const details = data.details ?? [];
    for (const commit of details) {
      const date = commit.commit.author?.date;
      const month = date ? monthOf(date) : null;
      const bucket = month ? buckets.get(month) : null;
      if (!bucket || !commit.stats) continue;
      const additions = commit.stats.additions ?? 0;
      const deletions = commit.stats.deletions ?? 0;
      if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue;
      bucket.additions += Math.max(0, additions);
      bucket.deletions += Math.max(0, deletions);
      codeSource = "sampled-commits";
    }
  }

  let cumulativeNet = 0;
  const contributors = months.map(month => {
    const people = new Set<string>();
    for (const commit of data.commits ?? []) {
      if (commit.author?.login && monthOf(commit.commit.author?.date ?? "") === month) people.add(commit.author.login);
    }
    return { month, contributors: people.size };
  });
  const code = months.map((month) => {
    const bucket = buckets.get(month)!;
    const net = bucket.additions - bucket.deletions;
    cumulativeNet += net;
    return { month, ...bucket, net, cumulativeNet };
  });
  return {
    contributors,
    issues: months.map((month) => {
      const bucket = buckets.get(month)!;
      return { month, opened: bucket.opened, closed: bucket.closed };
    }),
    code,
    codeSource,
    issueSample: issues.filter((issue) => !issue.pull_request).length,
    issueItemsSample: issues.length,
    issuesTruncated: data.issueHistoryTruncated ?? false,
  };
}
