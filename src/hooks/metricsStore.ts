import { useSyncExternalStore } from "react";
import type { SparkSnapshot } from "../api/types";
import { TimedRingBuffer, type TimedSample } from "./ringBuffer";

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
 * TIMING CONTRACT: every sample carries its own timestamp (TimedRingBuffer), so
 * `useSeriesStart` can report how much wall-clock time a chart actually spans.
 * Sample count alone cannot: an offline host stops contributing samples while
 * time keeps passing, so `length x pollInterval` would under-report the age of
 * the leftmost point. Hydrated series get timestamps interpolated between the
 * server's [first, last] pair (`timesForHydrated`).
 */

// History depth, configurable at build time. VITE_HISTORY_HOURS = wall-clock
// hours to retain (default 8 h at the 2 s WS poll ≈ 112 KB per series — the
// browser tab is the only thing that pays for it).
const SAMPLES_PER_HOUR = 1800; // 2 s poll
const HISTORY_HOURS = Number(import.meta.env.VITE_HISTORY_HOURS ?? 8) || 8;
export const HISTORY_MAX = Math.round(SAMPLES_PER_HOUR * HISTORY_HOURS);
/** Samples shown in inline sparklines (≈1 min at 2 s poll). Full series stays in HISTORY_MAX. */
export const SPARKLINE_TAIL = 30;
/** Cadence assumed only when the server sent no timing metadata for a series. */
const FALLBACK_STEP_MS = 1000;

const history = new Map<string, TimedRingBuffer>(); // key: `${sparkId}:${metric}`
const historySamples = new Map<string, readonly TimedSample[]>();
const historyValues = new Map<string, readonly number[]>();
/** Cached last-N views — refreshed whenever the full series is replaced. */
const historyTails = new Map<string, readonly number[]>();
const sparkMap = new Map<string, SparkSnapshot>();
const listeners = new Set<() => void>();

const EMPTY: readonly number[] = Object.freeze([] as number[]);

/**
 * Mean of a metric series over samples where the reading is > 0, or null when
 * there are no busy samples. Skipping zeros keeps idle/off phases from dragging
 * the average toward zero (a prefill that runs at 500 tok/s is "500", not 0.5).
 */
export function avgPositive(values: readonly number[]): number | null {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (v > 0) {
      sum += v;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

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
  let ring = history.get(key);
  if (!ring) {
    ring = new TimedRingBuffer(HISTORY_MAX);
    history.set(key, ring);
  }
  const last = ring.last();
  if (last && at < last.at) return;
  if (last && at === last.at) ring.replaceLast({ at, value });
  else ring.push({ at, value });
  ring.pruneBefore(at - HISTORY_HOURS * 3_600_000);
  const samples = ring.toArray();
  historySamples.set(key, samples);
  historyValues.set(key, samples.map((sample) => sample.value));
  setHistoryTail(key, ring.tail(SPARKLINE_TAIL).map((sample) => sample.value));
}

function removeHistoryForSpark(sparkId: string) {
  const prefix = `${sparkId}:`;
  for (const key of history.keys()) {
    if (key.startsWith(prefix)) {
      history.delete(key);
      historySamples.delete(key);
      historyValues.delete(key);
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
    const existing = historySamples.get(key);
    if (existing && existing.length >= clean.length) continue;
    const next = clean.length > HISTORY_MAX ? clean.slice(-HISTORY_MAX) : clean;
    const times = timesForHydrated(next.length, meta?.[key]);
    const ring = new TimedRingBuffer(HISTORY_MAX);
    for (let i = 0; i < next.length; i++) ring.push({ at: times[i], value: next[i] });
    history.set(key, ring);
    const samples = ring.toArray();
    historySamples.set(key, samples);
    historyValues.set(key, next);
    setHistoryTail(key, next);
    changed = true;
  }

  if (changed) notify();
}

/** Ingest a full WS snapshot: update latest-per-spark + append history series. */
export function ingestSnapshots(sparks: SparkSnapshot[], at = Date.now()): void {
  const alive = new Set<string>();
  // `at` is one timestamp for the whole frame, so every series on a panel agrees.

  for (const s of sparks) {
    alive.add(s.id);
    sparkMap.set(s.id, s);
    if (!s.online) continue; // don't record zero-samples for offline hosts
    const m = s.metrics;
    if (m.gpu) {
      pushHistory(`${s.id}:gpu.usage`, m.gpu.usage, at);
      pushHistory(`${s.id}:gpu.temp`, m.gpu.temperature, at);
      // Per-card series for multi-GPU hosts (keyed by nvidia-smi index).
      if (Array.isArray(m.gpu.gpus) && m.gpu.gpus.length > 1) {
        for (const d of m.gpu.gpus) {
          pushHistory(`${s.id}:gpu.${d.index}.usage`, d.usage, at);
          pushHistory(`${s.id}:gpu.${d.index}.temp`, d.temperature, at);
        }
      }
    }
    if (m.cpu) {
      pushHistory(`${s.id}:cpu.usage`, m.cpu.usage, at);
      // Skip 0°C so a missing sensor does not draw a fake floor on the sparkline.
      if (m.cpu.temperature > 0) {
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
        // TTFT is sparse: vLLM reports live TTFT only while serving. It is NOT
        // index-aligned with the tick-dense series above — that is fine because
        // the ttft series feeds only the busy-sample average badge, never the
        // overlaid chart (see LlmTrendChart).
        if (llm.ttftSeconds != null) {
          pushHistory(`${s.id}:llm${portKey}.ttft`, llm.ttftSeconds, at);
        }
        if (llm.cachedPrefillTps != null) {
          pushHistory(`${s.id}:llm${portKey}.prefillCached`, llm.cachedPrefillTps, at);
        }
        if (llm.uncachedPrefillTps != null) {
          pushHistory(`${s.id}:llm${portKey}.prefillUncached`, llm.uncachedPrefillTps, at);
        }
      }
    }
    if (m.comfy?.available) {
      pushHistory(`${s.id}:comfy.queue`, (m.comfy.queueRunning ?? 0) + (m.comfy.queuePending ?? 0), at);
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
  return historyValues.get(key) ?? EMPTY;
}

const EMPTY_TIMED: readonly TimedSample[] = Object.freeze([] as TimedSample[]);

export type MetricSample = TimedSample;

export function getMetricHistorySamples(sparkId: string, metric: string): readonly TimedSample[] {
  return historySamples.get(`${sparkId}:${metric}`) ?? EMPTY_TIMED;
}

function getTimedHistory(key: string): readonly TimedSample[] {
  return historySamples.get(key) ?? EMPTY_TIMED;
}

function getHistoryTail(key: string): readonly number[] {
  return historyTails.get(key) ?? EMPTY;
}

function getSeriesStartMs(key: string): number | undefined {
  const samples = historySamples.get(key);
  return samples && samples.length ? samples[0].at : undefined;
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

export function useTimedMetricsHistory(sparkId: string, metric: string): readonly TimedSample[] {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getTimedHistory(key),
    () => EMPTY_TIMED
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
  historySamples.clear();
  historyValues.clear();
  historyTails.clear();
  sparkMap.clear();
}
