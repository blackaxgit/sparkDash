/**
 * GPU thermal headroom and slowdown-counter growth — pure functions.
 *
 * SystemCollector feeds this with a separate, optional nvidia-smi query (never the
 * main GPU query: an unsupported field there would break GPU metrics on other
 * sparks) plus the /sys/class/thermal zones, and keeps the small per-collector
 * sample ring that turns cumulative counters into "grew recently".
 */

/** nvidia-smi arguments for the optional thermal query (values are cumulative µs). */
export const THERMAL_SMI_ARGS =
  "--query-gpu=temperature.gpu.tlimit,clocks_event_reasons_counters.hw_thermal_slowdown,clocks_event_reasons_counters.sw_thermal_slowdown,clocks_event_reasons_counters.sw_power_cap --format=csv,noheader,nounits";

/** How long a counter increase keeps `*Recent` true. */
export const RECENT_WINDOW_MS = 10 * 60_000;
/** SW thermal slowdown that raises a warning: 1% of RECENT_WINDOW_MS. */
export const SW_WARN_GROWTH_US = (RECENT_WINDOW_MS / 100) * 1000;

/** Hard cap on retained samples, independent of the poll interval. */
const MAX_SAMPLES = 200;

/** Zone temperature assumed critical when no `critical` trip point is exposed. */
const DEFAULT_CRIT_C = 104;
const CRIT_MARGIN_C = 4;
const WARN_ZONE_C = 98;
const WARN_TLIMIT_C = 2;

/**
 * @typedef {{ tlimitC: number | null, hwSlowdownUs: number | null, swSlowdownUs: number | null, powerCapUs: number | null }} SmiThermal
 * @typedef {{ tempMilliC: number | null, critMilliC: number[] }} ThermalZone
 * @typedef {{ at: number, hw: number | null, sw: number | null }} ThermalSample
 * @typedef {{
 *   tlimitC: number | null, zoneMaxC: number | null, zoneCritC: number | null,
 *   hwSlowdownUs: number | null, swSlowdownUs: number | null, powerCapUs: number | null,
 *   hwSlowdownRecent: boolean, swSlowdownRecent: boolean,
 *   level: "ok" | "warn" | "crit" | "unknown", reasons: string[]
 * }} GpuThermal
 */

/** @param {unknown} v */
function smiNumber(v) {
  const t = String(v ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null; // "[N/A]", "Not Supported", ""
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the optional thermal nvidia-smi CSV line. Non-numeric fields become null.
 * Returns null when the output is not a four-field CSV line (command failed, or an
 * "unsupported field" message) so the caller can back off.
 * @param {string} output
 * @returns {SmiThermal | null}
 */
export function parseThermalSmi(output) {
  const line = String(output ?? "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const parts = line.split(",");
  if (parts.length !== 4) return null;
  const [tlimitC, hwSlowdownUs, swSlowdownUs, powerCapUs] = parts.map(smiNumber);
  return { tlimitC, hwSlowdownUs, swSlowdownUs, powerCapUs };
}

/** @param {number | null} milli */
function validMilli(milli) {
  return milli != null && Number.isFinite(milli) && milli > 0 && milli < 250_000;
}

/** @param {number} c */
function round1(c) {
  return Math.round(c * 10) / 10;
}

/**
 * Hottest zone and lowest critical trip point, in degrees C.
 * @param {ThermalZone[]} zones
 * @returns {{ zoneMaxC: number | null, zoneCritC: number | null }}
 */
export function summarizeZones(zones) {
  let max = null;
  let crit = null;
  for (const z of zones ?? []) {
    if (validMilli(z.tempMilliC) && (max == null || z.tempMilliC > max)) max = z.tempMilliC;
    for (const c of z.critMilliC ?? []) {
      if (validMilli(c) && (crit == null || c < crit)) crit = c;
    }
  }
  return {
    zoneMaxC: max == null ? null : round1(max / 1000),
    zoneCritC: crit == null ? null : round1(crit / 1000),
  };
}

/**
 * Parse the zone dump printed by the remote shell script: one `T <milliC>` line per
 * zone temperature and one `C <milliC>` line per `critical` trip point.
 * @param {string} text
 * @returns {{ zoneMaxC: number | null, zoneCritC: number | null }}
 */
export function parseZoneDump(text) {
  /** @type {ThermalZone[]} */
  const zones = [];
  for (const raw of String(text ?? "").split("\n")) {
    const m = /^([TC])\s+(-?\d+)\s*$/.exec(raw.trim());
    if (!m) continue;
    const v = Number(m[2]);
    if (m[1] === "T") zones.push({ tempMilliC: v, critMilliC: [] });
    else zones.push({ tempMilliC: null, critMilliC: [v] });
  }
  return summarizeZones(zones);
}

/**
 * Append a sample and drop those older than the recent window (and any beyond the cap).
 * @param {ThermalSample[]} history mutated in place
 * @param {ThermalSample} sample
 * @returns {ThermalSample[]}
 */
export function recordThermalSample(history, sample) {
  history.push(sample);
  const cutoff = sample.at - RECENT_WINDOW_MS;
  let drop = 0;
  while (drop < history.length && history[drop].at < cutoff) drop++;
  if (history.length - drop > MAX_SAMPLES) drop = history.length - MAX_SAMPLES;
  if (drop > 0) history.splice(0, drop);
  return history;
}

/**
 * Total growth of one counter over the window: the sum of consecutive increases
 * between the in-window samples and the current value. A decrease (counter reset,
 * e.g. after a reboot) restarts the baseline and is never growth.
 * @param {ThermalSample[]} history
 * @param {"hw" | "sw"} key
 * @param {number | null} current
 * @param {number} now
 */
function growthUs(history, key, current, now) {
  const cutoff = now - RECENT_WINDOW_MS;
  const series = [];
  for (const s of history ?? []) {
    const v = s?.[key];
    if (s && s.at >= cutoff && v != null && Number.isFinite(v)) series.push(v);
  }
  if (current != null && Number.isFinite(current)) series.push(current);
  let grown = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i] > series[i - 1]) grown += series[i] - series[i - 1];
  }
  return grown;
}

