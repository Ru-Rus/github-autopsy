import type { Category, Finding, Key, Report } from "./types";
import { raw, type Data } from "./github";
import { scoring } from "./scoring";
import { buildEvolution } from "./evolution";
import { buildModuleMap } from "./module-map";
import { analyzeSyntax } from "./static-analysis";
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const age = (d: string | null | undefined) => {
  if (!d) return 0;
  const n = Date.parse(d);
  return Number.isFinite(n)
    ? Math.max(0, Math.floor((Date.now() - n) / 86400000))
    : 0;
};
const test = (p: string) =>
  /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^.]+$|(^|\/)test_[^/]+\.py$|_(test|tests)\.(py|cpp|cc|cxx)$|_test\.go$|(?:Test|Tests)\.(java|cs)$/i.test(
    p,
  );
const source = (p: string) =>
  /\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|cs|php|rb|swift|kt|c|cc|cpp|cxx)$/i.test(p);
const has = (p: string[], r: RegExp) => p.some((x) => r.test(x));
export async function analyze(
  d: Data,
  owner: string,
  name: string,
  signal?: AbortSignal,
): Promise<Report> {
  const entries = d.tree.filter((x) => x.type === "blob"),
    paths = entries.map((x) => x.path),
    clean = (p: string) =>
      !/(^|\/)(node_modules|vendor|dist|build|coverage|generated)(\/|$)|\.min\./i.test(
        p,
      );
  const sourceEntries = entries.filter(
      (x) => source(x.path) && !test(x.path) && clean(x.path),
    ),
    src = sourceEntries.map((x) => x.path),
    tests = paths.filter((p) => test(p) && source(p) && clean(p)).length;
  const scriptSource = (path: string) => /\.(?:tsx?|jsx?|mjs|cjs)$/i.test(path);
  const readableEntries = sourceEntries.filter(
    (x) => x.size === undefined || x.size <= 150000,
  );
  const scriptEntries = readableEntries.filter((x) => scriptSource(x.path));
  const otherEntries = readableEntries.filter((x) => !scriptSource(x.path));
  const scanEntries = [
      ...scriptEntries.slice(0, 20),
      ...otherEntries.slice(0, Math.max(0, 20 - scriptEntries.length)),
    ],
    readmeEntry = entries.find((x) => /^readme\.md$/i.test(x.path)),
    configEntry = entries.find((x) =>
      /^(tsconfig|jsconfig)\.json$/i.test(x.path),
    );
  const [fetched, readme, pathConfig] = await Promise.all([
    Promise.all(
      scanEntries.map((x) =>
        raw(owner, name, d.revision ?? d.repository.default_branch ?? "", x.path, signal),
      ),
    ),
    readmeEntry &&
    (readmeEntry.size === undefined || readmeEntry.size <= 150000)
      ? raw(owner, name, d.revision ?? d.repository.default_branch ?? "", readmeEntry.path, signal)
      : Promise.resolve(null),
    configEntry &&
    (configEntry.size === undefined || configEntry.size <= 150000)
      ? raw(owner, name, d.revision ?? d.repository.default_branch ?? "", configEntry.path, signal)
      : Promise.resolve(null),
  ]);
  const scanned = fetched.flatMap((text, index) =>
      text === null ? [] : [{ path: scanEntries[index].path, text }],
    ),
    texts = scanned.map((x) => x.text);
  const moduleMap = buildModuleMap(
    scanned,
    src.filter(scriptSource),
    pathConfig,
    configEntry?.path ?? "tsconfig.json",
  );
  const syntax = analyzeSyntax(scanned);
  const todo = texts.reduce(
    (n, s) => n + (s.match(/\bTODO\b|\bFIXME\b/gi)?.length ?? 0),
    0,
  );
  const large = texts.filter((s) => s.split(/\r?\n/).length > 500).length;
  const ci = has(paths, /^\.github\/workflows\/[^/]+\.ya?ml$/i),
    lint = has(
      paths,
      /(^|\/)(eslint\.config\.|\.eslintrc|\.prettierrc|biome\.json|ruff\.toml|\.pylintrc)/i,
    );
  const ts = has(paths, /(^|\/)tsconfig\.json$/i),
    dep = has(
      paths,
      /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|pom\.xml|composer\.json)$/i,
    );
  const runner =
    has(
      paths,
      /(^|\/)(jest\.config\.|vitest\.config\.|pytest\.ini|tox\.ini|\.mocharc\.|playwright\.config\.)/i,
    ) || has(paths, /(^|\/)[^/]+_test\.go$/i);
  const coverage = has(
    paths,
    /(^|\/)(\.coveragerc|nyc\.config\.[^/]+|c8\.config\.[^/]+|\.nycrc(?:\.json)?|codecov\.ya?ml|coverage\.ya?ml)$/i,
  );
  const license =
      Boolean(d.repository.license) || has(paths, /^license(\.|$)/i),
    contrib = has(paths, /^contributing(\.md)?$/i),
    docs = has(paths, /^(docs|examples)\//i);
  const install =
    !!readme &&
    /\b(install|installation|getting started|quick ?start)\b/i.test(readme);
  const usage =
    !!readme &&
    (/(^|\n)#+\s*(usage|examples?)/i.test(readme) ||
      /\x60\x60\x60/.test(readme));
  const arch =
    (!!readme && /\b(architecture|design|structure)\b/i.test(readme)) || docs;
  const apiDocs =
    has(paths, /(^|\/)(openapi|swagger)(\.json|\.ya?ml)?$/i) ||
    has(paths, /(^|\/)api-docs?\//i);
  const docsParts: [
    [boolean, number, string],
    [boolean, number, string],
    [boolean, number, string],
    [boolean, number, string],
    [boolean, number, string],
    [boolean, number, string],
    [boolean, number, string],
  ] = [
    [!!readmeEntry, 20, "README exists"],
    [install, 20, "Setup instructions detected"],
    [usage, 20, "Usage examples detected"],
    [arch, 15, "Architecture notes or docs/examples detected"],
    [contrib, 10, "Contribution guide exists"],
    [license, 10, "License detected"],
    [apiDocs, 5, "API documentation detected"],
  ];
  const ds = docsParts.reduce((n, x) => n + (x[0] ? x[1] : 0), 0),
    ratio = src.length ? tests / src.length : 0;
  const cs = clamp(
    paths.length
      ? 100 -
          (lint ? 0 : 12) -
          (dep ? 0 : 10) -
          Math.min(large * 5, 25) -
          Math.max(0, todo - 10) * 0.35
      : 0,
  );
  const tsScore = clamp(
    Math.min(40, (ratio / 0.3) * 40) +
      (runner ? 20 : 0) +
      (ci ? 20 : 0) +
      (coverage ? 20 : 0),
  );
  const commits = [...d.commits]
    .filter((c) => Number.isFinite(Date.parse(c.commit.author?.date ?? "")))
    .sort(
      (a, b) =>
        Date.parse(a.commit.author?.date ?? "") -
        Date.parse(b.commit.author?.date ?? ""),
    );
  let gap = 0;
  for (let i = 1; i < commits.length; i++)
    gap = Math.max(
      gap,
      Math.floor(
        (Date.parse(commits[i].commit.author?.date ?? "") -
          Date.parse(commits[i - 1].commit.author?.date ?? "")) /
          86400000,
      ),
    );
  const counts = new Map<string, number>();
  for (const c of d.commits) {
    const date = c.commit.author?.date;
    if (!date || !Number.isFinite(Date.parse(date))) continue;
    const m = date.slice(0, 7);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const now = new Date(),
    timeline = Array.from({ length: 12 }, (_, i) => {
      const x = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1),
        ),
        month = x.toISOString().slice(0, 7);
      return { month, commits: counts.get(month) ?? 0 };
    });
  const active = timeline.filter((x) => x.commits > 0).length,
    newest = commits.at(-1)?.commit.author?.date ?? d.repository.pushed_at;
  const recency = newest
      ? age(newest) <= 7
        ? 35
        : age(newest) <= 30
          ? 30
          : age(newest) <= 90
            ? 22
            : age(newest) <= 180
              ? 12
              : 2
      : 0,
    gapPoints =
      commits.length > 1 ? Math.max(0, 20 - Math.max(0, gap - 30) / 20) : 0,
    as = clamp(
      recency +
        (active / 12) * 30 +
        gapPoints +
        Math.min(15, d.commits.length / 10),
    );
  const issues = d.issues.filter((x) => !x.pull_request),
    stale = issues.filter((x) => age(x.created_at) > 90).length,
    oldest = issues.reduce((n, x) => Math.max(n, age(x.created_at)), 0);
  const is = clamp(
    100 -
      Math.min(40, stale * 1.5) -
      (oldest > 365 ? 25 : oldest > 180 ? 15 : 0) -
      (d.repository.open_issues_count > 100 ? 10 : 0),
  );
  const people = d.contributors
    .filter((x) => x.login)
    .map((x) => ({ login: x.login!, contributions: x.contributions }))
    .sort((a, b) => b.contributions - a.contributions);
  const total = people.reduce((n, x) => n + x.contributions, 0),
    top = total ? people[0].contributions / total : 0,
    langBytes = Object.values(d.languages).reduce((n, x) => n + x, 0);
  const languages = Object.entries(d.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => ({
      name,
      share: langBytes ? Math.round((n / langBytes) * 100) : 0,
    }));
  const changed = new Map<string, Set<string>>();
  for (const c of d.details)
    for (const f of c.files ?? []) {
      if (!changed.has(f.filename)) changed.set(f.filename, new Set());
      changed.get(f.filename)!.add(c.sha);
    }
  const hotspots = [...changed]
    .map(([path, s]) => ({ path, commits: s.size }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 5);
  const topShare = d.details.length
    ? new Set(
        hotspots.slice(0, 3).flatMap((x) => [...(changed.get(x.path) ?? [])]),
      ).size / d.details.length
    : 0;
  const mergedPulls = d.pulls.filter((p) => Boolean(p.merged_at)).length,
    openPulls = d.pulls.filter((p) => p.state === "open").length;
  const insufficientData = paths.length === 0 && d.commits.length === 0;
  const keys: Key[] = [
      "codeQuality",
      "documentation",
      "testing",
      "activity",
      "issueHygiene",
    ],
    scores: Report["scores"] = {
      codeQuality: insufficientData ? null : cs,
      documentation: insufficientData ? null : ds,
      testing: insufficientData ? null : tsScore,
      activity: insufficientData ? null : as,
      issueHygiene: insufficientData || d.issuesDisabled ? null : is,
      overall: insufficientData
        ? null
        : clamp(
            (cs * scoring.weights.codeQuality +
              ds * scoring.weights.documentation +
              tsScore * scoring.weights.testing +
              as * scoring.weights.activity +
              (d.issuesDisabled ? 0 : is * scoring.weights.issueHygiene)) / (d.issuesDisabled ? 1 - scoring.weights.issueHygiene : 1),
          ),
    };
  const labels: Record<Key, string> = {
    codeQuality: "Code quality",
    documentation: "Documentation",
    testing: "Testing",
    activity: "Activity",
    issueHygiene: "Issue hygiene",
  };
  const evidence: Record<Key, string[]> = {
    codeQuality: [
      `${syntax.functions} functions, ${syntax.classes} classes and ${syntax.branches} branch points in sampled JavaScript/TypeScript syntax.`,
      `${src.length} source files and ${paths.length} tracked files.`,
      lint
        ? "Lint/format config detected."
        : "No common lint/format config detected.",
      `${large} scanned files exceed 500 lines; ${todo} TODO/FIXME markers in bounded scan.`,
      ts
        ? "TypeScript configuration detected."
        : "No TypeScript configuration detected.",
    ],
    documentation: docsParts.map(
      (x) => `${x[0] ? "Present" : "Not detected"}: ${x[2]}.`,
    ),
    testing: [
      `${tests} test-like files / ${src.length} source files (${(ratio * 100).toFixed(1)}%).`,
      runner
        ? "Test runner config detected."
        : "No common test runner config detected.",
      ci
        ? "CI workflow files exist; test execution is not verified."
        : "No GitHub Actions workflow detected.",
      coverage
        ? "Coverage config detected."
        : "No common coverage config detected.",
    ],
    activity: [
      `${d.commits.length} recent commits sampled; ${active} active months in last 12.`,
      `${d.pulls.length} pull requests sampled; ${mergedPulls} merged and ${openPulls} open.`,
      newest
        ? `Latest sampled commit was ${age(newest)} days ago.`
        : "No commit dates available.",
      `Longest gap in sample: ${gap} days.`,
      `${people.length} contributors returned.`,
    ],
    issueHygiene: [
      `GitHub reports ${d.repository.open_issues_count} open items, including pull requests.`,
      `${stale} of ${issues.length} oldest sampled open issues exceed 90 days.`,
      oldest
        ? `Oldest sampled issue: ${oldest} days.`
        : "No open issue sampled.",
    ],
  };
  const summary: Record<Key, string> = {
    codeQuality: "Structure and maintainability signals",
    documentation: "Onboarding and reference material",
    testing: "Infrastructure signals, not actual coverage",
    activity: "Recent commits and contributor patterns",
    issueHygiene: "Age of oldest sampled open issues",
  };
  const categories: Category[] = keys.map((key) => ({
    key,
    label: labels[key],
    score: scores[key],
    summary: summary[key],
    evidence: evidence[key],
  }));
  const findings: Finding[] = [],
    add = (f: Finding) => findings.push(f);
  if (!insufficientData && ratio < 0.2 && src.length)
    add({
      id: "LOW_TEST_RATIO",
      severity: ratio < 0.08 ? "high" : "medium",
      title: "Testing signals trail source files",
      evidence: `${tests} test-like files for ${src.length} source files.`,
      explanation:
        "File counts do not show whether tests are effective or comprehensive.",
      recommendation: "Review critical flows and add focused regression tests.",
      confidence: "medium",
    });
  if (!insufficientData && !ci)
    add({
      id: "NO_CI",
      severity: "medium",
      title: "No GitHub Actions workflow detected",
      evidence: "No workflow file found under .github/workflows.",
      explanation: "Another CI provider may be in use.",
      recommendation:
        "Confirm automated checks run on changes and document the CI provider.",
      confidence: "medium",
    });
  if (!insufficientData && !license)
    add({
      id: "NO_LICENSE",
      severity: "low",
      title: "No license detected",
      evidence: "No license metadata or root license file found.",
      explanation: "Reuse and distribution terms may be unclear.",
      recommendation: "Choose and add a license matching the project's intent.",
      confidence: "high",
    });
  if (!insufficientData && stale >= 10)
    add({
      id: "STALE_ISSUES",
      severity: stale >= 30 ? "high" : "medium",
      title: "Older open issues need triage",
      evidence: `${stale} of ${issues.length} oldest sampled issues exceed 90 days.`,
      explanation: "Age alone does not mean a report is abandoned.",
      recommendation:
        "Review old issues and close resolved or obsolete reports.",
      confidence: "medium",
    });
  if (!insufficientData && top > 0.6 && people.length > 1)
    add({
      id: "CONTRIBUTOR_CONCENTRATION",
      severity: top > 0.8 ? "high" : "medium",
      title: "Contributor activity is concentrated",
      evidence: `Leading contributor has ${Math.round(top * 100)}% of returned contribution counts.`,
      explanation: "Commit counts do not establish ownership or bus factor.",
      recommendation:
        "Share operational knowledge and review maintainer dependencies.",
      confidence: "low",
    });
  if (!insufficientData && gap >= 90)
    add({
      id: "LONG_INACTIVE_PERIOD",
      severity: gap >= 180 ? "high" : "medium",
      title: "A long inactive period appears in sampled history",
      evidence: `Longest gap in ${d.commits.length} sampled commits: ${gap} days.`,
      explanation: "The sample may not represent complete repository history.",
      recommendation:
        "Check whether the gap reflects an intentional release cycle.",
      confidence: "medium",
    });
  if (!insufficientData && large)
    add({
      id: "LARGE_FILES",
      severity: large >= 5 ? "high" : "low",
      title: "Large source files detected",
      evidence: `${large} of ${texts.length} fetched files exceed 500 lines.`,
      explanation: "File length alone does not indicate complexity.",
      recommendation:
        "Review whether large files have focused responsibilities and tests.",
      confidence: "medium",
    });
  if (!insufficientData && topShare > 0.7 && d.details.length >= 5)
    add({
      id: "HIGH_CHANGE_HOTSPOT",
      severity: "medium",
      title: "Recent changes cluster around a few files",
      evidence: `${Math.round(topShare * 100)}% of detailed commits touch one of the three busiest files.`,
      explanation: "Frequently changed paths may reflect active feature work.",
      recommendation:
        "Check ownership and regression checks around those paths.",
      confidence: "low",
    });
  if (!insufficientData && ds < 50)
    add({
      id: "POOR_DOCUMENTATION",
      severity: "low",
      title: "Getting-started guidance is limited",
      evidence: `Documentation checklist score: ${ds}/100.`,
      explanation:
        "The checklist cannot judge whether prose is accurate or complete.",
      recommendation:
        "Add setup steps, usage examples, and a short architecture overview.",
      confidence: "medium",
    });
  const evolution = buildEvolution(d);
  const caveats = [
    ...(d.issuesDisabled ? ["Repository issue tracking is disabled. Issue hygiene is unscored and remaining overall weights are normalized."] : []),
    ...(d.warnings ?? []),
    "Scores are deterministic heuristics, not objective software quality measurements.",
    `Activity covers at most ${d.commits.length} recent commits; gaps are measured only within that sample.`,
    `TODOs and line counts use ${texts.length} fetched source files (maximum 20).`,
    `Issue ages use the oldest ${issues.length} sampled open issues; GitHub's total includes pull requests.`,
    d.truncated
      ? "GitHub marked the tree truncated; file counts/config detection may be incomplete."
      : "Repository file counts come from the GitHub tree returned for this analysis.",
  ];
  if (texts.length < scanEntries.length) caveats.push(`${scanEntries.length - texts.length} selected source files could not be read; source metrics describe only successful reads.`);
  if (readmeEntry && readme === null) caveats.push("The README exists but could not be read; content-based documentation checks are unavailable.");
  caveats.push(
    "Issue history contains up to " +
      evolution.issueItemsSample +
      " recently updated items; pull requests are excluded and busy repositories may reach the 400-item cap.",
    evolution.codeSource === "weekly-stats"
      ? "Code growth shows GitHub's weekly lines added and removed, not an exact source-code size."
      : evolution.codeSource === "sampled-commits"
        ? "Code growth falls back to line-change stats from at most 12 recent detailed commits."
        : "GitHub has not returned code-change history or detailed commit stats for this repository.",
    "The project map resolves local JavaScript and TypeScript imports from up to 20 scanned files; other languages and unresolved import patterns may be missing.",
  );
  return {
    revision: d.revision,
    analyzedAt: new Date().toISOString(),
    repository: d.repository,
    scores,
    categories,
    findings,
    metrics: {
      syntax,
      totalFiles: paths.length,
      sourceFiles: src.length,
      testFiles: tests,
      ratio,
      largeFiles: large,
      todoCount: todo,
      scannedFiles: texts.length,
      sampledCommits: d.commits.length,
      sampledPulls: d.pulls.length,
      mergedPulls,
      openPulls,
      activeMonths: active,
      longestGap: gap,
      oldestIssue: oldest,
      staleIssues: stale,
      issueSample: issues.length,
      contributors: people.length,
      languages,
      hotspots,
    },
    timeline,
    evolution,
    moduleMap,
    contributorList: people.slice(0, 8),
    caveats,
  };
}
