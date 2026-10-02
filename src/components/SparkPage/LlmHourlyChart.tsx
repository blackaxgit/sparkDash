import { useEffect, useState } from "react";
import { fetchLlmHourly } from "../../api/client";
import type { LlmHourlyBucket } from "../../api/types";

/** Bar area height in px. Fixed rather than a rem utility because the root
 *  font-size is 121%, so `h-9` would render ~44px, not the 36px this chart
 *  has always been. */
const BAR_H = 36;
/** Height reserved for the per-hour number, in px. Reserved whether or not
 *  the labels are showing, so the chart does not change height between
 *  container widths. */
const LABEL_H = 12;
/** Bar width as a share of its hour slot, matching the previous SVG geometry
 *  (barW = slot - 1.5 at slot = 196/24). */
const BAR_W = "82%";
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
          {/*
            Plain elements rather than one stretched SVG: the old chart used
            preserveAspectRatio="none" on a 196-unit viewBox, so at panel width
            it scaled ~6x horizontally. Any <text> inside would have been
            stretched with it. Laying the bars out as boxes keeps the per-hour
            numbers at their real aspect.

            `@container` scopes the label query to this chart's own width, not
            the viewport, so the numbers appear or hide based on the space the
            chart actually got in its panel.
          */}
          <div
            className="@container"
            role="img"
            aria-label={`Tokens generated per hour over the last 24 hours. Total ${total.toLocaleString()}, peak ${max.toLocaleString()} in one hour.`}
          >
            <div className="flex items-end">
              {hours.map((h) => {
                const value = h.tokens || 0;
                const isPeak = value === max;
                /* an hour that carries a label should carry a mark, even when
                   it would round to a sub-pixel bar */
                const barPx = value > 0 ? Math.max(1, (value / max) * BAR_H) : 0;
                return (
                  <div
                    key={h.hour}
                    /* Fixed height with justify-end bottom-stacks the label
                       onto the bar, so the number rides its own bar's top edge
                       instead of floating in a fixed row far above a short bar.
                       basis-0 keeps every hour the same width: a wide label
                       like "119k" must not widen its own column. */
                    className="flex min-w-0 flex-1 basis-0 flex-col items-center justify-end"
                    style={{ height: BAR_H + LABEL_H }}
                    title={`${localHour(h.hour)} · ${value.toLocaleString()} tokens`}
                  >
                    {/*
                      Hidden below a 600px container, where 24 slots leave each
                      hour ~25px and the labels would collide. The title above
                      still carries the exact count at any width.
                      Idle hours render no label: two dozen zeroes is noise.
                    */}
                    <span
                      className={`hidden w-full whitespace-nowrap text-center font-tabular text-[9px] @min-[600px]:block ${
                        isPeak ? "text-muted-strong" : "text-muted"
                      }`}
                      style={{ height: LABEL_H, lineHeight: `${LABEL_H}px` }}
                    >
                      {value > 0 ? compact(value) : ""}
                    </span>
                    <div
                      className="bg-accent opacity-75"
                      style={{ width: BAR_W, height: barPx }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
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