/** @param {number} us */
function fmtSeconds(us) {
  const s = us / 1e6;
  return s >= 100 ? `${Math.round(s)} s` : `${round1(s)} s`;
}

/**
 * Evaluate GPU thermal state.
 *
 *  crit: hw slowdown counter grew recently, OR zoneMaxC >= (zoneCritC ?? 104) - 4
 *  warn: tlimitC <= 2, OR zoneMaxC >= 98, OR sw slowdown grew >= 6 s (1% of the window)
 *        in the last 10 min — a sub-second firmware blip under sustained load is shown in
 *        the counters (swSlowdownRecent) but does not raise a banner
 *  unknown: every input is null; otherwise ok
 *
 * @param {{ tlimitC: number | null, zoneMaxC: number | null, zoneCritC: number | null,
 *   hwSlowdownUs: number | null, swSlowdownUs: number | null, powerCapUs: number | null }} inputs
 * @param {ThermalSample[]} history samples taken before `inputs` (the current reading is not in it)
 * @param {number} now epoch ms
 * @returns {GpuThermal}
 */
export function evaluateThermal(inputs, history, now) {
  const tlimitC = inputs?.tlimitC ?? null;
  const zoneMaxC = inputs?.zoneMaxC ?? null;
  const zoneCritC = inputs?.zoneCritC ?? null;
  const hwSlowdownUs = inputs?.hwSlowdownUs ?? null;
  const swSlowdownUs = inputs?.swSlowdownUs ?? null;
  const powerCapUs = inputs?.powerCapUs ?? null;

  const hwGrowth = growthUs(history, "hw", hwSlowdownUs, now);
  const swGrowth = growthUs(history, "sw", swSlowdownUs, now);
  const hwSlowdownRecent = hwGrowth > 0;
  const swSlowdownRecent = swGrowth > 0;
  const swWarn = swGrowth >= SW_WARN_GROWTH_US;

  const critAtC = (zoneCritC ?? DEFAULT_CRIT_C) - CRIT_MARGIN_C;
  const zoneCrit = zoneMaxC != null && zoneMaxC >= critAtC;
  const zoneWarn = zoneMaxC != null && zoneMaxC >= WARN_ZONE_C;
  const tlimitWarn = tlimitC != null && tlimitC <= WARN_TLIMIT_C;

  /** @type {string[]} */
  const reasons = [];
  if (hwSlowdownRecent) {
    reasons.push(
      `Hardware thermal slowdown grew by ${fmtSeconds(hwGrowth)} in the last 10 min (total ${fmtSeconds(hwSlowdownUs ?? 0)})`
    );
  }
  if (zoneCrit) {
    reasons.push(
      `Thermal zone ${zoneMaxC}°C (≥ ${critAtC}°C, critical ${zoneCritC ?? DEFAULT_CRIT_C}°C − ${CRIT_MARGIN_C}°C)`
    );
  } else if (zoneWarn) {
    reasons.push(`Thermal zone ${zoneMaxC}°C (≥ ${WARN_ZONE_C}°C)`);
  }
  if (tlimitWarn) reasons.push(`T.Limit headroom ${tlimitC}°C (≤ ${WARN_TLIMIT_C}°C)`);
  if (swWarn) {
    reasons.push(
      `Software thermal slowdown grew by ${fmtSeconds(swGrowth)} in the last 10 min (total ${fmtSeconds(swSlowdownUs ?? 0)})`
    );
  }

  const allNull =
    tlimitC == null &&
    zoneMaxC == null &&
    zoneCritC == null &&
    hwSlowdownUs == null &&
    swSlowdownUs == null &&
    powerCapUs == null;

  /** @type {GpuThermal["level"]} */
  let level = "ok";
  if (allNull) level = "unknown";
  else if (hwSlowdownRecent || zoneCrit) level = "crit";
  else if (tlimitWarn || zoneWarn || swWarn) level = "warn";

  return {
    tlimitC,
    zoneMaxC,
    zoneCritC,
    hwSlowdownUs,
    swSlowdownUs,
    powerCapUs,
    hwSlowdownRecent,
    swSlowdownRecent,
    level,
    reasons,
  };
}
