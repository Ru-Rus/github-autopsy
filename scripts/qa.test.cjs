const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire, Module } = require("node:module");

const root = path.resolve(__dirname, "..");
const fromRoot = createRequire(path.join(root, "package.json"));
const ts = fromRoot("typescript");

function loadTypeScript(file, mocks = {}) {
  const source = fs.readFileSync(file, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(
    errors.length,
    0,
    errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("\n"),
  );

  const loaded = new Module(file, module);
  loaded.filename = file;
  const localRequire = (specifier) =>
    Object.hasOwn(mocks, specifier)
      ? mocks[specifier]
      : specifier.startsWith(".") &&
          fs.existsSync(path.resolve(path.dirname(file), specifier + ".ts"))
        ? loadTypeScript(
            path.resolve(path.dirname(file), specifier + ".ts"),
            mocks,
          )
        : createRequire(file)(specifier);
  loaded.require = localRequire;
  loaded._compile(result.outputText, file);
  return loaded.exports;
}

function makeData(paths = [], overrides = {}) {
  return {
    repository: {
      full_name: "sample/project",
      html_url: "https://github.com/sample/project",
      description: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      default_branch: "main",
      created_at: "2024-01-01T00:00:00Z",
      pushed_at: null,
      archived: false,
      license: null,
      ...overrides.repository,
    },
    tree: paths.map((file) => ({ path: file, type: "blob", size: 20 })),
    truncated: false,
    languages: {},
    commits: [],
    details: [],
    issues: [],
    pulls: [],
    contributors: [],
    ...overrides,
  };
}

function loadAnalyzer(raw = async () => null) {
  const scoring = loadTypeScript(path.join(root, "scoring.ts"));
  return loadTypeScript(path.join(root, "analyze.ts"), {
    "./github": { raw },
    "./scoring": scoring,
  });
}

function makeRoute(overrides = {}) {
  const calls = {};
  const handlers = {
    collect: async (...args) => {
      calls.collect = args;
      return { fixture: true };
    },
    analyze: async (...args) => {
      calls.analyze = args;
      return { ok: true, caveats: [] };
    },
    save: async () => undefined,
    get: async () => undefined,
    list: async () => [],
    generateReview: async () => undefined,
    ...overrides,
  };
  const counts = new Map();
  const route = loadTypeScript(
    path.join(root, "app", "api", "analyze", "route.ts"),
    {
      "next/server": fromRoot("next/server"),
      "@/github": { collect: (...args) => handlers.collect(...args) },
      "@/analyze": { analyze: (...args) => handlers.analyze(...args) },
      "@/report-cache": {
        reportCache: loadTypeScript(
          path.join(root, "report-cache.ts"),
        ).createReportCache(),
      },
      "@/snapshot-store": {
        snapshotStore: {
          save: (...args) => handlers.save(...args),
          get: (...args) => handlers.get(...args),
          list: (...args) => handlers.list(...args),
        },
      },
      "@/ai-review": {
        generateReview: (...args) => handlers.generateReview(...args),
      },
      "@/bounded-json": loadTypeScript(path.join(root, "bounded-json.ts")),
      "@/observability": { event: () => {}, repositoryTag: (value) => value },
      "@/rate-limit": {
        limiter: {
          request: async (req) => {
            const client = req.headers.get("x-real-ip") ?? "test";
            const count = (counts.get(client) ?? 0) + 1;
            counts.set(client, count);
            return count > 5 ? 60 : 0;
          },
          analysis: async () => 0,
          ai: async () => 0,
        },
      },
    },
  );
  return { route, calls };
}

function request(body, ip, raw = false) {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: raw ? body : JSON.stringify(body),
  });
}

async function post(route, body, ip, raw = false) {
  const req = request(body, ip, raw);
  return { req, response: await route.POST(req) };
}

test("empty repository has no numeric scores or findings", async () => {
  const analyzer = loadAnalyzer();
  const report = await analyzer.analyze(
    makeData([], {
      repository: { default_branch: null },
    }),
    "sample",
    "project",
  );

  assert.ok(Object.values(report.scores).every((score) => score === null));
  assert.ok(report.categories.every((category) => category.score === null));
  assert.deepEqual(report.findings, []);
});

