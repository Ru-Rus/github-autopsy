import { NextResponse } from "next/server";
import { collect } from "@/github";
import { analyze } from "@/analyze";
import { reportCache } from "@/report-cache";
import { snapshotStore } from "@/snapshot-store";
import { generateReview } from "@/ai-review";
import { readJSON } from "@/bounded-json";
import { limiter } from "@/rate-limit";
import { event, repositoryTag } from "@/observability";
import { randomUUID } from "node:crypto";
class InputError extends Error {}
function parse(value: unknown) {
  if (typeof value !== "string" || value.length > 500)
    throw new InputError("Enter a GitHub URL or owner/repository.");
  let parts: string[];
  if (/^https?:\/\//i.test(value.trim())) {
    let u: URL;
    try {
      u = new URL(value.trim());
    } catch {
      throw new InputError("That URL is not valid.");
    }
    if (
      u.protocol !== "https:" ||
      u.hostname.toLowerCase() !== "github.com" ||
      u.username ||
      u.password ||
      u.port
    )
      throw new InputError("Use a public https://github.com repository URL.");
    parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 2) parts[1] = parts[1].replace(/\.git$/i, "");
  } else parts = value.trim().split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (x) => !/^[A-Za-z0-9._-]{1,100}$/.test(x) || x === "." || x === "..",
    )
  )
    throw new InputError(
      "Enter a URL like https://github.com/owner/repository.",
    );
  return parts;
}
export const maxDuration = 60;
function throttled(retry: number) {
  event("request_throttled", { retrySeconds: retry });
  return NextResponse.json(
    { error: "Request or provider budget exhausted. Please retry later." },
    { status: 429, headers: { "Retry-After": String(retry) } },
  );
}
export async function POST(req: Request) {
  const requestId = randomUUID(),
    started = Date.now();
  try {
    const retry = await limiter.request(req, "analysis");
    if (retry) return throttled(retry);
    const body = await readJSON(req);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new InputError("Request body must be a JSON object.");
    const [owner, name] = parse((body as { repository?: unknown }).repository);
    const key = `${owner}/${name}`.toLowerCase();
    const cached = reportCache.get(key);
    if (cached) {
      event("analysis_cached", { requestId, repository: repositoryTag(key) });
      return NextResponse.json(cached);
    }
    const quota = await limiter.analysis();
    if (quota) return throttled(quota);
    event("analysis_started", { requestId, repository: repositoryTag(key) });
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(55_000)]);
    const data = await collect(owner, name, signal);
    const report = await analyze(data, owner, name, signal);
    try {
      if (
        process.env.OPENAI_API_KEY &&
        process.env.OPENAI_MODEL &&
        report.findings.length
      ) {
        const quota = await limiter.ai();
        if (quota) throw new Error("AI provider budget exhausted.");
      }
      report.aiReview = await generateReview(report, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      report.caveats.push(
        "AI review is unavailable; deterministic scores and findings remain available.",
      );
      event("ai_review_unavailable", { requestId });
    }
    try {
      report.snapshotId = await snapshotStore.save(report);
      if (report.snapshotId)
        report.history = await snapshotStore.list(report.repository.full_name);
      if (!report.snapshotId)
        report.caveats.push(
          "Persistent storage is not configured; share links rerun analysis and may reuse a report cached for up to one minute.",
        );
    } catch {
      report.caveats.push(
        "Persistent snapshot storage is unavailable; this report can still be exported and shared as a fresh analysis.",
      );
      event("snapshot_save_failed", { requestId });
    }
    reportCache.set(key, report);
    event("analysis_completed", {
      requestId,
      durationMs: Date.now() - started,
      snapshotSaved: !!report.snapshotId,
    });
    return NextResponse.json(report);
  } catch (e) {
    const known = (e as { status?: number })?.status,
      timeout = e instanceof Error && e.name === "TimeoutError",
      status =
        known ??
        (e instanceof InputError || e instanceof SyntaxError
          ? 400
          : timeout
            ? 504
            : 503),
      message = timeout
        ? "GitHub request timed out. Please retry."
        : e instanceof Error &&
            (known || e instanceof InputError || e instanceof SyntaxError)
          ? e.message
          : "Analysis dependency unavailable. Please retry.";
    event("analysis_failed", {
      requestId,
      status,
      durationMs: Date.now() - started,
    });
    const retryAfter = (e as { retryAfter?: number })?.retryAfter;
    return NextResponse.json(
      { error: message },
      {
        status,
        headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
      },
    );
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("snapshot");
  if (!id || !/^[a-f0-9]{64}$/.test(id))
    return NextResponse.json(
      { error: "Invalid snapshot ID." },
      { status: 400 },
    );
  try {
    const retry = await limiter.request(req, "snapshot");
    if (retry) return throttled(retry);
    const report = await snapshotStore.get(id);
    if (!report)
      return NextResponse.json(
        { error: "Snapshot not found." },
        { status: 404 },
      );
    return NextResponse.json({
      ...report,
      snapshotId: id,
      history: await snapshotStore.list(report.repository.full_name),
    });
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 503;
    event("snapshot_read_failed", { status });
    return NextResponse.json(
      { error: "Snapshot access is unavailable. Please retry." },
      { status },
    );
  }
}
