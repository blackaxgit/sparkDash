import { useEffect, useRef, useState } from "react";

export interface TrendSeries {
  /** [timestampMs, value | null] oldest first; null breaks the line. */
  points: [number, number | null][];
  color: string;
  label: string;
}

interface TrendChartProps {
  series: TrendSeries[];
  /** Plot height in px (axis labels are added below). */
  height?: number;
  unit?: string;
  format?: (v: number) => string;
  min?: number;
  max?: number;
}

const GUTTER = 44; // left space for y-axis labels
const AXIS_H = 16; // bottom space for x-axis labels
const PAD_R = 6;
const DAY_MS = 24 * 3600_000;

function formatTime(ts: number, withDay: boolean): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withDay ? `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}` : hm;
}

function defaultFormat(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Index of the point whose timestamp is closest to `ts` (points are sorted). */
function nearestIndex(points: [number, number | null][], ts: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && ts - points[lo - 1][0] < points[lo][0] - ts) lo--;
  return lo;
}

/**
 * Multi-series time chart: responsive width, y min/max labels, start/middle/end
 * time labels, gaps at nulls, hover crosshair + tooltip. All series are drawn
 * against one shared time axis and one shared value axis.
 */
export function TrendChart({
  series,
  height = 72,
  unit = "",
  format = defaultFormat,
  min,
  max,
}: TrendChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(120, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const values: number[] = [];
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of series) {
    for (const [t, v] of s.points) {
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
      if (v !== null) values.push(v);
    }
  }

  const fmt = (v: number) => `${format(v)}${unit}`;

  if (values.length === 0) {
    return (
      <div
        ref={wrapRef}
        className="flex w-full items-center justify-center text-xs text-muted"
        style={{ height: height + AXIS_H }}
        role="img"
        aria-label="No data yet"
      >
        No data yet
      </div>
    );
  }

  const lo = min ?? Math.min(...values);
  let hi = max ?? Math.max(...values);
  if (hi <= lo) hi = lo + 1;

  const plotW = Math.max(1, width - GUTTER - PAD_R);
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => GUTTER + ((t - t0) / span) * plotW;
  const y = (v: number) => height - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * height;

  const withDay = span > DAY_MS;
  const paths = series.map((s) => {
    let d = "";
    let run: [number, number][] = [];
    const flushRun = () => {
      if (run.length === 1) d += `M${run[0][0].toFixed(1)},${run[0][1].toFixed(1)}h0.1`;
      else if (run.length > 1) {
        d += "M" + run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L");
      }
      run = [];
    };
    for (const [t, v] of s.points) {
      if (v === null) flushRun();
      else run.push([x(t), y(v)]);
    }
    flushRun();
    return d;
  });

  const summary = series
    .map((s) => {
      const last = [...s.points].reverse().find(([, v]) => v !== null);
      return `${s.label} ${last ? fmt(last[1] as number) : "no data"}`;
    })
    .join(", ");

  const ref = series.reduce((a, b) => (b.points.length > a.points.length ? b : a), series[0]);
  const hoverT = hoverTs === null ? null : ref.points[nearestIndex(ref.points, hoverTs)][0];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const frac = Math.min(1, Math.max(0, (px - GUTTER) / plotW));
    setHoverTs(t0 + frac * span);
    setHoverX(px);
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        width={width}
        height={height + AXIS_H}
        role="img"
        aria-label={summary}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverTs(null)}
        className="block"
      >
        <line x1={GUTTER} x2={GUTTER + plotW} y1={0} y2={0} stroke="var(--color-grid)" />
        <line x1={GUTTER} x2={GUTTER + plotW} y1={height} y2={height} stroke="var(--color-border)" />
        <text x={GUTTER - 4} y={8} textAnchor="end" fontSize={9} fill="var(--color-muted)">
          {fmt(hi)}
        </text>
        <text x={GUTTER - 4} y={height} textAnchor="end" fontSize={9} fill="var(--color-muted)">
          {fmt(lo)}
        </text>
        <text x={GUTTER} y={height + 12} textAnchor="start" fontSize={9} fill="var(--color-muted)">
          {formatTime(t0, withDay)}
        </text>
        <text
          x={GUTTER + plotW / 2}
          y={height + 12}
          textAnchor="middle"
          fontSize={9}
          fill="var(--color-muted)"
        >
          {formatTime(t0 + span / 2, withDay)}
        </text>
        <text x={GUTTER + plotW} y={height + 12} textAnchor="end" fontSize={9} fill="var(--color-muted)">
          {formatTime(t1, withDay)}
        </text>
        {series.map((s, i) => (
          <path
            key={s.label}
            d={paths[i]}
            fill="none"
            stroke={s.color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {hoverT !== null && (
          <line
            x1={x(hoverT)}
            x2={x(hoverT)}
            y1={0}
            y2={height}
            stroke="var(--color-muted)"
            strokeDasharray="2 2"
          />
        )}
      </svg>
      {hoverT !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded border border-border bg-surface-elevated px-2 py-1 text-[10px] text-text shadow"
          style={hoverX > width / 2 ? { right: width - hoverX + 8 } : { left: hoverX + 8 }}
        >
          <div className="text-muted">{formatTime(hoverT, withDay)}</div>
          {series.map((s) => {
            const p = s.points[nearestIndex(s.points, hoverT)];
            return (
              <div key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: s.color }}
                />
                <span className="text-muted">{s.label}</span>
                <span className="font-tabular">{p && p[1] !== null ? fmt(p[1]) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
