import type { Repo } from "./types";
const API = "https://api.github.com";
function request(path: string, signal?: AbortSignal): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  return fetch(API + path, {
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(8000), signal])
      : AbortSignal.timeout(8000),
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-autopsy",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
  });
}
async function assertResponse(r: Response) {
  if (r.ok) return;
  const body = (await r
    .clone()
    .json()
    .catch(() => ({}))) as { message?: string };
  const rateLimited =
    r.status === 429 ||
    (r.status === 403 &&
      (r.headers.get("x-ratelimit-remaining") === "0" ||
        r.headers.has("retry-after") ||
        /rate limit|abuse detection/i.test(body.message ?? "")));
  if (rateLimited) {
    const seconds = Number(r.headers.get("retry-after"));
    const reset = Number(r.headers.get("x-ratelimit-reset"));
    const retryAfter =
      seconds > 0
        ? Math.ceil(seconds)
        : reset > 0
          ? Math.max(1, Math.ceil(reset - Date.now() / 1000))
          : 60;
    throw Object.assign(
      new Error("GitHub rate limit reached. Please retry later."),
      { status: 429, code: "GITHUB_RATE_LIMIT", retryAfter },
    );
  }
  if (r.status === 404)
    throw Object.assign(
      new Error("Repository not found, private, or unavailable."),
      { status: 404, code: "GITHUB_NOT_FOUND" },
    );
  if (r.status === 403)
    throw Object.assign(new Error("GitHub denied access to this resource."), {
      status: 403,
      code: "GITHUB_PERMISSION",
    });
  if (r.status === 401)
    throw Object.assign(
      new Error("GitHub rejected the server token. Contact the operator."),
      { status: 502, code: "GITHUB_AUTH" },
    );
  throw Object.assign(
    new Error("GitHub returned " + r.status + ". Please retry."),
    {
      status: 502,
      code: "GITHUB_UPSTREAM",
    },
  );
}
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await request(path, signal);
  await assertResponse(r);
  return r.json() as Promise<T>;
}
async function getOptional<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T | null> {
  const r = await request(path, signal);
  if ([202, 204, 404, 422].includes(r.status)) return null;
  // Statistics endpoints reject some large repositories even with remaining quota.
  if (r.status === 403) {
    try {
      await assertResponse(r);
    } catch (error) {
      if ((error as { code?: string }).code === "GITHUB_PERMISSION")
        return null;
      throw error;
    }
  }
  await assertResponse(r);
  return r.json() as Promise<T>;
}
async function pages<T>(
  path: string,
  count = 1,
  signal?: AbortSignal,
): Promise<T[]> {
  const pageUrl = (page: number) =>
    path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page;
  const response = await request(pageUrl(1), signal);
  if (response.status === 409 && /\/commits(?:\?|$)/.test(path)) return [];
  await assertResponse(response);
  const first = (await response.json()) as T[];
  const out = [...first];
  if (first.length < 100 || count <= 1) return out;

  const second = await get<T[]>(pageUrl(2), signal);
  out.push(...second);
  if (second.length < 100 || count <= 2) return out;

  const remaining = await Promise.all(
    Array.from({ length: count - 2 }, (_, index) =>
      get<T[]>(pageUrl(index + 3), signal),
    ),
  );
  for (const rows of remaining) {
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
export interface Entry {
  path: string;
  type: string;
  size?: number;
}
export interface Commit {
  sha: string;
  commit: { message: string; author?: { date?: string } | null };
  author: { login: string } | null;
}
export interface Detail extends Commit {
  files?: { filename: string }[];
  stats?: { additions?: number; deletions?: number; total?: number };
}
export type CodeFrequencyRow = [number, number, number];
export interface Issue {
  created_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
}
export interface Pull {
  state: string;
  merged_at: string | null;
}
export interface Data {
  issuesDisabled?: boolean;
  revision?: string;
  warnings?: string[];
  repository: Repo;
  tree: Entry[];
  truncated: boolean;
  languages: Record<string, number>;
  commits: Commit[];
  details: Detail[];
  issues: Issue[];
  issueHistory: Issue[];
  issueHistoryTruncated: boolean;
  codeFrequency: CodeFrequencyRow[] | null;
  pulls: Pull[];
  contributors: { login?: string; contributions: number }[];
}
export async function collect(
  owner: string,
  name: string,
  signal?: AbortSignal,
): Promise<Data> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const repository = await get<Repo>(base, signal);
  if ((repository as Repo & { private?: boolean }).private)
    throw Object.assign(
      new Error("Only public repositories can be analyzed."),
      { status: 403 },
    );
  const warnings: string[] = [];
  const issuesDisabled = repository.has_issues === false;
  const commits = repository.default_branch
    ? await pages<Commit>(base + "/commits", 2, signal)
    : [];
  if (!repository.default_branch || !commits.length)
    return {
      issuesDisabled,
      repository,
      tree: [],
      truncated: false,
      languages: {},
      commits: [],
      details: [],
      issues: [],
      issueHistory: [],
      issueHistoryTruncated: false,
      codeFrequency: null,
      pulls: [],
      contributors: [],
    };
  const sinceDate = new Date();
  sinceDate.setUTCDate(1);
  sinceDate.setUTCHours(0, 0, 0, 0);
  sinceDate.setUTCMonth(sinceDate.getUTCMonth() - 11);
  const since = encodeURIComponent(sinceDate.toISOString());
  const [
    languages,
    t,
    contributors,
    issues,
    pulls,
    issueHistory,
    codeFrequency,
  ] = await Promise.all([
    get<Record<string, number>>(base + "/languages", signal),
    get<{ tree: Entry[]; truncated: boolean }>(
      base +
        "/git/trees/" +
        encodeURIComponent(commits[0].sha) +
        "?recursive=1",
      signal,
    ),
    pages<Data["contributors"][number]>(
      base + "/contributors",
      1,
      signal,
    ).catch((error) => {
      if (signal?.aborted || error?.status === 429) throw error;
      warnings.push(
        "Contributor data could not be fetched; contributor counts are incomplete.",
      );
      return [];
    }),
    issuesDisabled
      ? Promise.resolve([] as Issue[])
      : pages<Issue>(
          base + "/issues?state=open&sort=created&direction=asc",
          1,
          signal,
        ),
    pages<Pull>(
      base + "/pulls?state=all&sort=updated&direction=desc",
      1,
      signal,
    ),
    issuesDisabled
      ? Promise.resolve([] as Issue[])
      : pages<Issue>(
          base +
            "/issues?state=all&since=" +
            since +
            "&sort=updated&direction=desc",
          4,
          signal,
        ),
    getOptional<CodeFrequencyRow[]>(base + "/stats/code_frequency", signal),
  ]);
  const details: Detail[] = await Promise.all(
    commits.slice(0, 12).map((c) =>
      get<Detail>(`${base}/commits/${encodeURIComponent(c.sha)}`, signal).catch(
        (e) => {
          if (signal?.aborted || e?.status === 429) throw e;
          warnings.push(
            `File and line statistics were unavailable for commit ${c.sha.slice(0, 12)}.`,
          );
          return c as Detail;
        },
      ),
    ),
  );
  return {
    issuesDisabled,
    revision: commits[0]?.sha,
    warnings,
    repository,
    tree: t.tree ?? [],
    truncated: t.truncated,
    languages,
    commits,
    details,
    issues,
    issueHistory,
    issueHistoryTruncated: issueHistory.length >= 400,
    codeFrequency,
    pulls,
    contributors,
  };
}
export async function raw(
  owner: string,
  name: string,
  branch: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url =
    "https://raw.githubusercontent.com/" +
    [owner, name, branch, ...path.split("/")].map(encodeURIComponent).join("/");
  try {
    const r = await fetch(url, {
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(6000), signal])
        : AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    if (Number(r.headers.get("content-length")) > 150000) {
      await r.body?.cancel();
      return null;
    }
    if (!r.body) return "";
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 150000) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}