test("runner and coverage signals do not confuse manifests or Jest config", async () => {
  const analyzer = loadAnalyzer();
  const manifestReport = await analyzer.analyze(
    makeData(["go.mod", "pom.xml", "src/main.go"]),
    "sample",
    "project",
  );
  const manifestEvidence = manifestReport.categories.find(
    (c) => c.key === "testing",
  ).evidence;
  assert.ok(
    manifestEvidence.includes("No common test runner config detected."),
  );
  assert.ok(manifestEvidence.includes("No common coverage config detected."));

  const jestReport = await analyzer.analyze(
    makeData(["src/index.ts", "jest.config.js"]),
    "sample",
    "project",
  );
  const jestEvidence = jestReport.categories.find(
    (c) => c.key === "testing",
  ).evidence;
  assert.ok(jestEvidence.includes("Test runner config detected."));
  assert.ok(jestEvidence.includes("No common coverage config detected."));
});

test("Go test files count as tests and a coverage config is detected", async () => {
  const analyzer = loadAnalyzer();
  const report = await analyzer.analyze(
    makeData(["main.go", "main_test.go", "c8.config.js"]),
    "sample",
    "project",
  );
  const evidence = report.categories.find((c) => c.key === "testing").evidence;
  assert.equal(report.metrics.testFiles, 1);
  assert.ok(evidence.includes("Test runner config detected."));
  assert.ok(evidence.includes("Coverage config detected."));
});

test("API accepts a valid repository and passes its request signal downstream", async () => {
  const { route, calls } = makeRoute();
  const req = request(
    { repository: "https://github.com/sample/project.git" },
    "qa-valid",
  );
  const response = await route.POST(req);

  assert.equal(response.status, 200);
  assert.deepEqual(calls.collect.slice(0, 2), ["sample", "project"]);
  assert.ok(calls.collect[2] instanceof AbortSignal);
  assert.equal(calls.analyze[3], calls.collect[2]);
  assert.equal((await response.json()).ok, true);
});

test("API rejects invalid JSON bodies and repository inputs with 400", async () => {
  const { route } = makeRoute();
  const cases = [
    [null, "qa-null"],
    [[], "qa-array"],
    [{}, "qa-missing-repository"],
    [{ repository: "not-a-repository" }, "qa-invalid-repository"],
    [{ repository: "http://github.com/sample/project" }, "qa-http-url"],
  ];

  for (const [body, ip] of cases) {
    const { response } = await post(route, body, ip);
    assert.equal(response.status, 400, `expected 400 for ${ip}`);
  }

  const malformed = await post(route, "{", "qa-malformed-json", true);
  assert.equal(malformed.response.status, 400);
});

test("API maps upstream not-found, rate-limit, timeout, and network errors", async () => {
  const cases = [
    ["not found", Object.assign(new Error("not found"), { status: 404 }), 404],
    [
      "rate limited",
      Object.assign(new Error("rate limited"), { status: 429 }),
      429,
    ],
    [
      "timeout",
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      504,
    ],
    ["network failure", new TypeError("network failure"), 503],
  ];

  for (const [label, error, expected] of cases) {
    const { route } = makeRoute({
      collect: async () => {
        throw error;
      },
    });
    const { response } = await post(
      route,
      { repository: "sample/project" },
      `qa-${label.replaceAll(" ", "-")}`,
    );
    assert.equal(response.status, expected, label);
  }
});

test("sixth request from the same client key receives 429", async () => {
  const { route } = makeRoute();
  for (let i = 1; i <= 5; i++) {
    const { response } = await post(route, {}, "qa-rate-limit");
    assert.equal(
      response.status,
      400,
      `request ${i} should reach input validation`,
    );
  }

  const { response } = await post(
    route,
    { repository: "sample/project" },
    "qa-rate-limit",
  );
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});

