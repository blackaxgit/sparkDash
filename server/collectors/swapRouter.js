/**
 * llama-swap router support.
 *
 * A llama-swap proxy speaks OpenAI on one port but fronts N engines. Its
 * /v1/models lists every configured model *and alias*, so `data[0]` is
 * whichever id sorts first — on a Spark that is the always-resident
 * "embeddings" alias, not the model that is loaded. Identity, context length
 * and Prometheus metrics must therefore come from the engine named by
 * GET /running, which also reports that engine's upstream proxy URL.
 */

/** @typedef {{ model: string, state: string | null, proxy: string | null, name: string | null, description: string | null }} RunningRow */

/** True when /v1/models `owned_by` marks the endpoint as a llama-swap proxy. */
export function isSwapOwner(ownedBy) {
  return typeof ownedBy === "string" && /llama[-_\s]?swap/i.test(ownedBy);
}

/**
 * A router lists what it runs, not a catalogue: a real config is single
 * digits. Bound the fan-out so one hostile /running body cannot turn a 2 s
 * poll into thousands of upstream requests.
 */
const MAX_RUNNING_ROWS = 32;
const MAX_FIELD_CHARS = 256;

/** @param {unknown} v */
function boundedString(v) {
  if (typeof v !== "string" || !v) return null;
  return v.length > MAX_FIELD_CHARS ? null : v;
}

/**
 * Normalize GET /running. Returns null when the payload is not llama-swap's
 * shape, so callers can tell "not a router" from "router with nothing loaded".
 * @param {unknown} payload
 * @returns {RunningRow[] | null}
 */
export function parseRunning(payload) {
  const rows = payload && typeof payload === "object" ? payload.running : null;
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const row of rows) {
    if (out.length >= MAX_RUNNING_ROWS) break;
    if (!row || typeof row !== "object") continue;
    const model = boundedString(row.model);
    if (!model) continue;
    out.push({
      model,
      state: boundedString(row.state),
      proxy: boundedString(row.proxy),
      name: boundedString(row.name),
      description: boundedString(row.description),
    });
  }
  return out;
}

/** llama-swap states: "ready" serves now; "starting"/"stopping" do not. */
export function isReadyState(state) {
  return state == null || state === "ready" || state === "running";
}

/**
 * A model on its way in. llama-swap also reports the outgoing model as
 * non-ready during a swap ("stopping"), and that one is not loading.
 */
export function isLoadingState(state) {
  const s = typeof state === "string" ? state.toLowerCase() : "";
  return s === "starting" || s === "loading";
}

function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || h.startsWith("127.");
}

/**
 * Upstream origin for a /running row, or null when it may not be scraped.
 *
 * llama-swap spawns its engines and reports them on the Spark's own loopback
 * address. Scraping that verbatim from a remote dashboard would read the
 * *dashboard host's* port, so the loopback is rewritten to the host we are
 * already talking to. Anything else — another host, another scheme — is
 * refused: the operator approved one probe target, and a `/running` body is
 * remote input that must not be able to aim the dashboard's HTTP client
 * somewhere new.
 * @param {string | null} proxyUrl
 * @param {string} probeBaseUrl
 * @returns {string | null}
 */
export function upstreamBase(proxyUrl, probeBaseUrl) {
  if (!proxyUrl) return null;
  let proxy;
  let probe;
  try {
    proxy = new URL(proxyUrl);
    probe = new URL(probeBaseUrl);
  } catch {
    return null;
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return null;
  if (isLoopbackHost(proxy.hostname)) {
    if (!isLoopbackHost(probe.hostname)) proxy.hostname = probe.hostname;
    return proxy.origin;
  }
  return proxy.hostname === probe.hostname ? proxy.origin : null;
}

/**
 * `process_start_time_seconds` from a Prometheus body — the engine's identity
 * and the only ordering signal that survives a swap (OpenAI `created` is
 * recomputed per request, so it cannot be used).
 * @param {string} body
 * @returns {number | null}
 */
export function processStartTime(body) {
  const m = /^process_start_time_seconds(?:\{[^}]*\})?\s+([\d.eE+-]+)\s*$/m.exec(
    String(body || "")
  );
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Rank resolved engines: the most recently started one is the model the user
 * just loaded. Helpers pinned for the life of the box (embeddings, rerankers)
 * are always older, so they only win when nothing else is resident.
 * @template {{ startedAt: number | null }} T
 * @param {T[]} candidates
 * @returns {T | null}
 */
export function pickNewestEngine(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    const a = c.startedAt;
    const b = best.startedAt;
    if (a == null) continue;
    if (b == null || a > b) best = c;
  }
  return best;
}

const EVENT_CAP = 10;

/**
 * Diff one /running poll against the previous one. `prev` is the state this
 * function returned last time (null on the first poll: seed, emit nothing).
 * @param {Map<string, {kind: "loading"|"ready"|"stopping", loadingAt: number|null}> | null} prev
 * @param {RunningRow[]} rows
 * @param {number} now
 * @param {Array<{at: number, model: string, state: "loading"|"ready"|"stopped", loadMs: number|null}>} events newest first
 * @returns {{ state: Map<string, {kind: "loading"|"ready"|"stopping", loadingAt: number|null}>, events: typeof events }}
 */
