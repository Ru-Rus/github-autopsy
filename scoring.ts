export const scoring = {
  weights: {
    codeQuality: 0.25,
    documentation: 0.15,
    testing: 0.25,
    activity: 0.2,
    issueHygiene: 0.15,
  },
  thresholds: { excellent: 90, healthy: 75, attention: 60, risky: 40 },
} as const;
export function healthLabel(score: number) {
  if (score >= scoring.thresholds.excellent) return "Excellent";
  if (score >= scoring.thresholds.healthy) return "Healthy";
  if (score >= scoring.thresholds.attention) return "Needs attention";
  if (score >= scoring.thresholds.risky) return "Risky";
  return "Critical";
}
