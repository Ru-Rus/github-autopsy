import type { ModuleMap as ModuleMapData } from "@/types";

interface Point {
  id: string;
  label: string;
  files: number;
  x: number;
  y: number;
}

function shortLabel(label: string) {
  return label.length > 19 ? label.slice(0, 16) + "..." : label;
}

export default function ProjectMap({ map }: { map: ModuleMapData }) {
  const centerX = 320;
  const centerY = 190;
  const radiusX = 205;
  const radiusY = 130;
  const points: Point[] = map.nodes.map((node, index) => {
    const angle =
      -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, map.nodes.length);
    return {
      ...node,
      x: map.nodes.length === 1 ? centerX : centerX + radiusX * Math.cos(angle),
      y: map.nodes.length === 1 ? centerY : centerY + radiusY * Math.sin(angle),
    };
  });
  const byId = new Map(points.map((point) => [point.id, point]));

  return (
    <section className="panel module-panel">
      <div className="panel-head">
        <div>
          <small>LOCAL SOURCE LINKS</small>
          <h2>Project parts map</h2>
        </div>
        <span>
          {map.nodes.length} groups, {map.edges.length} links
        </span>
      </div>
      {!map.nodes.length ? (
        <p className="empty">No source files were available to map.</p>
      ) : (
        <>
          <p className="history-note">
            Each group combines nearby folders. An arrow means files in one
            group import files from another.
          </p>
          <div className="module-map-scroll">
            <svg
              className="module-map-svg"
              viewBox="0 0 640 380"
              role="img"
              aria-label={
                map.nodes.length +
                " project groups and " +
                map.edges.length +
                " detected import links"
              }
            >
              <defs>
                <marker
                  id="module-map-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              {map.edges.map((edge) => {
                const from = byId.get(edge.from);
                const to = byId.get(edge.to);
                if (!from || !to) return null;
                const dx = to.x - from.x;
                const dy = to.y - from.y;
                const length = Math.max(1, Math.hypot(dx, dy));
                const ux = dx / length;
                const uy = dy / length;
                const x1 = from.x + ux * 68;
                const y1 = from.y + uy * 23;
                const x2 = to.x - ux * 68;
                const y2 = to.y - uy * 23;
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;
                return (
                  <g className="module-edge" key={edge.from + "-" + edge.to}>
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      markerEnd="url(#module-map-arrow)"
                    />
                    <g className="module-edge-count">
                      <rect
                        x={midX - 13}
                        y={midY - 9}
                        width="26"
                        height="18"
                        rx="8"
                      />
                      <text x={midX} y={midY + 3}>
                        {edge.imports}
                      </text>
                    </g>
                  </g>
                );
              })}
              {points.map((point) => (
                <g className="module-node" key={point.id}>
                  <rect
                    x={point.x - 68}
                    y={point.y - 23}
                    width="136"
                    height="46"
                    rx="7"
                  />
                  <text className="module-label" x={point.x} y={point.y - 2}>
                    {shortLabel(point.label)}
                  </text>
                  <text className="module-files" x={point.x} y={point.y + 13}>
                    {point.files} source files
                  </text>
                </g>
              ))}
            </svg>
          </div>
          {map.edges.length ? (
            <ul className="module-links">
              {map.edges.map((edge) => (
                <li key={edge.from + "-" + edge.to}>
                  <span>{byId.get(edge.from)?.label ?? edge.from}</span>
                  <i aria-hidden="true">→</i>
                  <span>{byId.get(edge.to)?.label ?? edge.to}</span>
                  <b>{edge.imports} scanned files</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              No local links were resolved in the scanned JavaScript or
              TypeScript files.
            </p>
          )}
          <p className="history-note">
            Scanned {map.scannedFiles} of {map.totalSourceFiles} source files.
            {map.collapsedModules
              ? " " + map.collapsedModules + " smaller groups are combined."
              : ""}{" "}
            Only static local imports are counted.
          </p>
        </>
      )}
    </section>
  );
}
