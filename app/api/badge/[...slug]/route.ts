import { NextResponse } from "next/server";
import { snapshotStore } from "@/snapshot-store";

export const dynamic = "force-dynamic";

function generateBadge(score: number | null): string {
  let color = "#6e7681";
  let label = "unrated";

  if (score !== null && !isNaN(score)) {
    label = `${Math.round(score)}/100`;
    if (score >= 80) color = "#2ea44f";
    else if (score >= 60) color = "#d97706";
    else color = "#cb2431";
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="20" role="img" aria-label="autopsy: ${label}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="140" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="60" height="20" fill="#24292f"/>
    <rect x="60" width="80" height="20" fill="${color}"/>
    <rect width="140" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="30" y="15" fill="#010101" fill-opacity=".3">autopsy</text>
    <text x="30" y="14">autopsy</text>
    <text x="100" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="100" y="14">${label}</text>
  </g>
</svg>`;
}

export async function GET(
  _req: Request,
  props: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await props.params;
  if (!slug || slug.length < 2) {
    return new NextResponse(generateBadge(null), {
      status: 400,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const owner = slug[0];
  const name = slug[1].replace(/\.svg$/i, "");
  const repository = `${owner}/${name}`.toLowerCase();

  let score: number | null = null;
  try {
    const list = await snapshotStore.list(repository);
    if (list && list.length > 0) {
      score = list[list.length - 1].score;
    }
  } catch {
    // Return unrated badge on database failure
  }

  return new NextResponse(generateBadge(score), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
    },
  });
}