test("GitHub collector aborts its in-flight request when the caller signal aborts", async (t) => {
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
  });
  let fetchSignal;
  global.fetch = (_url, options) => {
    fetchSignal = options.signal;
    return new Promise((_resolve, reject) => {
      fetchSignal.addEventListener("abort", () => reject(fetchSignal.reason), {
        once: true,
      });
    });
  };

  const github = loadTypeScript(path.join(root, "github.ts"));
  const controller = new AbortController();
  const pending = github.collect("sample", "project", controller.signal);
  assert.ok(fetchSignal);
  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(fetchSignal.aborted, true);
});

test("raw-file fetch aborts with the caller signal instead of hiding cancellation", async (t) => {
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
  });
  let fetchSignal;
  global.fetch = (_url, options) => {
    fetchSignal = options.signal;
    return new Promise((_resolve, reject) => {
      fetchSignal.addEventListener("abort", () => reject(fetchSignal.reason), {
        once: true,
      });
    });
  };

  const github = loadTypeScript(path.join(root, "github.ts"));
  const controller = new AbortController();
  const pending = github.raw(
    "sample",
    "project",
    "main",
    "src/index.ts",
    controller.signal,
  );
  assert.ok(fetchSignal);
  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(fetchSignal.aborted, true);
});

test("analysis passes the caller signal into source-file reads", async () => {
  let receivedSignal;
  const analyzer = loadAnalyzer((_owner, _name, _branch, _file, signal) => {
    receivedSignal = signal;
    return Promise.resolve(null);
  });
  const controller = new AbortController();

  await analyzer.analyze(
    makeData(["src/index.ts"]),
    "sample",
    "project",
    controller.signal,
  );
  assert.equal(receivedSignal, controller.signal);
});

test("health labels respect every configured boundary", () => {
  const { healthLabel } = loadTypeScript(path.join(root, "scoring.ts"));
  for (const [score, label] of [
    [0, "Critical"],
    [39, "Critical"],
    [40, "Risky"],
    [59, "Risky"],
    [60, "Needs attention"],
    [74, "Needs attention"],
    [75, "Healthy"],
    [89, "Healthy"],
    [90, "Excellent"],
    [100, "Excellent"],
  ])
    assert.equal(healthLabel(score), label);
});

test("syntax analysis ignores keywords in strings and comments", () => {
  const { analyzeSyntax } = loadTypeScript(
    path.join(root, "static-analysis.ts"),
  );
  assert.deepEqual(
    analyzeSyntax([
      {
        path: "src/a.ts",
        text: '// function fake() {}\nexport class A { run() { if (true) return 1; } }\nconst f = () => "class Fake";',
      },
    ]),
    { functions: 2, classes: 1, branches: 1, imports: 0, exports: 1 },
  );
});

test("module map parses JSONC aliases and ignores fictional commented imports", () => {
  const { buildModuleMap } = loadTypeScript(path.join(root, "module-map.ts"));
  const result = buildModuleMap(
    [
      {
        path: "src/ui/a.ts",
        text: '// import fake from "../../lib/b";\nimport b from "@/lib/b";',
      },
    ],
    ["src/ui/a.ts", "lib/b.ts"],
    '{"compilerOptions":{"paths":{"@/*":["./*"],},},}',
    "tsconfig.json",
  );
  assert.deepEqual(result.edges, [{ from: "src/ui", to: "lib", imports: 1 }]);
  const empty = buildModuleMap(
    [
      {
        path: "src/ui/a.ts",
        text: 'const s = "import fake from ../../lib/b"; // from "../../lib/b"',
      },
    ],
    ["src/ui/a.ts", "lib/b.ts"],
    null,
    "tsconfig.json",
  );
  assert.deepEqual(empty.edges, []);
});

