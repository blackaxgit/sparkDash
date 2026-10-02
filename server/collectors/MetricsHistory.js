/**
 * Server-side ring buffer for the live metric series behind the sparklines.
 *
 * Before this existed the series lived only in browser memory (see
 * src/hooks/metricsStore.ts), so every page load — and every dashboard
 * redeploy, which forces a reload — started the charts from zero. A tab open
 * for ten seconds drew ten seconds and stretched them across the full width,
 * which reads as an hour of data at a glance.
 *
 * One sample per broadcast tick per series, capped at MAX_SAMPLES, persisted
 * to config/metrics-history.json so a container restart does not wipe it.
 *
 * KEY CONTRACT: the keys produced here MUST match the keys
 * metricsStore.ingestSnapshots() pushes on the client, because hydration seeds
 * that same Map by key. Both sides derive `${sparkId}:${metric}` identically;
 * changing one without the other silently produces series nobody reads.
 *
 * TIMING CONTRACT: every series carries a parallel array of sample
 * timestamps, kept in lockstep with the values on push, trim and delete. It
 * exists so the client can label how much wall-clock time a chart covers
 * (LlmPanel's "28 min ago … now" axis) instead of assuming samples are one
 * poll interval apart — an assumption that breaks the moment a host goes
 * offline and the series stops growing while time keeps passing.
 */
import fs from "fs";
import path from "path";
import { ROOT } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

export const METRICS_HISTORY_JSON_PATH =
  process.env.METRICS_HISTORY_JSON_PATH || path.join(ROOT, "config", "metrics-history.json");

/** 1 h at the 1 s floor on pollIntervalMs; 2 h if someone sets 2 s. */
export const MAX_SAMPLES = 3600;
const FLUSH_MS = 30_000;
/**
 * Persisted history older than this is dropped on load. The client renders a
 * series as "the last N ticks ending now", so replaying a buffer from an hour
 * ago would draw stale numbers as if they were current. A restart that takes
 * seconds keeps its history; a container that was down all night does not.
 */
const STALE_MS = 5 * 60_000;
/** Cadence assumed only when a persisted file predates the timing contract. */
const FALLBACK_STEP_MS = 1000;

/** Two decimals is finer than any sparkline pixel and keeps the JSON small. */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Rebuild per-sample timestamps from the two endpoints we persist.
 *
 * Only the first and last timestamp of each series survive a restart: storing
 * all 3600 would multiply the file by ~30 to serve a caption that rounds to
 * whole minutes. Interpolating between real endpoints keeps both ends exact —
 * which is all the age label reads — and the interpolated interior is fully
 * replaced by real timestamps within one buffer's worth of ticks.
 */
function rebuildTimes(n, t0, tLast) {
  const validPair = Number.isFinite(t0) && Number.isFinite(tLast) && tLast >= t0;
  if (!validPair) {
    // Pre-timing-contract file: assume the nominal cadence, ending now.
    const end = Date.now();
    return Array.from({ length: n }, (_, i) => end - (n - 1 - i) * FALLBACK_STEP_MS);
  }
  if (n === 1) return [tLast];
  const step = (tLast - t0) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(t0 + i * step));
}

