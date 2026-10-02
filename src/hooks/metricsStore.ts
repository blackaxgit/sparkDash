import { useSyncExternalStore } from "react";
import type { SparkSnapshot } from "../api/types";

/**
 * Central metrics history store (idea #8b).
 *
 * Fed once per WebSocket snapshot by useSnapshot. Components read time-series
 * via `useMetricsHistory` / `useMetricsHistoryTail` — a single source of truth that:
 *   - survives Spark tab switches (history is no longer per-panel useState),
 *   - caps each series at HISTORY_MAX samples,
 *   - lets future time-range charts read from one place,
 *   - keeps sparklines on a short tail (SPARKLINE_TAIL) so 84px charts stay readable.
 *
 * Seeded on connect by `hydrateHistory` from the server's ring buffer
 * (server/collectors/MetricsHistory.js), so the charts open with real history
 * instead of filling up from an empty tab at one sample per second.
 *
 * Also keeps the latest snapshot per spark (`getSpark` / `useSpark`) as the
 * selective-subscription seam (#8a).
 *
 * Reference-stability contract (required by useSyncExternalStore):
 * getSnapshot returns a *cached* value that only changes when that slice
 * actually changed. On each ingest we replace the history array with a new ref
 * (slice + append), so subscribers to that key re-render and all others skip.
 * All listeners are woken on notify; unchanged keys keep the same ref → no render.
 *
 * TIMING CONTRACT: `historyTimes` holds one timestamp per sample, index-aligned
 * with the values and trimmed in lockstep, so `useSeriesStart` can report how
 * much wall-clock time a chart actually spans. Sample count alone cannot: an
 * offline host stops contributing samples while time keeps passing, so
 * `length x pollInterval` would under-report the age of the leftmost point.
 */

/**
 * Samples kept per series. 1 h at the 1 s floor on pollIntervalMs (the live
 * setting), 2 h at 2 s. Must be >= the server's MAX_SAMPLES in
 * server/collectors/MetricsHistory.js, otherwise hydration would be truncated
 * on arrival and the tab would show less than the server actually has.
 */
const HISTORY_MAX = 3600;
/** Samples shown in inline sparklines (≈30 s at the 1 s poll). Full series stays in HISTORY_MAX. */
export const SPARKLINE_TAIL = 30;
/** Cadence assumed only when the server sent no timing metadata for a series. */
const FALLBACK_STEP_MS = 1000;

const history = new Map<string, number[]>(); // key: `${sparkId}:${metric}`
/** Sample timestamps, index-aligned with `history` — see TIMING CONTRACT. */
const historyTimes = new Map<string, number[]>();
/** Cached last-N views — refreshed whenever the full series is replaced. */
const historyTails = new Map<string, readonly number[]>();
const sparkMap = new Map<string, SparkSnapshot>();
const listeners = new Set<() => void>();

const EMPTY: readonly number[] = Object.freeze([] as number[]);

function notify() {
  for (const l of listeners) l();
}

export function subscribeMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setHistoryTail(key: string, full: number[]) {
  if (full.length === 0) {
    historyTails.delete(key);
    return;
  }
  // Share the full ref when short enough — one allocation, both hooks see the same array.
  historyTails.set(key, full.length <= SPARKLINE_TAIL ? full : full.slice(-SPARKLINE_TAIL));
}

function pushHistory(key: string, value: number, at: number) {
  const prev = history.get(key);
  const prevTimes = historyTimes.get(key);
  // Build a fresh ref so useSyncExternalStore observes the change for this key.
  let next: number[];
  let nextTimes: number[];
  if (!prev || prev.length === 0) {
    next = [value];
    nextTimes = [at];
  } else if (prev.length >= HISTORY_MAX) {
    const from = prev.length - HISTORY_MAX + 1;
    next = prev.slice(from);
    next.push(value);
    nextTimes = (prevTimes ?? []).slice(from);
    nextTimes.push(at);
  } else {
    next = prev.slice();
    next.push(value);
    nextTimes = (prevTimes ?? []).slice();
    nextTimes.push(at);
  }
  history.set(key, next);
  historyTimes.set(key, nextTimes);
  setHistoryTail(key, next);
}

function removeHistoryForSpark(sparkId: string) {
  const prefix = `${sparkId}:`;
  for (const key of history.keys()) {
    if (key.startsWith(prefix)) {
      history.delete(key);
      historyTimes.delete(key);
      historyTails.delete(key);
    }
  }
}

/**
 * Rebuild per-sample timestamps for a hydrated series from the server's
 * [first, last] pair. Both endpoints are real readings, so the age label — the
 * only consumer — is exact; the interpolated interior is replaced by real
 * timestamps as new samples arrive.
 */
function timesForHydrated(n: number, pair: readonly number[] | undefined): number[] {
  const t0 = pair?.[0];
  const tLast = pair?.[1];
  if (typeof t0 !== "number" || typeof tLast !== "number" || !(tLast >= t0)) {
    const end = Date.now();
    return Array.from({ length: n }, (_, i) => end - (n - 1 - i) * FALLBACK_STEP_MS);
  }
  if (n === 1) return [tLast];
  const step = (tLast - t0) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(t0 + i * step));
}

/**
 * Seed series from the server's ring buffer, sent once per WS connection.
 *
 * Keys are produced by the server key-for-key with `ingestSnapshots` below;
 * anything unrecognized is simply never read.
 *
 * A shorter server series never replaces a longer local one. That matters on
 * reconnect: the tab may already hold samples the server lost to a restart,
 * and overwriting them would visibly shorten a chart that was full a second
 * earlier. When the server has more, it is strictly the better source — it
 * spans page loads and other tabs.
 */
