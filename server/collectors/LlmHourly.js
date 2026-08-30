/**
 * Hourly generated-token volume per LLM endpoint.
 *
 * Counts work actually produced by diffing the backend's monotonic output-token
 * counter, so a bucket answers "how many tokens came out of this model in that
 * hour" rather than sampling a rate. Persists to config/llm-hourly.json, last
 * 7 UTC days of hours.
 */
import fs from "fs";
import { LLM_HOURLY_JSON_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

const MAX_HOURS = 24 * 7;
const FLUSH_MS = 30_000;

/** "YYYY-MM-DDTHH" — lexicographic order matches chronological order. */
function utcHourKey(d = new Date()) {
  return d.toISOString().slice(0, 13);
}

function seriesKey(sparkId, port) {
  return `${sparkId}:${port}`;
}

function pruneSeries(hours, now) {
  const cutoff = utcHourKey(new Date(now.getTime() - (MAX_HOURS - 1) * 3600000));
  const next = {};
  for (const k of Object.keys(hours)) {
    if (k >= cutoff) next[k] = hours[k];
  }
  return next;
}

export class LlmHourlyStore {
  /**
   * @param {string} [filePath]
   */
  constructor(filePath = LLM_HOURLY_JSON_PATH) {
    this.filePath = filePath;
    /** @type {Record<string, Record<string, number>>} */
    this._data = {};
    /**
     * Last observed cumulative counter per series. Deliberately in memory only:
     * after a dashboard restart the first sample re-baselines, so tokens
     * generated while nothing was watching are skipped rather than dumped into
     * whichever hour the dashboard came back up in.
     * @type {Map<string, number>}
     */
    this._last = new Map();
    this._dirty = false;
    this._flushTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && typeof raw === "object") this._data = raw;
    } catch {
      this._data = {};
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
      atomicWrite(this.filePath, JSON.stringify(this._data));
      this._dirty = false;
    } catch (err) {
      console.error("[LlmHourly] write failed:", err.message);
    }
  }

  /**
   * @param {string} sparkId
   * @param {number} port
   * @param {{ available?: boolean, totalOutputTokens?: number }} metrics
   * @param {Date} [now]
   */
  record(sparkId, port, metrics, now = new Date()) {
    if (!sparkId || !Number.isInteger(port)) return;
    const key = seriesKey(sparkId, port);

    if (!metrics || metrics.available === false) {
      this._last.delete(key);
      return;
    }

    const total = Number(metrics.totalOutputTokens);
    if (!Number.isFinite(total) || total < 0) return;

    const prev = this._last.get(key);
    this._last.set(key, total);
    if (prev == null) return;

    // A drop means the backend restarted: everything it reports now was
    // generated since that restart.
    const delta = total < prev ? total : total - prev;
    if (delta <= 0) return;

    const hour = utcHourKey(now);
    if (!this._data[key]) this._data[key] = {};
    this._data[key][hour] = (this._data[key][hour] || 0) + delta;
    this._data[key] = pruneSeries(this._data[key], now);
    this._dirty = true;
    this._scheduleFlush();
  }

  /**
   * Hour-aligned last `hours` UTC hours (zeros for quiet hours).
   * @param {string} sparkId
   * @param {number} port
   * @param {{ hours?: number, now?: Date }} [opts]
   */
  getSeries(sparkId, port, opts = {}) {
    const n = Math.min(MAX_HOURS, Math.max(1, Number(opts.hours) || 24));
    const now = opts.now instanceof Date ? opts.now : new Date();
    const key = seriesKey(sparkId, port);
    const stored = this._data[key] || {};
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const hour = utcHourKey(new Date(now.getTime() - i * 3600000));
      out.push({ hour, tokens: stored[hour] || 0 });
    }
    return { sparkId, port, hours: out };
  }
}

export const llmHourly = new LlmHourlyStore();
