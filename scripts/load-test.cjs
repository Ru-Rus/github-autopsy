// Explicitly target a staging proxy. No GitHub/OpenAI calls: invalid bodies test
// rate protection; snapshot reads test shared storage after setting SNAPSHOT_ID.
const target = process.env.LOAD_TEST_URL;
if (!target || !/^https?:\/\//.test(target))
  throw new Error("Set LOAD_TEST_URL to a staging proxy URL.");
const concurrent = Number(process.env.LOAD_CONCURRENCY ?? 10);
const total = Number(process.env.LOAD_REQUESTS ?? 100);
if (
  !Number.isInteger(concurrent) ||
  concurrent < 1 ||
  concurrent > 100 ||
  !Number.isInteger(total) ||
  total < 1 ||
  total > 10000
)
  throw new Error("Invalid load bounds.");
let next = 0;
const latencies = [],
  statuses = {};
async function worker() {
  while (next++ < total) {
    const started = performance.now();
    try {
      const id = process.env.SNAPSHOT_ID;
      const response = await fetch(
        new URL(
          id
            ? "/api/analyze?snapshot=" + encodeURIComponent(id)
            : "/api/analyze",
          target,
        ),
        {
          method: id ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.0.2." + next,
          },
          ...(id ? {} : { body: "{}" }),
          signal: AbortSignal.timeout(10000),
        },
      );
      await response.arrayBuffer();
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    } catch {
      statuses.network_error = (statuses.network_error ?? 0) + 1;
    }
    latencies.push(performance.now() - started);
  }
}
Promise.all(Array.from({ length: concurrent }, worker)).then(() => {
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      requests: total,
      concurrent,
      statuses,
      p50Ms: latencies[Math.floor(total * 0.5)],
      p95Ms: latencies[Math.min(total - 1, Math.floor(total * 0.95))],
    }),
  );
  if (
    statuses.network_error ||
    Object.keys(statuses).some((key) => Number(key) >= 500)
  )
    process.exitCode = 1;
});