test("evolution uses UTC months, excludes PRs and deduplicates contributors", () => {
  const { buildEvolution } = loadTypeScript(path.join(root, "evolution.ts"));
  const result = buildEvolution(
    {
      codeFrequency: null,
      details: [
        {
          commit: { author: { date: "2026-10-01T00:00:00Z" } },
          stats: { additions: 10, deletions: 3 },
        },
      ],
      issueHistory: [
        {
          created_at: "2026-10-01T00:00:00Z",
          closed_at: "2026-10-02T00:00:00Z",
        },
        { created_at: "2026-10-01", pull_request: {} },
      ],
      commits: [
        {
          author: { login: "alice" },
          commit: { author: { date: "2026-10-01" } },
        },
        {
          author: { login: "alice" },
          commit: { author: { date: "2026-10-02" } },
        },
      ],
      issueHistoryTruncated: true,
    },
    new Date("2026-10-12T00:00:00Z"),
  );
  assert.equal(result.code.length, 12);
  assert.equal(result.codeSource, "sampled-commits");
  assert.equal(result.code.at(-1).cumulativeNet, 7);
  assert.deepEqual(result.issues.at(-1), {
    month: "2026-10",
    opened: 1,
    closed: 1,
  });
  assert.equal(result.contributors.at(-1).contributors, 1);
  assert.equal(result.issueSample, 1);
});

test("report cache expires and evicts oldest entries", () => {
  const { createReportCache } = loadTypeScript(
    path.join(root, "report-cache.ts"),
  );
  const cache = createReportCache(2, 10);
  cache.set("a", { id: 1 }, 0);
  cache.set("b", { id: 2 }, 0);
  cache.set("c", { id: 3 }, 1);
  assert.equal(cache.get("a", 1), undefined);
  assert.equal(cache.get("b", 9).id, 2);
  assert.equal(cache.get("b", 10), undefined);
});

test("API reuses a cached public report for case-insensitive repository names", async () => {
  let count = 0;
  const { route } = makeRoute({
    collect: async () => {
      count++;
      return {};
    },
  });
  assert.equal(
    (await post(route, { repository: "sample/project" }, "cache-a")).response
      .status,
    200,
  );
  assert.equal(
    (await post(route, { repository: "Sample/Project" }, "cache-b")).response
      .status,
    200,
  );
  assert.equal(count, 1);
});

test("collector recognizes empty repositories even when GitHub supplies a default branch", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  let count = 0;
  global.fetch = async (input) => {
    count++;
    return String(input).includes("/commits")
      ? new Response(null, { status: 409 })
      : Response.json({ ...makeData().repository, size: 0 });
  };
  const { collect } = loadTypeScript(path.join(root, "github.ts"));
  const data = await collect("sample", "project");
  assert.equal(count, 2);
  assert.deepEqual(data.commits, []);
});

test("raw reader rejects oversized streamed files without reading the whole body", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  let cancelled = false;
  global.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(150001));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const { raw } = loadTypeScript(path.join(root, "github.ts"));
  assert.equal(await raw("sample", "project", "main", "a.ts"), null);
  assert.equal(cancelled, true);
});

test("overall score follows documented weights and findings include actionable evidence", async () => {
  const { analyze } = loadAnalyzer(async (_o, _n, _b, file) =>
    file === "README.md"
      ? "# Installation\n## Usage\nArchitecture"
      : "export const a=1;",
  );
  const report = await analyze(
    makeData(["README.md", "src/a.ts", "LICENSE", "package.json"]),
    "sample",
    "project",
  );
  const { scoring } = loadTypeScript(path.join(root, "scoring.ts"));
  assert.equal(
    report.scores.overall,
    Math.round(
      Object.entries(scoring.weights).reduce(
        (sum, [key, weight]) => sum + report.scores[key] * weight,
        0,
      ),
    ),
  );
  for (const finding of report.findings)
    for (const key of [
      "evidence",
      "explanation",
      "recommendation",
      "confidence",
    ])
      assert.ok(finding[key]);
  assert.equal(report.metrics.syntax.functions, 0);
});