export class MetricsHistoryStore {
  constructor(filePath = METRICS_HISTORY_JSON_PATH, max = MAX_SAMPLES) {
    this.filePath = filePath;
    this.max = max;
    /** @type {Map<string, number[]>} */
    this._series = new Map();
    /** @type {Map<string, number[]>} sample timestamps, index-aligned with _series */
    this._times = new Map();
    this._dirty = false;
    this._flushTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!raw || typeof raw !== "object") return;
      if (!Number.isFinite(raw.updatedAt) || Date.now() - raw.updatedAt > STALE_MS) return;
      const times = raw.times && typeof raw.times === "object" ? raw.times : {};
      for (const [key, values] of Object.entries(raw.series || {})) {
        if (!Array.isArray(values)) continue;
        const clean = values.filter((v) => Number.isFinite(v)).slice(-this.max);
        if (!clean.length) continue;
        const pair = Array.isArray(times[key]) ? times[key] : [];
        this._series.set(key, clean);
        this._times.set(key, rebuildTimes(clean.length, pair[0], pair[1]));
      }
    } catch {
      this._series.clear();
      this._times.clear();
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    this._flushTimer.unref?.();
  }

  flush() {
    if (!this._dirty) return;
    try {
      const times = {};
      for (const [key, arr] of this._times) {
        if (arr.length) times[key] = [arr[0], arr[arr.length - 1]];
      }
      atomicWrite(
        this.filePath,
        JSON.stringify({
          updatedAt: Date.now(),
          series: Object.fromEntries(this._series),
          times,
        })
      );
      this._dirty = false;
    } catch (err) {
      console.error("[MetricsHistory] write failed:", err.message);
    }
  }

  /**
   * Append one sample, dropping the oldest once the cap is reached.
   * @param {number} [at] tick timestamp; one value shared by every series in a
   *   tick, so all charts on a panel report the same start time.
   */
  push(key, value, at = Date.now()) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    let arr = this._series.get(key);
    let ts = this._times.get(key);
    if (!arr) {
      arr = [];
      ts = [];
      this._series.set(key, arr);
      this._times.set(key, ts);
    }
    arr.push(round2(v));
    ts.push(at);
    if (arr.length > this.max) {
      const drop = arr.length - this.max;
      arr.splice(0, drop);
      ts.splice(0, drop);
    }
    this._dirty = true;
    this._scheduleFlush();
  }

  /**
   * Record one tick from a full snapshot list. Mirrors the client's
   * ingestSnapshots() key-for-key — see KEY CONTRACT above.
   * @param {Array<object>} sparks
   */
  recordSnapshot(sparks) {
    if (!Array.isArray(sparks)) return;
    const alive = new Set();
    // One timestamp for the whole tick: series recorded together must report
    // the same start, otherwise two rows of one panel disagree by a few ms.
    const at = Date.now();

    for (const s of sparks) {
      if (!s || !s.id) continue;
      alive.add(s.id);
      if (!s.online) continue; // don't record zero-samples for offline hosts
      const m = s.metrics || {};
      if (m.gpu) {
        this.push(`${s.id}:gpu.usage`, m.gpu.usage, at);
        this.push(`${s.id}:gpu.temp`, m.gpu.temperature, at);
      }
      if (m.cpu) {
        this.push(`${s.id}:cpu.usage`, m.cpu.usage, at);
        if (s.kind === "host" && m.cpu.temperature > 0) {
          this.push(`${s.id}:cpu.temp`, m.cpu.temperature, at);
        }
      }
      if (m.ram) {
        this.push(`${s.id}:ram.percentage`, m.ram.percentage, at);
      }
      if (Array.isArray(m.llm)) {
        const ports = s.llmPorts ?? [];
        for (let i = 0; i < m.llm.length; i++) {
          const llm = m.llm[i];
          const port = ports[i];
          const portKey = port != null ? `:${port}` : `:${i}`;
          this.push(`${s.id}:llm${portKey}.tps`, llm.generationTps, at);
          this.push(`${s.id}:llm${portKey}.prefill`, llm.prefillTps, at);
          if (llm.cachedPrefillTps != null) {
            this.push(`${s.id}:llm${portKey}.prefillCached`, llm.cachedPrefillTps, at);
          }
          if (llm.uncachedPrefillTps != null) {
            this.push(`${s.id}:llm${portKey}.prefillUncached`, llm.uncachedPrefillTps, at);
          }
        }
      }
      if (m.comfy?.available) {
        this.push(
          `${s.id}:comfy.queue`,
          (m.comfy.queueRunning ?? 0) + (m.comfy.queuePending ?? 0),
          at
        );
      }
    }

    // Drop series for sparks that left the registry, same as the client does.
    for (const key of [...this._series.keys()]) {
      const id = key.slice(0, key.indexOf(":"));
      if (id && !alive.has(id)) {
        this._series.delete(key);
        this._times.delete(key);
        this._dirty = true;
      }
    }
  }

  /** Hydration payload for a freshly connected client. */
  getAll() {
    return Object.fromEntries(this._series);
  }

  /**
   * Per-series [firstSampleMs, lastSampleMs], sent alongside getAll() so the
   * client can date a hydrated series instead of guessing its cadence.
   */
  getMeta() {
    const meta = {};
    for (const [key, arr] of this._times) {
      if (arr.length) meta[key] = [arr[0], arr[arr.length - 1]];
    }
    return meta;
  }

  /** Test seam. */
  clear() {
    this._series.clear();
    this._times.clear();
    this._dirty = true;
  }
}

export const metricsHistory = new MetricsHistoryStore();
