import { test, expect } from "@playwright/test";
import { analyze } from "../../analyze";
import type { Data } from "../../github";

test("health and monitoring endpoints enforce authorization on the production server", async ({
  request,
}) => {
  expect((await request.get("/api/health/live")).status()).toBe(200);
  expect((await request.get("/api/health/ready")).status()).toBe(401);
  expect((await request.get("/api/metrics")).status()).toBe(401);
  const headers = { authorization: "Bearer " + process.env.MONITORING_TOKEN };
  const ready = await request.get("/api/health/ready", { headers });
  expect(ready.status()).toBe(200);
  expect((await ready.json()).ready).toBe(true);
  expect((await request.get("/api/metrics", { headers })).status()).toBe(200);
});

test("production API rejects forged proxy credentials and enforces shared limits", async ({
  request,
}, testInfo) => {
  const denied = await request.post("/api/analyze", {
    data: {},
    headers: {
      "x-autopsy-proxy-secret": "forged",
      "x-forwarded-for": "192.0.2.100",
    },
  });
  expect(denied.status()).toBe(403);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      request.post("/api/analyze", {
        data: {},
        headers: {
          "x-autopsy-client-ip":
            testInfo.project.name === "mobile" ? "192.0.2.32" : "192.0.2.31",
          "x-forwarded-for": "198.51.100." + index,
        },
      }),
    ),
  );
  expect(results.filter((response) => response.status() === 400)).toHaveLength(
    5,
  );
  expect(results.filter((response) => response.status() === 429)).toHaveLength(
    3,
  );
  expect(
    results.find((response) => response.status() === 429)?.headers()[
      "retry-after"
    ],
  ).toBeTruthy();
});

const data: Data = {
  repository: {
    full_name: "sample/project",
    html_url: "https://github.com/sample/project",
    description: "A browser test repository",
    stargazers_count: 12,
    forks_count: 3,
    open_issues_count: 0,
    default_branch: "main",
    created_at: "2024-01-01T00:00:00Z",
    pushed_at: null,
    archived: false,
    license: null,
  },
  tree: [{ path: "package.json", type: "blob" }],
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

test("renders a report, switches views, shares and exports without runtime errors", async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const report = await analyze(data, "sample", "project");
  await page.route("**/api/analyze", (route) =>
    route.fulfill({ json: report }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByLabel("PUBLIC GITHUB REPOSITORY").fill("sample/project");
  await page
    .getByRole("button", { name: "Analyze repository", exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: "sample/project" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No GitHub Actions workflow detected" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Evidence by category" }),
  ).toBeVisible();
  if (process.env.CAPTURE_SCREENSHOTS)
    await page.screenshot({
      path: `docs/screenshots/report-${testInfo.project.name}.png`,
      fullPage: true,
    });
  await page.getByRole("button", { name: "Repository evolution" }).click();
  await expect(
    page.getByRole("heading", { name: "Active contributors" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Project map" }).click();
  await expect(
    page.getByText("No source files were available to map."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Share report" }).click();
  await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "repo=sample%2Fproject",
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("sample-project-autopsy.json");
  expect(await download.failure()).toBeNull();
  await page.getByRole("button", { name: "New analysis" }).click();
  await expect(page.getByLabel("PUBLIC GITHUB REPOSITORY")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("snapshot share URLs load saved reports and comparisons", async ({
  page,
}) => {
  const report = await analyze(data, "sample", "project");
  const id = "a".repeat(64);
  report.snapshotId = id;
  report.history = [
    {
      id,
      repository: "sample/project",
      analyzedAt: report.analyzedAt,
      score: report.scores.overall,
      sourceFiles: 1,
      testFiles: 0,
      contributors: 1,
    },
  ];
  await page.route("**/api/analyze?*", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: report });
  });
  await page.goto("/?snapshot=" + id);
  await expect(
    page.getByRole("heading", { name: "sample/project" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Repository evolution" }).click();
  await expect(
    page.getByRole("heading", { name: "Health history and comparisons" }),
  ).toBeVisible();
  await expect(page.getByText(/1 sources/)).toBeVisible();
});

test("empty reports avoid misleading numeric health scores", async ({
  page,
}) => {
  const report = await analyze({ ...data, tree: [] }, "sample", "project");
  await page.route("**/api/analyze", (route) =>
    route.fulfill({ json: report }),
  );
  await page.goto("/?repo=sample/project");
  await expect(page.getByText("Insufficient data")).toBeVisible();
  await expect(
    page.getByText("No findings to display.", { exact: false }),
  ).toBeVisible();
});

test("share URLs automatically analyze and upstream errors are accessible", async ({
  page,
}) => {
  await page.route("**/api/analyze", (route) =>
    route.fulfill({
      status: 429,
      json: { error: "GitHub rate limit reached." },
    }),
  );
  await page.goto("/?repo=sample/project");
  await expect(
    page.getByRole("alert").filter({ hasText: "GitHub rate limit reached." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Analyze repository" }),
  ).toBeEnabled();
});

test("real API rejects invalid input without contacting GitHub", async ({
  request,
}) => {
  const response = await request.post("/api/analyze", {
    data: { repository: "https://example.com/owner/repo" },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toContain("github.com");
});

test("production API ingests GitHub fixtures and renders actual analysis", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("PUBLIC GITHUB REPOSITORY").fill("fixture/repository");
  const responseEvent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/analyze") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Analyze repository", exact: false })
    .click();
  const response = await responseEvent;
  expect(response.status()).toBe(200);
  const report = await response.json();
  expect(report.revision).toBe("abc123");
  expect(report.metrics.syntax.functions).toBe(1);
  expect(report.metrics.syntax.branches).toBe(1);
  expect(report.moduleMap.nodes).toHaveLength(1);
  await expect(
    page.getByRole("heading", { name: "fixture/repository" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Testing signals trail source files" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Project map" }).click();
  await expect(
    page.getByRole("heading", { name: "Project parts map" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