test("snapshot store persists immutable reports and rejects traversal or corrupt data", async (t) => {
  const os = require("node:os");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "autopsy-snapshot-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { createSnapshotStore } = loadTypeScript(
    path.join(root, "snapshot-store.ts"),
  );
  const store = createSnapshotStore(directory);
  const report = {
    repository: { full_name: "sample/project" },
    analyzedAt: "2026-10-12",
    scores: { overall: 72 },
  };
  const id = await store.save(report);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(await store.save(report), id);
  assert.deepEqual(await store.get(id), report);
  const history = await store.list("Sample/Project");
  assert.equal(history.length, 1);
  assert.equal(history[0].id, id);
  assert.deepEqual(await store.list("other/project"), []);
  assert.equal(await store.get("../package.json"), undefined);
  fs.writeFileSync(path.join(directory, id + ".json"), "{}");
  assert.equal(await store.get(id), undefined);
  assert.equal(await createSnapshotStore(undefined).save(report), undefined);
});

test("AI review validates references and rejects invented or duplicate findings", () => {
  const { validateReview } = loadTypeScript(path.join(root, "ai-review.ts"));
  const report = { findings: [{ id: "LOW_TEST_RATIO" }] };
  const risk = {
    findingId: "LOW_TEST_RATIO",
    why: "Few test files",
    action: "Review critical tests",
    impact: "May catch regressions",
    confidence: "medium",
  };
  const review = {
    summary: "Testing signals need review",
    risks: [risk],
    caveats: ["Sampled evidence only"],
  };
  assert.deepEqual(validateReview(review, report), review);
  assert.throws(() =>
    validateReview(
      { ...review, risks: [{ ...risk, findingId: "INVENTED" }] },
      report,
    ),
  );
  assert.throws(() =>
    validateReview({ ...review, risks: [risk, risk] }, report),
  );
  assert.throws(() => validateReview({ summary: 42 }, report));
});

test("AI provider receives only evidence and safely handles incomplete responses", async (t) => {
  const original = global.fetch,
    oldKey = process.env.OPENAI_API_KEY,
    oldModel = process.env.OPENAI_MODEL;
  t.after(() => {
    global.fetch = original;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = oldModel;
  });
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "test-model";
  const report = {
    scores: { overall: 50 },
    findings: [{ id: "LOW_TEST_RATIO" }],
    caveats: ["Bounded sample"],
    repository: { description: "Untrusted instructions" },
  };
  const review = {
    summary: "Review testing",
    risks: [],
    caveats: ["Bounded sample"],
  };
  let sent;
  global.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(review) }],
        },
      ],
    });
  };
  const { generateReview } = loadTypeScript(path.join(root, "ai-review.ts"));
  assert.deepEqual(await generateReview(report), review);
  assert.equal(sent.store, false);
  assert.equal(sent.model, "test-model");
  assert.equal(sent.text.format.strict, true);
  assert.ok(!sent.input.includes("Untrusted instructions"));
  global.fetch = async () =>
    Response.json({ status: "incomplete", output: [] });
  await assert.rejects(generateReview(report), /incomplete/);
  delete process.env.OPENAI_API_KEY;
  assert.equal(await generateReview(report), undefined);
});

test("API rejects oversized bodies before GitHub ingestion", async () => {
  const { route, calls } = makeRoute();
  const response = await route.POST(
    request({ repository: "a".repeat(9000) }, "oversized"),
  );
  assert.equal(response.status, 413);
  assert.equal(calls.collect, undefined);
});

test("documentation presence and test counts survive unreadable README and test fixtures", async () => {
  const { analyze } = loadAnalyzer();
  const report = await analyze(
    makeData([
      "README.md",
      "src/a.cpp",
      "tests/a_test.cpp",
      "tests/fixture.json",
      "tests/README.md",
    ]),
    "sample",
    "project",
  );
  assert.equal(report.metrics.sourceFiles, 1);
  assert.equal(report.metrics.testFiles, 1);
  assert.equal(report.scores.documentation, 20);
  assert.ok(
    report.caveats.some((value) =>
      value.includes("README exists but could not be read"),
    ),
  );
});