export function diffRouterRows(prev, rows, now, events) {
  const state = new Map();
  const fresh = [];
  for (const r of rows) {
    if (state.has(r.model)) continue;
    const kind = isLoadingState(r.state) ? "loading" : isReadyState(r.state) ? "ready" : "stopping";
    const was = prev?.get(r.model);
    let loadingAt = kind === "loading" ? (was?.kind === "loading" ? was.loadingAt : null) : null;
    if (prev) {
      if (kind === "loading" && was?.kind !== "loading") {
        loadingAt = now;
        fresh.push({ at: now, model: r.model, state: "loading", loadMs: null });
      } else if (kind === "ready" && was?.kind !== "ready") {
        const loadMs = was?.kind === "loading" && was.loadingAt != null ? now - was.loadingAt : null;
        fresh.push({ at: now, model: r.model, state: "ready", loadMs });
      } else if (kind === "stopping" && was && was.kind !== "stopping") {
        fresh.push({ at: now, model: r.model, state: "stopped", loadMs: null });
      }
    }
    state.set(r.model, { kind, loadingAt });
  }
  if (prev) {
    for (const [model, was] of prev) {
      if (!state.has(model) && was.kind !== "stopping") {
        fresh.push({ at: now, model, state: "stopped", loadMs: null });
      }
    }
  }
  return { state, events: [...fresh.reverse(), ...events].slice(0, EVENT_CAP) };
}

/** Page size requested from /api/metrics/activity; a full page means older rows were cut off. */
export const ACTIVITY_LIMIT = 999;

const HOUR_MS = 3_600_000;
const ERROR_ROWS = 5;
const MAX_TEXT = 200;

/** @param {unknown} v */
function shortText(v) {
  return typeof v === "string" && v ? v.slice(0, MAX_TEXT) : null;
}

/**
 * Request outcomes from one /api/metrics/activity page (statelessly).
 * Returns null when the payload is not llama-swap's shape.
 * @param {unknown} payload
 * @param {number} now
 */
export function buildRouterActivity(payload, now) {
  const data = payload && typeof payload === "object" ? payload.data : null;
  if (!Array.isArray(data)) return null;
  const cur = new Date(now);
  cur.setMinutes(0, 0, 0);
  const curStart = cur.getTime();
  const oldest = curStart - 23 * HOUR_MS;
  const hourly = [];
  for (let i = 0; i < 24; i++) hourly.push({ hourStart: oldest + i * HOUR_MS, ok: 0, rejected: 0, failed: 0 });
  const lastHour = { ok: 0, rejected: 0, failed: 0 };
  const errors = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const at = Date.parse(row.timestamp);
    const status = Number(row.resp_status_code);
    if (!Number.isFinite(at) || !Number.isFinite(status) || status < 100) continue;
    const idx = Math.floor((at - oldest) / HOUR_MS);
    if (idx < 0 || idx > 23) continue;
    const field = status === 429 ? "rejected" : status >= 400 ? "failed" : "ok";
    hourly[idx][field] += 1;
    if (at >= now - HOUR_MS) lastHour[field] += 1;
    if (status >= 400) {
      errors.push({
        at,
        model: shortText(row.model) ?? "",
        status,
        message: shortText(row.error_msg),
        src: shortText(row.src),
      });
    }
  }
  errors.sort((a, b) => b.at - a.at);
  return {
    hourly,
    lastHour,
    recentErrors: errors.slice(0, ERROR_ROWS),
    truncated: data.length >= ACTIVITY_LIMIT,
    updatedAt: now,
  };
}

const MAX_MODELS = 200;

/**
 * Configured llama-swap models from /v1/models: aliases and foreign owners out.
 * Returns null when the payload has no model list.
 * @param {unknown} payload
 * @returns {Array<{id: string, name: string|null, loaded: boolean}> | null}
 */
