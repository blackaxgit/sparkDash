interface SparklineProps {
  data: readonly number[];
  /**
   * Coordinate-space width. With `stretch` this is the viewBox width only —
   * the rendered element still fills its container — so it stays the knob for
   * horizontal resolution (how much x-detail the path carries).
   */
  width?: number;
  height?: number;
  color?: string;
  /** When true, render a soft area-fill under the line. */
  area?: boolean;
  /**
   * Fill the container's width instead of rendering at a fixed pixel width.
   * Implemented with a viewBox + preserveAspectRatio="none", so x scales freely
   * while `vector-effect: non-scaling-stroke` keeps the line 1.5px regardless
   * of how far the box is stretched.
   */
  stretch?: boolean;
  /**
   * Unit suffix (e.g. "%", "°C"). When set, an SVG `<title>` tooltip reports
   * last / min / max / avg of the plotted samples in this unit.
   */
  unit?: string;
  /** Accessible name for the chart (sets role="img" + aria-label). */
  ariaLabel?: string;
}

/**
 * Lightweight inline-SVG sparkline. Optionally renders a translucent area
 * under the polyline so live rates read as a trend rather than a flat line.
 * A faint baseline grid hints at scale without adding chartjunk.
 */
export function Sparkline({
  data,
  width = 84,
  height = 24,
  color = "var(--color-accent)",
  area = true,
  stretch = false,
  unit,
  ariaLabel,
}: SparklineProps) {
  if (data.length < 2) {
    return (
      <div
        className={stretch ? "sparkline-box block w-full" : "sparkline-box inline-block"}
        style={{ ["--spark-w" as string]: `${width}px`, ["--spark-h" as string]: `${height}px` }}
      />
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const pad = 1.5;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - pad - ((v - min) / span) * (height - pad * 2);
    return `${x},${y}`;
  });
  const titleText =
    unit !== undefined
      ? (() => {
          const fmt = (v: number) => `${Number(v.toFixed(1))}${unit}`;
          const dMin = Math.min(...data);
          const dMax = Math.max(...data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          return `last ${fmt(data[data.length - 1])} · min ${fmt(dMin)} · max ${fmt(dMax)} · avg ${fmt(avg)}`;
        })()
      : null;

  const areaPath = `M0,${height} L${points.join(" L")} L${width},${height} Z`;
  const lineColor = color;
  const fillColor = `color-mix(in srgb, ${color} 16%, transparent)`;

  // Stretched: no width attribute — CSS w-full drives it, viewBox maps the
  // pixel coordinates above onto whatever width the flex row hands us.
  const frame = stretch
    ? { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", className: "block w-full" }
    : { width, className: "inline-block align-middle" };

  return (
    <svg
      height={height}
      {...frame}
      {...(ariaLabel ? { role: "img", "aria-label": ariaLabel } : {})}
    >
      {titleText && <title>{titleText}</title>}
      {area && (
        <path d={areaPath} fill={fillColor} stroke="none" vectorEffect="non-scaling-stroke" />
      )}
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