test("snapshot API rejects invalid IDs and returns 404 for missing reports", async () => {
  const { route } = makeRoute();
  assert.equal(
    (
      await route.GET(
        new Request("http://localhost/api/analyze?snapshot=../file"),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await route.GET(
        new Request("http://localhost/api/analyze?snapshot=" + "a".repeat(64)),
      )
    ).status,
    404,
  );
});

test("collector rejects token-accessible private repositories", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  global.fetch = async () =>
    Response.json({ ...makeData().repository, private: true });
  const { collect } = loadTypeScript(path.join(root, "github.ts"));
  await assert.rejects(
    collect("sample", "project"),
    (error) => error.status === 403,
  );
});

test("GitHub ingestion paginates history and feeds the real analyzer", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const calls = [];
  const commit = {
    sha: "abc",
    commit: {
      author: { date: new Date().toISOString() },
      message: "Improve tests",
    },
    author: { login: "alice" },
  };
  global.fetch = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.hostname === "raw.githubusercontent.com")
      return new Response("export function run(){ return true; }");
    const endpoint = url.pathname.replace("/repos/sample/project", "");
    if (!endpoint) return Response.json(makeData().repository);
    if (endpoint === "/languages") return Response.json({ TypeScript: 100 });
    if (endpoint.startsWith("/git/trees/"))
      return Response.json({
        tree: [{ path: "src/a.ts", type: "blob", size: 100 }],
        truncated: false,
      });
    if (endpoint === "/commits") return Response.json([commit]);
    if (endpoint === "/commits/abc")
      return Response.json({
        ...commit,
        stats: { additions: 4, deletions: 1 },
        files: [{ filename: "src/a.ts" }],
      });
    if (endpoint === "/contributors")
      return Response.json([{ login: "alice", contributions: 1 }]);
    if (endpoint === "/issues" && url.searchParams.get("state") === "all")
      return Response.json(
        url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, () => ({
              created_at: new Date().toISOString(),
            }))
          : [],
      );
    if (endpoint === "/stats/code_frequency")
      return new Response(null, { status: 202 });
    return Response.json([]);
  };
  const github = loadTypeScript(path.join(root, "github.ts"));
  const data = await github.collect("sample", "project");
  assert.equal(data.issueHistory.length, 100);
  assert.ok(
    calls.some(
      (url) =>
        url.pathname.endsWith("/issues") &&
        url.searchParams.get("page") === "2",
    ),
  );
  const analyzer = loadTypeScript(path.join(root, "analyze.ts"), {
    "./github": github,
  });
  const report = await analyzer.analyze(data, "sample", "project");
  assert.equal(report.revision, "abc");
  assert.equal(report.metrics.syntax.functions, 1);
  assert.equal(report.evolution.codeSource, "sampled-commits");
  assert.ok(
    calls.some((url) => url.pathname === "/sample/project/abc/src/a.ts"),
  );
});

test("weekly evolution totals handle malformed rows and month boundaries", () => {
  const { buildEvolution } = loadTypeScript(path.join(root, "evolution.ts"));
  const result = buildEvolution(
    {
      codeFrequency: [
        [Date.parse("2026-10-01") / 1000, 12, -5],
        [NaN, 1, 2],
        [Date.parse("2020-01-01") / 1000, 20, -2],
      ],
      details: [],
      issueHistory: [{ created_at: "invalid", closed_at: "invalid" }],
    },
    new Date("2026-10-12"),
  );
  assert.equal(result.codeSource, "weekly-stats");
  assert.equal(result.code.at(-1).additions, 12);
  assert.equal(result.code.at(-1).deletions, 5);
  assert.equal(result.code.at(-1).net, 7);
});

