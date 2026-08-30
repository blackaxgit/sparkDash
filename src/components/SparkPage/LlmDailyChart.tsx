import { useEffect, useState } from "react";
import { fetchLlmDaily } from "../../api/client";
import type { LlmDailyDay } from "../../api/types";

const CHART_W = 196;
const CHART_H = 36;
const POLL_MS = 60_000;

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * One series on its own scale. Decode peaks around tens of tok/s while prefill
 * reaches thousands, so a shared axis flattens decode to an invisible sliver.
 */
function SeriesChart({
  label,
  days,
  values,
  tooltips,
  fill,
  opacity,
}: {
  label: string;
  days: LlmDailyDay[];
  values: number[];
  tooltips: string[];
  fill: string;
  opacity: number;
}) {
  const max = Math.max(1, ...values);
  const slot = CHART_W / days.length;
  const gap = 1.5;
  const barW = Math.max(1.5, slot - gap);

  return (
    <div className="flex-1 min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-muted">{label}</span>
        <span className="text-[10px] tabular-nums text-muted">{fmt(max)}</span>
      </div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        height={CHART_H}
        className="block w-full"
        role="img"
        aria-label={`Daily peak ${label} tokens per second`}
      >
        {days.map((d, i) => {
          const h = (values[i] / max) * (CHART_H - 2);
          return (
            <g key={d.date}>
              <title>{tooltips[i]}</title>
              <rect
                x={i * slot}
                y={CHART_H - h}
                width={barW}
                height={h}
                fill={fill}
                opacity={opacity}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function LlmDailyChart({
  sparkId,
  llmPort,
}: {
  sparkId: string;
  llmPort: number;
}) {
  const [days, setDays] = useState<LlmDailyDay[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLlmDaily(sparkId, llmPort, 14)
        .then((res) => {
          if (!cancelled) setDays(res.days || []);
        })
        .catch(() => {
          if (!cancelled) setDays([]);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sparkId, llmPort]);

  if (!days || days.length === 0) return null;

  const hasSplit = days.some((d) => d.uncachedPrefillMax != null);
  const decodeVals = days.map((d) => d.decodeMax || 0);
  const prefillVals = days.map((d) =>
    hasSplit ? d.uncachedPrefillMax || 0 : d.prefillMax || 0
  );
  const prefillLabel = hasSplit ? "uncached prefill" : "prefill";

  const decodeTips = days.map(
    (d) => `${d.date} · decode peak ${fmt(d.decodeMax)} (avg ${fmt(d.decodeAvg)})`
  );
  const prefillTips = days.map((d) => {
    const peak = hasSplit ? d.uncachedPrefillMax : d.prefillMax;
    const avg = hasSplit ? d.uncachedPrefillAvg : d.prefillAvg;
    const base = `${d.date} · ${prefillLabel} peak ${fmt(peak)} (avg ${fmt(avg)})`;
    return hasSplit
      ? `${base} · cached prefill peak ${fmt(d.cachedPrefillMax)} (avg ${fmt(d.cachedPrefillAvg)})`
      : base;
  });

  const busy = days.some(
    (d) =>
      (d.decodeMax || 0) > 0 ||
      (d.prefillMax || 0) > 0 ||
      (d.uncachedPrefillMax || 0) > 0
  );

  return (
    <div className="border-t border-border pt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">
          Daily peak tok/s
        </span>
        <span className="text-[10px] text-muted">14d</span>
      </div>
      {!busy ? (
        <p className="text-[10px] text-muted">No busy samples in the last 14 days.</p>
      ) : (
        <div className="flex gap-4">
          <SeriesChart
            label="decode"
            days={days}
            values={decodeVals}
            tooltips={decodeTips}
            fill="var(--color-accent)"
            opacity={0.9}
          />
          <SeriesChart
            label={prefillLabel}
            days={days}
            values={prefillVals}
            tooltips={prefillTips}
            fill="var(--color-text)"
            opacity={0.45}
          />
        </div>
      )}
    </div>
  );
}
