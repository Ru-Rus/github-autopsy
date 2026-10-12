"use client";
import { useState } from "react";
import type { Report } from "@/types";
import { healthLabel, scoring } from "@/scoring";
import EvolutionCharts from "./EvolutionCharts";
import ProjectMap from "./ProjectMap";
const tone = (n: number | null) =>
  n === null
    ? "unknown"
    : n >= scoring.thresholds.healthy
      ? "good"
      : n >= scoring.thresholds.risky
        ? "watch"
        : "risk";
const date = (d: string) =>
  new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
export default function ReportView({
  report: r,
  onNew,
  onShare,
  onDownload,
  copied,
  error,
  onSnapshot,
}: {
  report: Report;
  onNew: () => void;
  onShare: () => void;
  onDownload: () => void;
  copied: boolean;
  error: string;
  onSnapshot: (id: string) => void;
}) {
  const [tab, setTab] = useState<"overview" | "evolution" | "map">("overview"),
    max = Math.max(1, ...r.timeline.map((x) => x.commits)),
    points = r.timeline
      .map(
        (x, i) =>
          `${(i * 100) / Math.max(1, r.timeline.length - 1)},${94 - (x.commits / max) * 72}`,
      )
      .join(" ");
  return (
    <section className="report">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <nav className="report-nav">
        <button onClick={onNew}>← New analysis</button>
        <div>
          <button onClick={onShare}>
            {copied ? "Link copied ✓" : "↗ Share report"}
          </button>
          <button onClick={onDownload}>↓ Export JSON</button>
        </div>
      </nav>
      <div className="patient">
        <div>
          <div className="eyebrow">
            <span>REPOSITORY AUTOPSY</span>
            <i />
          </div>
          <h1>{r.repository.full_name}</h1>
          <p>
            {r.repository.description || "No repository description provided."}
          </p>
          <div className="repo-meta">
            <span>
              ★ {r.repository.stargazers_count.toLocaleString()} stars
            </span>
            <span>⑂ {r.repository.forks_count.toLocaleString()} forks</span>
            <span>Created {date(r.repository.created_at)}</span>
            {r.repository.archived && <b>ARCHIVED</b>}
          </div>
        </div>
        <div
          className={
            "overall " +
            (r.scores.overall === null ? "unknown" : tone(r.scores.overall))
          }
        >
          <div className="ring">
            <strong>
              {r.scores.overall === null ? "—" : r.scores.overall}
            </strong>
            <small>/100</small>
          </div>
          <span>OVERALL HEALTH</span>
          <b>
            {r.scores.overall === null
              ? "Insufficient data"
              : healthLabel(r.scores.overall)}
          </b>
        </div>
      </div>
      <div className="tabs">
        <button
          className={tab === "overview" ? "active" : ""}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          className={tab === "evolution" ? "active" : ""}
          onClick={() => setTab("evolution")}
        >
          Repository evolution <small>{r.metrics.sampledCommits}</small>
        </button>
        <button
          className={tab === "map" ? "active" : ""}
          onClick={() => setTab("map")}
        >
          Project map <small>{r.moduleMap.edges.length}</small>
        </button>
        <span>ANALYZED {date(r.analyzedAt)}</span>
      </div>
      {tab === "overview" ? (
        <>
          <div className="score-grid">
            {r.categories.map((c, i) => (
              <article className="score-card" key={c.key}>
                <div>
                  <small>0{i + 1} / 05</small>
                  <b className={tone(c.score)}>
                    {c.score === null ? "—" : c.score}
                  </b>
                </div>
                <h3>{c.label}</h3>
                <p>{c.summary}</p>
                <div className="track">
                  <i
                    className={tone(c.score)}
                    style={{ width: (c.score ?? 0) + "%" }}
                  />
                </div>
              </article>
            ))}
          </div>
          <div className="content-grid">
            {r.aiReview && <section className="panel">
              <small>AI EXPLANATION OF MEASURED EVIDENCE</small>
              <h2>Engineering review</h2>
              <p>{r.aiReview.summary}</p>
              {r.aiReview.risks.map(risk => <article className="finding" key={risk.findingId}><div>
                <h3>{r.findings.find(finding => finding.id === risk.findingId)?.title}</h3>
                <p className="evidence">{r.findings.find(finding => finding.id === risk.findingId)?.evidence}</p>
                <p>{risk.why}</p><p><b>Recommended action: </b>{risk.action}</p>
                <p><b>Potential impact: </b>{risk.impact}</p><small>CONFIDENCE {risk.confidence.toUpperCase()}</small>
              </div></article>)}
              {r.aiReview.caveats.map((caveat, index) => <p className="muted" key={index}>{caveat}</p>)}
            </section>}
            <section className="panel">
              <div className="panel-head">
                <div>
                  <small>EVIDENCE REVIEW</small>
                  <h2>Engineering findings</h2>
                </div>
                <span>{r.findings.length} signals</span>
              </div>
              {r.findings.length ? (
                r.findings.map((f) => (
                  <article className="finding" key={f.id}>
                    <b className={"severity " + f.severity}>{f.severity}</b>
                    <div>
                      <h3>{f.title}</h3>
                      <p className="evidence">{f.evidence}</p>
                      <p>{f.explanation}</p>
                      <div className="recommendation">
                        <b>Next step</b>
                        {f.recommendation}
                      </div>
                      <small>CONFIDENCE {f.confidence.toUpperCase()}</small>
                    </div>
                  </article>
                ))
              ) : (
                <p className="empty">✓ No findings to display.</p>
              )}
            </section>
            <aside className="panel">
              <small>REPOSITORY SNAPSHOT</small>
              <h2>Measured signals</h2>
              {[
                ["Tracked files", r.metrics.totalFiles],
                ["Source files", r.metrics.sourceFiles],
                ["Test-like files", r.metrics.testFiles],
                ["Recent commits sampled", r.metrics.sampledCommits],
                ["Pull requests sampled", r.metrics.sampledPulls],
                ["Merged pull requests", r.metrics.mergedPulls],
                ["Contributors returned", r.metrics.contributors],
                [
                  "Oldest sampled issue",
                  r.metrics.oldestIssue ? r.metrics.oldestIssue + "d" : "—",
                ],
              ].map(([a, b]) => (
                <div className="metric" key={a}>
                  <span>{a}</span>
                  <b>{b}</b>
                </div>
              ))}
              <div className="languages">
                <small>LANGUAGES BY BYTES</small>
                {r.metrics.languages.map((x) => (
                  <div className="language" key={x.name}>
                    <span>{x.name}</span>
                    <i>
                      <b style={{ width: x.share + "%" }} />
                    </i>
                    <strong>{x.share}%</strong>
                  </div>
                ))}
              </div>
              <div className="weights">
                <small>OVERALL SCORE WEIGHTS</small>
                <p>
                  Code {Math.round(scoring.weights.codeQuality * 100)}% · Docs{" "}
                  {Math.round(scoring.weights.documentation * 100)}% · Testing{" "}
                  {Math.round(scoring.weights.testing * 100)}% · Activity{" "}
                  {Math.round(scoring.weights.activity * 100)}% · Issues{" "}
                  {Math.round(scoring.weights.issueHygiene * 100)}%
                </p>
              </div>
            </aside>
          </div>
          <section className="panel evidence-panel">
            <small>WHY THESE SCORES?</small>
            <h2>Evidence by category</h2>
            <div className="evidence-grid">
              {r.categories.map((c) => (
                <article key={c.key}>
                  <h3>
                    <b className={tone(c.score)}>
                      {c.score === null ? "—" : c.score}
                    </b>
                    {c.label}
                  </h3>
                  <ul>
                    {c.evidence.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : tab === "evolution" ? (
        <div className="evolution">
          {!!r.history?.length && <section className="panel">
            <small>SAVED ANALYSES</small><h2>Health history and comparisons</h2>
            <p className="muted">Each row is a measured analysis saved on its date. Changes compare consecutive saved samples; no past health scores are inferred.</p>
            {r.history.map((snapshot, index) => {
              const previous = r.history?.[index - 1];
              return <div className="metric" key={snapshot.id}>
                <button onClick={() => onSnapshot(snapshot.id)}>{date(snapshot.analyzedAt)} · {snapshot.revision?.slice(0, 7) ?? "No revision"}</button>
                <span>Health {snapshot.score ?? "n/a"} · {snapshot.sourceFiles} sources · {snapshot.testFiles} tests · {snapshot.contributors} contributors{previous ? ` · Δ sources ${snapshot.sourceFiles - previous.sourceFiles}, tests ${snapshot.testFiles - previous.testFiles}` : ""}</span>
              </div>;
            })}
          </section>}
          <section className="panel chart-panel">
            <div className="panel-head">
              <div>
                <small>LAST 12 MONTHS</small>
                <h2>Commit activity</h2>
              </div>
              <span>● commits / month</span>
            </div>
            <div className="chart">
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-label="Commit timeline"
              >
                <line x1="0" y1="22" x2="100" y2="22" />
                <line x1="0" y1="58" x2="100" y2="58" />
                <line x1="0" y1="94" x2="100" y2="94" />
                <polyline points={points} />
              </svg>
            </div>
            <div className="months">
              {r.timeline
                .filter((_, i) => i % 3 === 0)
                .map((x) => (
                  <span key={x.month}>
                    {new Date(x.month + "-01").toLocaleDateString(undefined, {
                      month: "short",
                      year: "2-digit",
                    })}
                  </span>
                ))}
            </div>
            <p className="muted">
              Counts group the recent commit sample by author date.
            </p>
          </section>
          <section className="panel">
            <small>CONTRIBUTION COUNTS</small>
            <h2>Contributors</h2>
            {r.contributorList.map((x) => (
              <div className="person" key={x.login}>
                <div>
                  <span>{x.login}</span>
                  <b>{x.contributions.toLocaleString()}</b>
                </div>
                <i>
                  <b
                    style={{
                      width:
                        (100 * x.contributions) /
                          (r.contributorList[0]?.contributions || 1) +
                        "%",
                    }}
                  />
                </i>
              </div>
            ))}
            <p className="muted">
              Commit counts do not establish code ownership or bus factor.
            </p>
          </section>
          <EvolutionCharts evolution={r.evolution} />
          <section className="panel hotspot-panel">
            <small>LATEST DETAILED COMMITS</small>
            <h2>Frequently changed files</h2>
            {r.metrics.hotspots.length ? (
              r.metrics.hotspots.map((x, i) => (
                <div className="hotspot" key={x.path}>
                  <span>0{i + 1}</span>
                  <code>{x.path}</code>
                  <b>{x.commits} commits</b>
                </div>
              ))
            ) : (
              <p className="muted">No file-change details returned.</p>
            )}
          </section>
        </div>
      ) : (
        <ProjectMap map={r.moduleMap} />
      )}
      <section className="caveats">
        <b>READ WITH CARE</b>
        <div>
          {r.caveats.map((x, i) => (
            <p key={i}>{x}</p>
          ))}
        </div>
      </section>
      <footer className="report-footer">
        <span>GITHUB AUTOPSY · SIGNALS, NOT VERDICTS</span>
        <button onClick={onNew}>Analyze another repository →</button>
      </footer>
    </section>
  );
}