test("findings detect large files, stale issues, contributor concentration, hotspots and gaps", async () => {
  const old = "2024-01-01T00:00:00Z",
    recent = new Date().toISOString();
  const commits = Array.from({ length: 6 }, (_, index) => ({
    sha: String(index),
    commit: { author: { date: index ? recent : old } },
    author: { login: "alice" },
  }));
  const { analyze } = loadAnalyzer(async () => "// line\n".repeat(501));
  const report = await analyze(
    makeData(["src/a.ts"], {
      commits,
      details: commits.map((commit) => ({
        ...commit,
        files: [{ filename: "src/a.ts" }],
      })),
      issues: Array.from({ length: 31 }, () => ({ created_at: old })),
      contributors: [
        { login: "alice", contributions: 95 },
        { login: "bob", contributions: 5 },
      ],
    }),
    "sample",
    "project",
  );
  const ids = report.findings.map((finding) => finding.id);
  for (const id of [
    "LARGE_FILES",
    "STALE_ISSUES",
    "CONTRIBUTOR_CONCENTRATION",
    "LONG_INACTIVE_PERIOD",
    "HIGH_CHANGE_HOTSPOT",
    "POOR_DOCUMENTATION",
  ])
    assert.ok(ids.includes(id), id);
  assert.equal(report.metrics.largeFiles, 1);
  assert.equal(report.metrics.staleIssues, 31);
});

test("module maps collapse large graphs and resolve index imports", () => {
  const { buildModuleMap } = loadTypeScript(path.join(root, "module-map.ts"));
  const paths = Array.from(
    { length: 10 },
    (_, index) => `group${index}/index.ts`,
  );
  const map = buildModuleMap(
    [
      {
        path: paths[0],
        text: 'import x from "../group1"; require("../group9");',
      },
    ],
    paths,
    null,
    "tsconfig.json",
  );
  assert.equal(map.nodes.length, 8);
  assert.equal(map.collapsedModules, 3);
  assert.equal(map.edges.length, 2);
  assert.ok(map.nodes.some((node) => node.id === "__other__"));
});

test("GitHub metadata errors are mapped to safe actionable failures", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const { collect } = loadTypeScript(path.join(root, "github.ts"));
  for (const [status, expected] of [
    [404, 404],
    [429, 429],
    [403, 403],
    [500, 502],
  ]) {
    global.fetch = async () => new Response(null, { status });
    await assert.rejects(
      collect("sample", "project"),
      (error) => error.status === expected,
    );
  }
});

test("GitHub distinguishes primary and secondary limits, permissions and rejected tokens", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const { collect } = loadTypeScript(path.join(root, "github.ts"));
  for (const [status, headers, message, code, expected] of [
    [403, { "x-ratelimit-remaining": "0" }, "quota", "GITHUB_RATE_LIMIT", 429],
    [
      403,
      { "retry-after": "17" },
      "secondary rate limit",
      "GITHUB_RATE_LIMIT",
      429,
    ],
    [403, {}, "API rate limit exceeded", "GITHUB_RATE_LIMIT", 429],
    [
      403,
      { "x-ratelimit-remaining": "100" },
      "Resource not accessible",
      "GITHUB_PERMISSION",
      403,
    ],
    [401, {}, "Bad credentials", "GITHUB_AUTH", 502],
  ]) {
    global.fetch = async () => Response.json({ message }, { status, headers });
    await assert.rejects(
      collect("sample", "project"),
      (error) =>
        error.code === code &&
        error.status === expected &&
        (expected !== 429 || error.retryAfter > 0),
    );
  }
});

test("issues-disabled ingestion skips issue endpoints and analyzer leaves hygiene unscored", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const commit = {
    sha: "abc",
    commit: { message: "test", author: { date: new Date().toISOString() } },
    author: { login: "alice" },
  };
  global.fetch = async (input) => {
    const endpoint = new URL(input).pathname.replace(
      "/repos/sample/project",
      "",
    );
    assert.ok(
      !endpoint.endsWith("/issues"),
      "disabled issue endpoint must never be requested",
    );
    if (!endpoint)
      return Response.json({ ...makeData().repository, has_issues: false });
    if (endpoint === "/commits") return Response.json([commit]);
    if (endpoint === "/commits/abc") return Response.json(commit);
    if (endpoint === "/languages") return Response.json({});
    if (endpoint.startsWith("/git/trees/"))
      return Response.json({ tree: [], truncated: false });
    if (endpoint === "/stats/code_frequency")
      return new Response(null, { status: 202 });
    return Response.json([]);
  };
  const github = loadTypeScript(path.join(root, "github.ts"));
  const data = await github.collect("sample", "project");
  const report = await loadAnalyzer().analyze(data, "sample", "project");
  assert.equal(data.issuesDisabled, true);
  assert.equal(report.scores.issueHygiene, null);
  assert.ok(
    report.caveats.some((text) => text.includes("issue tracking is disabled")),
  );
  assert.ok(Number.isFinite(report.scores.overall));
});

