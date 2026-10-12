// Loaded only by Playwright's isolated standalone server, never npm start.
if (process.env.AUTOPSY_BROWSER_FIXTURES !== "1")
  throw new Error("Browser fixtures require explicit test mode.");
const originalFetch = global.fetch;
const repo = {
  full_name: "fixture/repository",
  html_url: "https://github.com/fixture/repository",
  description: "A complete integration fixture",
  stargazers_count: 10,
  forks_count: 2,
  open_issues_count: 0,
  default_branch: "main",
  created_at: "2024-01-01T00:00:00Z",
  pushed_at: "2026-10-01T00:00:00Z",
  archived: false,
  license: null,
};
const commit = {
  sha: "abc123",
  commit: {
    message: "Improve validation",
    author: { date: "2026-10-01T00:00:00Z" },
  },
  author: { login: "alice" },
};
global.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "string" ? input : (input.url ?? String(input)),
  );
  if (url.hostname === "raw.githubusercontent.com")
    return new Response(
      url.pathname.endsWith("README.md")
        ? "# Installation\n## Usage\nArchitecture overview"
        : "export function validate(value: string) { if (!value) throw Error('missing'); return value; }",
    );
  if (url.hostname !== "api.github.com") return originalFetch(input, options);
  const endpoint = url.pathname.replace("/repos/fixture/repository", "");
  if (!endpoint) return Response.json(repo);
  if (endpoint === "/commits") return Response.json([commit]);
  if (endpoint === "/commits/abc123")
    return Response.json({
      ...commit,
      files: [{ filename: "src/index.ts" }],
      stats: { additions: 4, deletions: 1 },
    });
  if (endpoint.startsWith("/git/trees/"))
    return Response.json({
      tree: [
        { path: "src/index.ts", type: "blob", size: 100 },
        { path: "README.md", type: "blob", size: 100 },
      ],
      truncated: false,
    });
  if (endpoint === "/languages") return Response.json({ TypeScript: 100 });
  if (endpoint === "/contributors")
    return Response.json([{ login: "alice", contributions: 1 }]);
  if (endpoint === "/stats/code_frequency")
    return new Response(null, { status: 202 });
  return Response.json([]);
};