export function hydrateHistory(
  series: Record<string, number[]> | undefined,
  meta?: Record<string, number[]>
): void {
  if (!series || typeof series !== "object") return;
  let changed = false;

  for (const [key, raw] of Object.entries(series)) {
    if (!Array.isArray(raw)) continue;
    const clean = raw.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (clean.length === 0) continue;
    const existing = history.get(key);
    if (existing && existing.length >= clean.length) continue;
    const next = clean.length > HISTORY_MAX ? clean.slice(-HISTORY_MAX) : clean;
    history.set(key, next);
    historyTimes.set(key, timesForHydrated(next.length, meta?.[key]));
    setHistoryTail(key, next);
    changed = true;
  }

  if (changed) notify();
}

/** Ingest a full WS snapshot: update latest-per-spark + append history series. */
export function ingestSnapshots(sparks: SparkSnapshot[]): void {
  const alive = new Set<string>();
  // One timestamp for the whole frame, so every series on a panel agrees.
  const at = Date.now();

  for (const s of sparks) {
    alive.add(s.id);
    sparkMap.set(s.id, s);
    if (!s.online) continue; // don't record zero-samples for offline hosts
    const m = s.metrics;
    if (m.gpu) {
      pushHistory(`${s.id}:gpu.usage`, m.gpu.usage, at);
      pushHistory(`${s.id}:gpu.temp`, m.gpu.temperature, at);
    }
    if (m.cpu) {
      pushHistory(`${s.id}:cpu.usage`, m.cpu.usage, at);
      // CPU temp is only shown for dedicated GPU hosts (not DGX Sparks).
      if (s.kind === "host" && m.cpu.temperature > 0) {
        pushHistory(`${s.id}:cpu.temp`, m.cpu.temperature, at);
      }
    }
    if (m.ram) {
      pushHistory(`${s.id}:ram.percentage`, m.ram.percentage, at);
    }
    if (Array.isArray(m.llm)) {
      // Zip with snapshot.llmPorts so multi-port LLM series key distinctly.
      const ports = s.llmPorts ?? [];
      for (let i = 0; i < m.llm.length; i++) {
        const llm = m.llm[i];
        const port = ports[i];
        const portKey = port != null ? `:${port}` : `:${i}`;
        pushHistory(`${s.id}:llm${portKey}.tps`, llm.generationTps, at);
        pushHistory(`${s.id}:llm${portKey}.prefill`, llm.prefillTps, at);
        if (llm.cachedPrefillTps != null) {
          pushHistory(`${s.id}:llm${portKey}.prefillCached`, llm.cachedPrefillTps, at);
        }
        if (llm.uncachedPrefillTps != null) {
          pushHistory(`${s.id}:llm${portKey}.prefillUncached`, llm.uncachedPrefillTps, at);
        }
      }
    }
    if (m.comfy?.available) {
      pushHistory(
        `${s.id}:comfy.queue`,
        (m.comfy.queueRunning ?? 0) + (m.comfy.queuePending ?? 0),
        at
      );
    }
  }

  // Drop series for Sparks no longer in the registry (deleted / removed from WS).
  for (const id of [...sparkMap.keys()]) {
    if (!alive.has(id)) {
      sparkMap.delete(id);
      removeHistoryForSpark(id);
    }
  }

  // Always notify: sparkMap refs refresh every frame (online flips included),
  // even when no history sample was appended.
  notify();
}

/** Read the latest cached snapshot for a spark (subscribe via useSpark). */
export function getSpark(id: string): SparkSnapshot | undefined {
  return sparkMap.get(id);
}

/** @internal getSnapshot for useMetricsHistory — stable ref per key. */
function getHistory(key: string): readonly number[] {
  return history.get(key) ?? EMPTY;
}

function getHistoryTail(key: string): readonly number[] {
  return historyTails.get(key) ?? EMPTY;
}

function getSeriesStartMs(key: string): number | undefined {
  const t = historyTimes.get(key);
  return t && t.length ? t[0] : undefined;
}

/**
 * Subscribe to one metric's full history series for one spark (up to HISTORY_MAX).
 * Re-renders only when that specific (sparkId, metric) array ref changes.
 */
export function useMetricsHistory(sparkId: string, metric: string): readonly number[] {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getHistory(key),
    () => EMPTY
  );
}

/**
 * Last SPARKLINE_TAIL samples for inline sparklines. Prefer this over slicing
 * the full series in render — the tail ref is maintained at ingest time.
 */
export function useMetricsHistoryTail(sparkId: string, metric: string): readonly number[] {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getHistoryTail(key),
    () => EMPTY
  );
}

/**
 * Timestamp of the leftmost drawn sample, or undefined when the series is
 * empty. Deliberately returns the fixed start rather than an age: an age would
 * be a new number on every getSnapshot call, which useSyncExternalStore treats
 * as a changed store and re-renders forever. Callers subtract from Date.now()
 * at render time — renders already happen once per snapshot.
 */
export function useSeriesStart(sparkId: string, metric: string): number | undefined {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getSeriesStartMs(key),
    () => undefined
  );
}

/**
 * Subscribe to one spark's latest snapshot. Re-renders when that spark's
 * cached object is replaced (every WS frame that includes it).
 */
export function useSpark(id: string): SparkSnapshot | undefined {
  return useSyncExternalStore(
    subscribeMetrics,
    () => sparkMap.get(id),
    () => undefined
  );
}

/** Clear all cached state — used on hard reload paths / tests. */
export function _resetStore(): void {
  history.clear();
  historyTimes.clear();
  historyTails.clear();
  sparkMap.clear();
}
