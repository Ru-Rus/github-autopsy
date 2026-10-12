import { monitoringAuthorized, metricsText } from "@/observability";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  if (!monitoringAuthorized(req))
    return new Response("Unauthorized.", { status: 401 });
  return new Response(metricsText(), {
    headers: {
      "Content-Type": "text/plain; version=0.0.4",
      "Cache-Control": "no-store",
    },
  });
}
