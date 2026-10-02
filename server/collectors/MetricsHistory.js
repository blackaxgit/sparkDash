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
 * KEY CONTRACT (short tier): the keys produced here MUST match the keys
 * metricsStore.ingestSnapshots() pushes on the client, because hydration seeds
 * that same Map by key. Both sides derive `${sparkId}:${metric}` identically;
 * changing one without the other silently produces series nobody reads.
 * The long tier below has its own keys (`mem.percentage`, `gpu.power`, `net.*`,
 * ...) that ingestSnapshots() does not push; its `gpu.*` keys are gated on the
 * snapshot's `collected` flag.
 *
 * TIMING CONTRACT: every series carries a parallel array of sample
 * timestamps, kept in lockstep with the values on push, trim and delete. It
 * exists so the client can label how much wall-clock time a chart covers
 * (LlmPanel's "28 min ago … now" axis) instead of assuming samples are one
 * poll interval apart — an assumption that breaks the moment a host goes
 * offline and the series stops growing while time keeps passing.
 *
 * LONG TIER: independent of the above, recordSnapshot() also folds every tick
 * into per-minute averages kept for 7 days (config/metrics-history-long.json)
 * and served by getRange() to GET /api/sparks/:id/history. It does not touch
 * the short tier or the WS `history` message.
 */
import fs from "fs";
import path from "path";
import { ROOT } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

export const METRICS_HISTORY_JSON_PATH =
  process.env.METRICS_HISTORY_JSON_PATH || path.join(ROOT, "config", "metrics-history.json");

export const METRICS_HISTORY_LONG_JSON_PATH =
  process.env.METRICS_HISTORY_LONG_JSON_PATH ||
  path.join(ROOT, "config", "metrics-history-long.json");

const MINUTE_MS = 60_000;
/** Long-tier retention: 7 days of one-minute points. */
const LONG_MAX_POINTS = 7 * 24 * 60;
const LONG_RETENTION_MS = LONG_MAX_POINTS * MINUTE_MS;
const LONG_FLUSH_MS = 5 * 60_000;
/** range → [span ms, step ms] */
export const HISTORY_RANGES = {
  "1h": [3_600_000, 60_000],
  "24h": [86_400_000, 60_000],
  "7d": [604_800_000, 600_000],
};

/** Drop leading points older than the retention window or beyond the cap. */
function trimLong(entry, now) {
  const cutoff = now - LONG_RETENTION_MS;
  let drop = entry.start < cutoff ? Math.ceil((cutoff - entry.start) / MINUTE_MS) : 0;
  drop = Math.max(drop, entry.values.length - LONG_MAX_POINTS);
  if (drop > 0) {
    entry.values.splice(0, drop);
    entry.start += drop * MINUTE_MS;
  }
}

/** Per-minute figures worth charting over days, keyed without the spark prefix. */
function longSamples(m, llmPorts, kind) {
  const out = {};
  // A failed GPU collection reports zeros; leave the keys out so the minute is a gap.
  if (m.gpu && m.gpu.collected !== false) {
    out["gpu.usage"] = m.gpu.usage;
    out["gpu.temp"] = m.gpu.temperature;
    out["gpu.power"] = m.gpu.power?.draw;
  }
  // Unified memory counts dedicated VRAM, which is wrong on discrete-GPU hosts.
  out["mem.percentage"] =
    kind === "host" ? m.ram?.percentage : (m.unifiedMemory?.percentage ?? m.ram?.percentage);
  if (m.cpu) out["cpu.usage"] = m.cpu.usage;
  const net = m.network;
  if (net && Array.isArray(net.interfaces)) {
    const nic = net.interfaces.find((i) => i.name === net.primaryInterface);
    if (nic) {
      out["net.rx"] = nic.rxSpeed;
      out["net.tx"] = nic.txSpeed;
    }
  }
  if (Array.isArray(m.llm)) {
    for (let i = 0; i < m.llm.length; i++) {
      const port = llmPorts?.[i];
      out[`llm:${port != null ? port : i}.tps`] = m.llm[i]?.generationTps;
    }
  }
  return out;
}

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
  constructor(filePath = METRICS_HISTORY_JSON_PATH, max = MAX_SAMPLES, longFilePath) {
    this.filePath = filePath;
    this.longFilePath =
      longFilePath ??
      (filePath === METRICS_HISTORY_JSON_PATH
        ? METRICS_HISTORY_LONG_JSON_PATH
        : filePath.replace(/\.json$/i, "") + "-long.json");
    this.max = max;
    /** @type {Map<string, number[]>} */
    this._series = new Map();
    /** @type {Map<string, number[]>} sample timestamps, index-aligned with _series */
    this._times = new Map();
    this._dirty = false;
    this._flushTimer = null;
    /** @type {Map<string, {start: number, values: (number|null)[]}>} one point per minute */
    this._long = new Map();
    /** @type {Map<string, {minute: number, sum: number, count: number}>} minute in progress */
    this._acc = new Map();
    this._longDirty = false;
    this._longFlushTimer = null;
    this._load();
    this._loadLong();
  }

  _loadLong() {
    try {
      if (!fs.existsSync(this.longFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.longFilePath, "utf8"));
      if (!raw || typeof raw !== "object") return;
      const now = Date.now();
      for (const [key, e] of Object.entries(raw.series || {})) {
        if (!e || !Number.isFinite(e.start) || !Array.isArray(e.values)) continue;
        const entry = {
          start: e.start,
          values: e.values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
        };
        trimLong(entry, now);
        if (entry.values.some((v) => v !== null)) this._long.set(key, entry);
      }
    } catch (err) {
      this._long.clear();
      const corrupt = `${this.longFilePath}.corrupt-${Date.now()}`;
      console.warn(
        `[MetricsHistory] unreadable long-tier file ${this.longFilePath}: ${err.message}; moving to ${corrupt}`
      );
      try {
        fs.renameSync(this.longFilePath, corrupt);
      } catch (renameErr) {
        console.warn("[MetricsHistory] could not move corrupt long-tier file:", renameErr.message);
      }
    }
  }

  _scheduleLongFlush() {
    if (this._longFlushTimer) return;
    this._longFlushTimer = setTimeout(() => {
      this._longFlushTimer = null;
      this.flushLong();
    }, LONG_FLUSH_MS);
    this._longFlushTimer.unref?.();
  }

  flushLong() {
    if (!this._longDirty) return;
    try {
      atomicWrite(
        this.longFilePath,
        JSON.stringify({ updatedAt: Date.now(), series: Object.fromEntries(this._long) })
      );
      this._longDirty = false;
    } catch (err) {
      console.error("[MetricsHistory] long-tier write failed:", err.message);
    }
  }

  /** Write the finished minute's average into the key's minute grid. */
  _commitMinute(key, acc) {
    const avg = round2(acc.sum / acc.count);
    let entry = this._long.get(key);
    const idx = entry ? Math.round((acc.minute - entry.start) / MINUTE_MS) : 0;
    if (!entry || idx > LONG_MAX_POINTS) {
      entry = { start: acc.minute, values: [avg] };
      this._long.set(key, entry);
    } else if (idx >= 0) {
      while (entry.values.length < idx) entry.values.push(null);
      entry.values[idx] = avg;
    } else {
      return; // older than the grid start; samples arrive in time order, so ignore
    }
    trimLong(entry, acc.minute);
    this._longDirty = true;
    this._scheduleLongFlush();
  }

  _accumulate(key, value, minute) {
    const v = Number(value);
    if (value == null || !Number.isFinite(v)) return;
    const acc = this._acc.get(key);
    if (acc && acc.minute === minute) {
      acc.sum += v;
      acc.count++;
    } else {
      this._acc.set(key, { minute, sum: v, count: 1 });
    }
  }

  /** Commit every in-progress minute that is older than `minute`. */
  _rollMinutes(minute) {
    for (const [key, acc] of this._acc) {
      if (acc.minute < minute) {
        this._commitMinute(key, acc);
        this._acc.delete(key);
      }
    }
  }

  /**
   * Downsampled history for one spark, ending at `now`.
   * @param {string} sparkId
   * @param {"1h"|"24h"|"7d"} range
   * @returns {{range: string, stepMs: number, series: Record<string, [number, number|null][]>}}
   */
  getRange(sparkId, range, now = Date.now()) {
    const [span, step] = HISTORY_RANGES[range];
    const n = span / step;
    const first = Math.floor(now / step) * step - (n - 1) * step;
    const prefix = `${sparkId}:`;
    const series = {};
    const keys = new Set([...this._long.keys(), ...this._acc.keys()]);
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const entry = this._long.get(key);
      const acc = this._acc.get(key);
      const points = [];
      let any = false;
      for (let i = 0; i < n; i++) {
        const t = first + i * step;
        let sum = 0;
        let count = 0;
        for (let m = t; m < t + step; m += MINUTE_MS) {
          let v = null;
          if (entry) {
            const idx = (m - entry.start) / MINUTE_MS;
            if (idx >= 0 && idx < entry.values.length) v = entry.values[idx];
          }
          if (v === null && acc && acc.minute === m) v = round2(acc.sum / acc.count);
          if (v !== null) {
            sum += v;
            count++;
          }
        }
        if (count) any = true;
        points.push([t, count ? round2(sum / count) : null]);
      }
      if (any) series[key.slice(prefix.length)] = points;
    }
    return { range, stepMs: step, series };
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

  /** Short tier only; the long tier has its own, slower cadence (see flushLong). */
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

  /** Both tiers; for shutdown, where the long tier's cadence no longer applies. */
  flushAll() {
    this.flush();
    this.flushLong();
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
   * @param {number} [at] tick timestamp (test seam; defaults to now)
   */
  recordSnapshot(sparks, at = Date.now()) {
    if (!Array.isArray(sparks)) return;
    const alive = new Set();
    // One timestamp for the whole tick: series recorded together must report
    // the same start, otherwise two rows of one panel disagree by a few ms.
    const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    this._rollMinutes(minute);

    for (const s of sparks) {
      if (!s || !s.id) continue;
      alive.add(s.id);
      if (!s.online) continue; // don't record zero-samples for offline hosts
      const m = s.metrics || {};
      for (const [k, v] of Object.entries(longSamples(m, s.llmPorts, s.kind))) {
        this._accumulate(`${s.id}:${k}`, v, minute);
      }
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
    for (const map of [this._long, this._acc]) {
      for (const key of [...map.keys()]) {
        const id = key.slice(0, key.indexOf(":"));
        if (id && !alive.has(id)) {
          map.delete(key);
          this._longDirty = true;
          this._scheduleLongFlush();
        }
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
    this._long.clear();
    this._acc.clear();
    this._longDirty = true;
  }
}

export const metricsHistory = new MetricsHistoryStore();
