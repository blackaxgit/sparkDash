import { useEffect, useState } from "react";
import { fetchLlmHourly } from "../../api/client";
import type { LlmHourlyBucket } from "../../api/types";

const CHART_W = 196;
const CHART_H = 36;
const POLL_MS = 60_000;
const HOURS = 24;

function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** "2026-08-29T14" (UTC) → local hour label. */
function localHour(hour: string): string {
  const d = new Date(`${hour}:00:00Z`);
  if (Number.isNaN(d.getTime())) return hour;
  return d.toLocaleTimeString([], { hour: "numeric" });
}

export function LlmHourlyChart({
  sparkId,
  llmPort,
}: {
  sparkId: string;
  llmPort: number;
}) {
  const [hours, setHours] = useState<LlmHourlyBucket[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLlmHourly(sparkId, llmPort, HOURS)
        .then((res) => {
          if (!cancelled) setHours(res.hours || []);
        })
        .catch(() => {
          if (!cancelled) setHours([]);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sparkId, llmPort]);

  if (!hours || hours.length === 0) return null;

  const total = hours.reduce((sum, h) => sum + (h.tokens || 0), 0);
  const max = Math.max(1, ...hours.map((h) => h.tokens || 0));
  const slot = CHART_W / hours.length;
  const barW = Math.max(1.5, slot - 1.5);

  return (
    <div className="border-t border-border pt-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">
          Tokens generated
        </span>
        <span className="text-[10px] text-muted">
          {total > 0 ? `${total.toLocaleString()} · 24h` : "24h"}
        </span>
      </div>
      {total === 0 ? (
        <p className="text-[10px] text-muted">No tokens generated in the last 24 hours.</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            preserveAspectRatio="none"
            height={CHART_H}
            className="block w-full"
            role="img"
            aria-label="Tokens generated per hour over the last 24 hours"
          >
            {hours.map((h, i) => {
              const value = h.tokens || 0;
              const barH = (value / max) * (CHART_H - 2);
              return (
                <g key={h.hour}>
                  <title>{`${localHour(h.hour)} · ${value.toLocaleString()} tokens`}</title>
                  <rect
                    x={i * slot}
                    y={CHART_H - barH}
                    width={barW}
                    height={barH}
                    fill="var(--color-accent)"
                    opacity={0.75}
                  />
                </g>
              );
            })}
          </svg>
          <div className="flex justify-between text-[10px] text-muted">
            <span>{localHour(hours[0].hour)}</span>
            <span>peak {compact(max)}/h</span>
            <span>now</span>
          </div>
        </>
      )}
    </div>
  );
}
