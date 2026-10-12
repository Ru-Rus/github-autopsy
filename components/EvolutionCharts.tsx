import type { EvolutionHistory } from "@/types";

const number = new Intl.NumberFormat();

function monthLabel(month: string) {
  return new Date(month + "-01T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
  });
}

function MonthlyBars({
  data,
  labels,
  tones,
  description,
}: {
  data: { month: string; values: number[] }[];
  labels: string[];
  tones: string[];
  description: string;
}) {
  const max = Math.max(1, ...data.flatMap((item) => item.values));
  return (
    <div className="trend-chart" role="img" aria-label={description}>
      {data.map((item) => (
        <div className="trend-column" key={item.month}>
          <div className="trend-bars">
            {item.values.map((value, index) => (
              <span
                className={"trend-bar " + tones[index]}
                key={labels[index]}
                style={{
                  height: value ? Math.max(3, (value / max) * 100) + "%" : "0%",
                }}
                title={
                  monthLabel(item.month) +
                  ": " +
                  labels[index] +
                  " " +
                  number.format(value)
                }
              />
            ))}
          </div>
          <span className="trend-month">{monthLabel(item.month)}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ labels, tones }: { labels: string[]; tones: string[] }) {
  return (
    <div className="history-legend">
      {labels.map((label, index) => (
        <span key={label}>
          <i className={"legend-mark " + tones[index]} />
          {label}
        </span>
      ))}
    </div>
  );
}

export default function EvolutionCharts({
  evolution,
}: {
  evolution: EvolutionHistory;
}) {
  const net = evolution.code.at(-1)?.cumulativeNet ?? 0;
  const issueData = evolution.issues.map((month) => ({
    month: month.month,
    values: [month.opened, month.closed],
  }));
  const codeData = evolution.code.map((month) => ({
    month: month.month,
    values: [month.additions, month.deletions],
  }));
  const signedNet =
    evolution.codeSource === "unavailable"
      ? "n/a"
      : net > 0
        ? "+" + number.format(net)
        : number.format(net);

  return (
    <div className="history-grid">
      <section className="panel history-panel">
        <div className="panel-head"><div><small>LAST 12 MONTHS</small><h2>Active contributors</h2></div></div>
        <MonthlyBars data={evolution.contributors.map(item => ({ month: item.month, values: [item.contributors] }))} labels={["Contributors"]} tones={["added"]} description="Distinct identified contributors per month in sampled commits." />
        <p className="history-note">Distinct GitHub accounts in the recent commit sample. Unlinked authors are excluded; this is not a complete ownership history.</p>
      </section>
      <section className="panel history-panel">
        <div className="panel-head">
          <div>
            <small>LAST 12 MONTHS</small>
            <h2>Issue activity</h2>
          </div>
          <span>{number.format(evolution.issueSample)} issues sampled</span>
        </div>
        {evolution.issueSample ? (
          <MonthlyBars
            data={issueData}
            labels={["Opened", "Closed"]}
            tones={["added", "removed"]}
            description="Issues opened and closed by month in the sampled history."
          />
        ) : (
          <p className="empty">
            No issue history was returned for this period.
          </p>
        )}
        <Legend labels={["Opened", "Closed"]} tones={["added", "removed"]} />
        <p className="history-note">
          Counts come from up to {number.format(evolution.issueItemsSample)}{" "}
          recently updated repository items. Pull requests are not included.
          {evolution.issuesTruncated
            ? " The 400-item sample limit was reached."
            : ""}
        </p>
      </section>

      <section className="panel history-panel">
        <div className="panel-head">
          <div>
            <small>LINES ADDED AND REMOVED</small>
            <h2>Code changes</h2>
          </div>
          <div className="history-total">
            <small>NET IN VIEW</small>
            <b>{signedNet}</b>
          </div>
        </div>
        {evolution.codeSource !== "unavailable" ? (
          <MonthlyBars
            data={codeData}
            labels={["Added", "Removed"]}
            tones={["added", "removed"]}
            description="Lines added and removed by month in the sampled history."
          />
        ) : (
          <p className="empty">
            Line-change history is not available for this repository yet.
          </p>
        )}
        <Legend labels={["Added", "Removed"]} tones={["added", "removed"]} />
        <p className="history-note">
          {evolution.codeSource === "weekly-stats"
            ? "GitHub weekly change totals, grouped by month."
            : evolution.codeSource === "sampled-commits"
              ? "Fallback from up to 12 recent detailed commits."
              : "GitHub has not prepared these statistics yet."}{" "}
          Net change is not the repository's exact source-code size.
        </p>
      </section>
    </div>
  );
}
