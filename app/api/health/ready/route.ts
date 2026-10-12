import { NextResponse } from "next/server";
import { readiness } from "@/readiness";
import { event, monitoringAuthorized } from "@/observability";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!monitoringAuthorized(req))
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const result = await readiness();
  if (!result.ready) event("readiness_failed");
  return NextResponse.json(result, {
    status: result.ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
