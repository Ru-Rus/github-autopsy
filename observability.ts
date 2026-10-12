import { createHash, timingSafeEqual } from "node:crypto";

const counters = new Map<string, number>();

export function event(
  name: string,
  fields: Record<string, string | number | boolean> = {},
) {
  if (/^[a-z_]{1,50}$/.test(name) && (counters.has(name) || counters.size < 50))
    counters.set(name, (counters.get(name) ?? 0) + 1);
  // Callers supply bounded safe metadata only; never include tokens, bodies,
  // raw errors, source contents, IP addresses, or connection strings.
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "github-autopsy",
      event: name,
      ...fields,
    }),
  );
}
export function metricsText() {
  return (
    "# HELP autopsy_events_total Application events since this instance started.\n# TYPE autopsy_events_total counter\n" +
    [...counters]
      .map(([name, count]) => `autopsy_events_total{event="${name}"} ${count}`)
      .join("\n") +
    "\n"
  );
}
export function repositoryTag(repository: string) {
  return createHash("sha256")
    .update(repository.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}
export function monitoringAuthorized(req: Request) {
  const secret = process.env.MONITORING_TOKEN;
  if (!secret || secret.length < 32) return false;
  const actual = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from("Bearer " + secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
