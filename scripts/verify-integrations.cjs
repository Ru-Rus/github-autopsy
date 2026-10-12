// Operator-triggered, bounded live checks. Never print provider payloads/secrets.
const fs = require("node:fs");
const path = require("node:path");
const { context } = require("./test-support.cjs");
async function run() {
  const result = {
    timestamp: new Date().toISOString(),
    github: "UNVERIFIED",
    openai: "UNVERIFIED",
  };
  try {
    const data = await context()
      .load("github.ts")
      .collect("octocat", "Hello-World", AbortSignal.timeout(55000));
    result.github =
      data.repository.full_name === "octocat/Hello-World" &&
      data.commits.length > 0
        ? "PASS"
        : "FAIL";
    result.githubCommits = data.commits.length;
  } catch (error) {
    result.github = "FAIL";
    result.githubErrorCode = error.code ?? "NETWORK_OR_PROVIDER_ERROR";
  }
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) {
    try {
      const { generateReview } = context().load("ai-review.ts");
      const review = await generateReview(
        {
          scores: { overall: 50 },
          findings: [
            {
              id: "missing-ci",
              title: "Missing CI",
              severity: "warning",
              category: "ci",
              evidence: ["No workflow found"],
              recommendation: "Add CI",
            },
          ],
          caveats: [],
        },
        AbortSignal.timeout(15000),
      );
      result.openai = review ? "PASS" : "FAIL";
    } catch {
      result.openai = "FAIL";
    }
  } else
    result.openaiReason =
      "Credentials/model are absent; no billed call attempted.";
  fs.mkdirSync(path.resolve("MD"), { recursive: true });
  fs.writeFileSync(
    path.resolve("MD/live-integration-evidence.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  if (result.github !== "PASS" || result.openai === "FAIL")
    process.exitCode = 1;
}
run().catch(() => {
  console.error("Integration verification failed.");
  process.exitCode = 1;
});
