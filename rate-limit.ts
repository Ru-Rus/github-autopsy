import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { transaction } from "./database";

export interface Budget {
  key: string;
  limit: number;
  windowMs: number;
  cost?: number;
}
type Consume = (budgets: Budget[]) => Promise<number>;
export function clientIdentity(
  req: Request,
  secret = process.env.TRUSTED_PROXY_SECRET,
): string {
  // Request does not expose a socket peer: forwarding headers alone prove nothing.
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw Object.assign(new Error("Trusted proxy is not configured."), {
        status: 503,
      });
    return "anonymous";
  }
  if (secret.length < 32)
    throw Object.assign(new Error("Trusted proxy configuration is invalid."), {
      status: 503,
    });
  const supplied = req.headers.get("x-autopsy-proxy-secret") ?? "";
  const actual = Buffer.from(supplied),
    expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw Object.assign(
      new Error("Requests must pass through the trusted proxy."),
      { status: 403 },
    );
  const ip = req.headers.get("x-autopsy-client-ip") ?? "";
  if (!isIP(ip))
    throw Object.assign(
      new Error("Trusted proxy client identity is invalid."),
      { status: 403 },
    );
  return createHash("sha256").update(ip.toLowerCase()).digest("hex");
}

export const consumeShared: Consume = async (budgets) =>
  transaction(async (client) => {
    // One global transaction lock makes multi-budget checks all-or-nothing and
    // prevents concurrent application instances from overspending a budget.
    await client.query("SELECT pg_advisory_xact_lock(71423001)");
    await client.query(
      "DELETE FROM autopsy_limits WHERE reset_at <= clock_timestamp()",
    );
    const now = Number(
      (
        await client.query(
          "SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now",
        )
      ).rows[0].now,
    );
    let retry = 0;
    for (const budget of budgets) {
      const row = (
        await client.query(
          "SELECT count, extract(epoch FROM reset_at) * 1000 AS reset FROM autopsy_limits WHERE key=$1",
          [budget.key],
        )
      ).rows[0];
      if (row && Number(row.count) + (budget.cost ?? 1) > budget.limit)
        retry = Math.max(retry, Math.ceil((Number(row.reset) - now) / 1000));
      if (!row && (budget.cost ?? 1) > budget.limit)
        retry = Math.max(retry, Math.ceil(budget.windowMs / 1000));
    }
    if (retry) return retry;
    for (const budget of budgets)
      await client.query(
        "INSERT INTO autopsy_limits(key,count,reset_at) VALUES($1,$2,to_timestamp($3 / 1000.0)) ON CONFLICT(key) DO UPDATE SET count=autopsy_limits.count + EXCLUDED.count",
        [budget.key, budget.cost ?? 1, now + budget.windowMs],
      );
    return 0;
  });

export function createLimiter(consume: Consume = consumeShared) {
  return {
    async request(req: Request, kind: "analysis" | "snapshot") {
      const identity = clientIdentity(req);
      return consume([
        {
          key: `${kind}:${identity}`,
          limit: kind === "analysis" ? 5 : 60,
          windowMs: 60000,
        },
      ]);
    },
    async analysis() {
      // Reserve worst-case GitHub cost BEFORE collection (metadata, pagination,
      // details, source/README/config reads). Covers all application instances.
      return consume([
        {
          key: "github:hour",
          limit: process.env.GITHUB_TOKEN ? 4500 : 50,
          windowMs: 3600000,
          cost: 50,
        },
        { key: "analysis:minute", limit: 10, windowMs: 60000 },
      ]);
    },
    async ai() {
      // 30 calls per hour, max_output_tokens=1800 and bounded evidence per call.
      return consume([{ key: "openai:hour", limit: 30, windowMs: 3600000 }]);
    },
  };
}
export const limiter = createLimiter();
