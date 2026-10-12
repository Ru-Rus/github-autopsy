export type Key =
  | "codeQuality"
  | "documentation"
  | "testing"
  | "activity"
  | "issueHygiene";
export interface Repo {
  has_issues?: boolean;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string | null;
  created_at: string;
  pushed_at: string | null;
  archived: boolean;
  license: { spdx_id: string; name: string } | null;
}
export interface Category {
  key: Key;
  label: string;
  score: number | null;
  summary: string;
  evidence: string[];
}
export interface Finding {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  evidence: string;
  explanation: string;
  recommendation: string;
  confidence: "high" | "medium" | "low";
}
export interface EvolutionHistory {
  contributors: { month: string; contributors: number }[];
  issues: { month: string; opened: number; closed: number }[];
  code: {
    month: string;
    additions: number;
    deletions: number;
    net: number;
    cumulativeNet: number;
  }[];
  codeSource: "weekly-stats" | "sampled-commits" | "unavailable";
  issueSample: number;
  issueItemsSample: number;
  issuesTruncated: boolean;
}
export interface ModuleMap {
  nodes: { id: string; label: string; files: number }[];
  edges: { from: string; to: string; imports: number }[];
  scannedFiles: number;
  totalSourceFiles: number;
  moduleCount: number;
  collapsedModules: number;
}

export interface Report {
  history?: SnapshotSummary[];
  aiReview?: import("./ai-review").AIReview;
  snapshotId?: string;
  revision?: string;
  analyzedAt: string;
  repository: Repo;
  scores: Record<Key, number | null> & { overall: number | null };
  categories: Category[];
  findings: Finding[];
  metrics: {
    syntax: {
      functions: number;
      classes: number;
      branches: number;
      imports: number;
      exports: number;
    };
    totalFiles: number;
    sourceFiles: number;
    testFiles: number;
    ratio: number;
    largeFiles: number;
    todoCount: number;
    scannedFiles: number;
    sampledCommits: number;
    sampledPulls: number;
    mergedPulls: number;
    openPulls: number;
    activeMonths: number;
    longestGap: number;
    oldestIssue: number;
    staleIssues: number;
    issueSample: number;
    contributors: number;
    languages: { name: string; share: number }[];
    hotspots: { path: string; commits: number }[];
  };
  timeline: { month: string; commits: number }[];
  evolution: EvolutionHistory;
  moduleMap: ModuleMap;
  contributorList: { login: string; contributions: number }[];
  caveats: string[];
}
export interface SnapshotSummary {
  id: string;
  repository: string;
  analyzedAt: string;
  revision?: string;
  score: number | null;
  sourceFiles: number;
  testFiles: number;
  contributors: number;
}
