import { useState } from "react";
import type { LlmMetrics, LlmRouterEvent } from "../../api/types";
import { routerLoad } from "../../api/client";
import { formatDuration } from "../../shared/formatDuration";

const SECTION = "space-y-1 border-t border-border pt-3";
const HEADING = "text-[10px] uppercase tracking-wide text-muted";
const MAX_EVENTS = 8;

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function eventText(e: LlmRouterEvent): string {
  if (e.state === "loading") return "loading…";
  if (e.state === "stopped") return "stopped";
  return e.loadMs != null ? `ready · loaded in ${formatDuration(e.loadMs)}` : "ready";
}

/**
 * llama-swap router observability: load control, request outcomes and model
 * swaps. Renders nothing on a non-router endpoint.
 */
export function RouterPanel({
  sparkId,
  llmPort,
  llm,
}: {
  sparkId: string;
  llmPort: number;
  llm: LlmMetrics;
}) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (llm.router !== "llama-swap") return null;

  const unloaded = (llm.routerModels ?? []).filter((m) => !m.loaded);
  const selected = unloaded.some((m) => m.id === choice) ? choice : (unloaded[0]?.id ?? "");
  const loading = llm.routerLoading ?? null;
  const activity = llm.routerActivity ?? null;
  const events = (llm.routerEvents ?? []).slice(0, MAX_EVENTS);

  const handleLoad = async () => {
    if (!selected) return;
    if (
      !confirm(
        `Load ${selected}? It evicts the current model; a cold load can take ~10 min. Renders holding the GPU lease are never interrupted.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await routerLoad(sparkId, llmPort, selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setBusy(false);
    }
  };

  const lastHour = activity?.lastHour;
  const lastHourTotal = lastHour ? lastHour.ok + lastHour.rejected + lastHour.failed : 0;
  const hourly = activity?.hourly ?? [];
  const total24h = hourly.reduce((n, b) => n + b.ok + b.rejected + b.failed, 0);
  const peak = Math.max(1, ...hourly.map((b) => b.ok + b.rejected + b.failed));
  const hasActivity = lastHourTotal > 0 || total24h > 0 || (activity?.recentErrors.length ?? 0) > 0;

  return (
    <>
      {(unloaded.length > 0 || loading || error) && (
        <div className={SECTION}>
          <div className={HEADING}>Load model</div>
          {(unloaded.length > 0 || loading) && (
            <div className="flex items-center gap-2">
              <select
                value={selected}
                onChange={(e) => setChoice(e.target.value)}
                disabled={busy || Boolean(loading)}
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
              >
                {unloaded.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? m.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleLoad()}
                disabled={busy || Boolean(loading) || !selected}
                className="shrink-0 rounded border border-border bg-surface-elevated px-2.5 py-1 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-50"
              >
                {busy ? "Loading…" : "Load"}
              </button>
            </div>
          )}
          {loading && <p className="text-[10px] text-muted">loading {loading}…</p>}
          {error && <p className="text-[10px] text-danger">{error}</p>}
        </div>
      )}

      {lastHour && hasActivity && (
        <div className={SECTION}>
          <div className={HEADING}>Requests</div>
          <div
            className={`text-xs font-tabular ${
              lastHour.rejected > 0 || lastHour.failed > 0 ? "text-danger" : "text-muted"
            }`}
            title="Last 60 minutes, from llama-swap's activity log"
          >
            {lastHour.ok} ok · {lastHour.rejected} rejected (429) · {lastHour.failed} failed
          </div>
          {hourly.length > 0 && (
            <div className="flex h-6 items-end gap-px" aria-hidden>
              {hourly.map((b) => {
                const bad = b.rejected + b.failed;
                return (
                  <div
                    key={b.hourStart}
                    className="flex h-full min-w-0 flex-1 flex-col-reverse"
                    title={`${hhmm(b.hourStart)} — ${b.ok} ok, ${b.rejected} rejected (429), ${b.failed} failed`}
                  >
                    {b.ok > 0 && (
                      <div
                        className="w-full bg-accent"
                        style={{ height: `${(b.ok / peak) * 100}%`, minHeight: 1 }}
                      />
                    )}
                    {bad > 0 && (
                      <div
                        className="w-full bg-danger"
                        style={{ height: `${(bad / peak) * 100}%`, minHeight: 1 }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {hourly.length > 0 && (
            <div className="text-[10px] text-muted">
              {activity?.truncated ? "last 999 requests" : "last 24 h"}
            </div>
          )}
          {activity && activity.recentErrors.length > 0 && (
            <div className="space-y-0.5 pt-1">
              {activity.recentErrors.slice(0, 5).map((e, i) => (
                <div
                  key={`${e.at}-${i}`}
                  className="truncate text-[10px] font-tabular text-danger"
                  title={e.message ?? undefined}
                >
                  {hhmm(e.at)} {e.model} {e.status}
                  {e.message ? ` ${e.message}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div className={SECTION}>
          <div className={HEADING}>Swaps</div>
          {events.map((e) => (
            <div key={`${e.at}-${e.model}-${e.state}`} className="truncate text-xs text-muted">
              <span className="font-tabular">{hhmm(e.at)}</span> {e.model}{" "}
              <span className={e.state === "ready" ? "text-text" : undefined}>{eventText(e)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