test("production configuration rejects missing, unsafe and inconsistent values", () => {
  const { validate } = require("./validate-env.cjs");
  const valid = {
    DATABASE_URL: "postgresql://localhost/test",
    TRUSTED_PROXY_SECRET: "a".repeat(32),
    MONITORING_TOKEN: "b".repeat(32),
  };
  assert.equal(validate(valid), true);
  assert.throws(() => validate({}), /Missing required/);
  assert.throws(
    () => validate({ ...valid, DATABASE_URL: "http://localhost" }),
    /PostgreSQL/,
  );
  assert.throws(
    () => validate({ ...valid, TRUSTED_PROXY_SECRET: 'x";'.repeat(12) }),
    /URL-safe/,
  );
  assert.throws(
    () => validate({ ...valid, OPENAI_API_KEY: "test" }),
    /together/,
  );
});

test("monitoring authorization rejects unauthenticated access and metrics expose safe counters", () => {
  const { monitoringAuthorized, metricsText, event } = loadTypeScript(
    path.join(root, "observability.ts"),
  );
  const previous = process.env.MONITORING_TOKEN;
  process.env.MONITORING_TOKEN = "test-" + "x".repeat(32);
  try {
    assert.equal(monitoringAuthorized(new Request("http://localhost")), false);
    assert.equal(
      monitoringAuthorized(
        new Request("http://localhost", {
          headers: { authorization: "Bearer " + process.env.MONITORING_TOKEN },
        }),
      ),
      true,
    );
    event("test_verified", { status: 200 });
    assert.match(
      metricsText(),
      /autopsy_events_total\{event="test_verified"\} 1/,
    );
    assert.ok(!metricsText().includes(process.env.MONITORING_TOKEN));
  } finally {
    if (previous === undefined) delete process.env.MONITORING_TOKEN;
    else process.env.MONITORING_TOKEN = previous;
  }
});

test("raw downloads handle missing files, bounded UTF-8 text and unavailable content", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const { raw } = loadTypeScript(path.join(root, "github.ts"));
  global.fetch = async () => new Response("export const smile='😀';");
  assert.equal(
    await raw("sample", "project", "main", "a.ts"),
    "export const smile='😀';",
  );
  global.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await raw("sample", "project", "main", "a.ts"), null);
  global.fetch = async () => {
    throw new TypeError("network");
  };
  assert.equal(await raw("sample", "project", "main", "a.ts"), null);
  global.fetch = async () =>
    new Response("x", { headers: { "content-length": "150001" } });
  assert.equal(await raw("sample", "project", "main", "a.ts"), null);
});

test("optional AI and storage failures preserve a usable deterministic report", async () => {
  const { route } = makeRoute({
    generateReview: async () => {
      throw Error("provider unavailable");
    },
    save: async () => {
      throw Error("disk unavailable");
    },
  });
  const response = await route.POST(
    request({ repository: "sample/project" }, "fallback"),
  );
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.ok(
    report.caveats.some((value) => value.includes("AI review is unavailable")),
  );
  assert.ok(
    report.caveats.some((value) =>
      value.includes("snapshot storage is unavailable"),
    ),
  );
});

test("snapshot routes return saved data or report storage outages", async () => {
  const id = "a".repeat(64),
    req = new Request("http://localhost/api/analyze?snapshot=" + id);
  const { route } = makeRoute({
    get: async () => ({
      repository: { full_name: "sample/project" },
      scores: { overall: 72 },
    }),
  });
  const response = await route.GET(req);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).snapshotId, id);
  const { route: failed } = makeRoute({
    get: async () => {
      throw Error("storage");
    },
  });
  assert.equal((await failed.GET(req)).status, 503);
});