export function parseRouterModels(payload) {
  const data = payload && typeof payload === "object" ? payload.data : null;
  if (!Array.isArray(data)) return null;
  const out = [];
  for (const m of data) {
    if (!m || typeof m !== "object" || !isSwapOwner(m.owned_by)) continue;
    if (m.meta?.llamaswap?.type === "alias") continue;
    const id = boundedString(m.id);
    if (!id || !isSafePathId(id)) continue;
    out.push({ id, name: boundedString(m.name), loaded: m.status?.value === "loaded" });
    if (out.length >= MAX_MODELS) break;
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Cumulative prompt (prefill) tokens from a Prometheus body, summed over all
 * label sets. null when no known series is present.
 * @param {string} txt
 * @returns {number | null}
 */
export function promptTokensFromMetrics(txt) {
  for (const name of [
    "vllm:prompt_tokens_total",
    "sglang:prompt_tokens_total",
    "sglang_prompt_tokens_total",
    "llamacpp:prompt_tokens_total",
  ]) {
    const re = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    if (found) return sum;
  }
  return null;
}

/**
 * A model or prompt id that is safe to put in one URL path segment.
 * `encodeURIComponent` leaves "." and ".." untouched, and the URL parser then
 * resolves them against the path, so `/unload/..` reaches a different route.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSafePathId(id) {
  return typeof id === "string" && id !== "" && id !== "." && id !== "..";
}

const MAX_MODEL_ID_CHARS = 200;
const MAX_PROMPT_ID_CHARS = 64;

/**
 * The video studio holding the GPU among the router's running rows, or null.
 * A studio row is the probe's own detection (`studio`, from the per-row ComfyUI
 * check) or a running row equal to the video snapshot's studio.
 * @param {string[]} runningModels
 * @param {{ model: string, name?: string | null } | null | undefined} studio
 * @param {any} video
 * @returns {{ model: string, name: string } | null}
 */
function residentStudio(runningModels, studio, video) {
  const fromProbe = studio?.model && runningModels.includes(studio.model) ? studio : null;
  const vs = video?.studio;
  const fromVideo = vs?.model && runningModels.includes(vs.model) ? vs : null;
  const pick = fromProbe ?? fromVideo;
  if (!pick) return null;
  return { model: pick.model, name: pick.name || fromVideo?.name || fromProbe?.name || pick.model };
}

/**
 * Whether the studio's render queue is known and empty. Fails closed: with no
 * snapshot, an unavailable one, or one that names another studio, the queue
 * is unknown and the GPU must be treated as held.
 * @param {{ model: string }} resident
 * @param {any} video
 * @returns {{ kind: "unknown" } | { kind: "busy", running: number, queued: number } | { kind: "idle" }}
 */
function studioQueue(resident, video) {
  if (!video || video.available !== true || video.studio?.model !== resident.model) {
    return { kind: "unknown" };
  }
  const running = Number(video.queueRunning) || 0;
  const queued = Number(video.queuePending) || 0;
  return running + queued > 0 ? { kind: "busy", running, queued } : { kind: "idle" };
}

/**
 * Decide whether a llama-swap load/unload may proceed. Pure: the route does the I/O.
 * @param {object} p
 * @param {"load" | "unload"} p.action
 * @param {unknown} p.model
 * @param {string[]} p.runningModels models in the router's last /running rows
 * @param {{ model: string, name?: string | null } | null} p.studio the probe's detected studio
 * @param {Array<{ id: string, loaded: boolean }>} p.routerModels configured models
 * @param {any} p.video the monitor's last video snapshot (may be missing)
 * @param {boolean} p.loadInFlight
 * @returns {null | { status: number, error: string }} null = allowed
 */
export function routerActionVerdict({ action, model, runningModels, studio, routerModels, video, loadInFlight }) {
  if (typeof model !== "string" || !model || model.length > MAX_MODEL_ID_CHARS || !isSafePathId(model)) {
    return { status: 400, error: "model must be a model id (max 200 characters, not '.' or '..')" };
  }
  const running = runningModels.includes(model);
  const resident = residentStudio(runningModels, studio, video);
  const queue = resident ? studioQueue(resident, video) : null;
  const unknown = () => ({ status: 409, error: `GPU held by video studio ${resident?.name} (state unknown)` });

  if (action === "unload") {
    if (!running) return { status: 409, error: `${model} is not running` };
    if (resident?.model === model && queue) {
      if (queue.kind === "unknown") return unknown();
      if (queue.kind === "busy") {
        return {
          status: 409,
          error: `Video studio ${resident.name} has ${queue.running} running and ${queue.queued} queued render(s); cancel the renders first`,
        };
      }
    }
    return null;
  }

  if (!routerModels.some((m) => m.id === model)) {
    return { status: 409, error: `${model} is not a configured model` };
  }
  if (routerModels.some((m) => m.id === model && m.loaded)) {
    return { status: 409, error: `${model} is already loaded` };
  }
  if (running) return { status: 409, error: `${model} is already running or loading` };
  if (resident && queue) {
    if (queue.kind === "unknown") return unknown();
    if (queue.kind === "busy") {
      return {
        status: 409,
        error: `GPU held by video studio ${resident.name} (${queue.running} running, ${queue.queued} queued)`,
      };
    }
  }
  if (loadInFlight) return { status: 409, error: "A model load is already in flight" };
  return null;
}

/**
 * Decide whether a studio render may be cancelled. Pure: the route does the I/O.
 * @param {object} p
 * @param {unknown} p.promptId
 * @param {number | null} p.studioPort port of the resident, ready studio, else null
 * @param {"running" | "pending" | null} p.jobState where the prompt sits in the studio queue
 * @returns {null | { status: number, error: string }} null = allowed
 */
export function videoCancelVerdict({ promptId, studioPort, jobState }) {
  if (typeof promptId !== "string" || !promptId || promptId.length > MAX_PROMPT_ID_CHARS || !isSafePathId(promptId)) {
    return { status: 400, error: "promptId is required (max 64 characters, not '.' or '..')" };
  }
  if (studioPort == null) return { status: 409, error: "No video studio is resident" };
  if (jobState == null) return { status: 409, error: "Job is not in the studio queue" };
  return null;
}
