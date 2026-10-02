/**
 * VideoStudioProbe — a ComfyUI "video studio" (ltx-studio, h3-studio) run by llama-swap.
 *
 * llama-swap lists a resident studio in GET /running next to the LLM engines. While one is
 * resident it holds the GPU lease: the chat model is unloaded and chat requests wait inside
 * llama-swap. This probe shows what is rendering, its models, an estimated progress, the
 * queue, recent renders, a 24 h activity chart and how many LLM requests are blocked.
 *
 * SAFETY (see comfyDetect.js): the only llama-swap endpoints used are `GET /running` and
 * `GET /api/events` (SSE, read once then aborted). Studio traffic goes straight to the
 * upstream origin from /running (`upstreamBase`), never through llama-swap's
 * /upstream/<model>/ path, and nothing is ever POSTed. Request headers and remote IPs from
 * /api/events are never read into the snapshot.
 *
 * Progress is an ESTIMATE: ComfyUI only sends step progress to the submitting client_id, so
 * elapsed time is compared with the median duration of recent successful renders.
 */
import { llmProbeHost } from "./llmHost.js";
import { summarizeComfyPrompt } from "./ComfyProbe.js";
import {
  detectComfyUpstream,
  readJsonCapped,
  noteComfyModel,
  isKnownComfyModel,
} from "./comfyDetect.js";
import { parseRunning, isReadyState, isLoadingState, upstreamBase } from "./swapRouter.js";

const FETCH_TIMEOUT_MS = 3000;
const EVENTS_TIMEOUT_MS = 3000;
/** Hard cap on SSE bytes read while hunting for the inflight snapshot (log lines are large). */
const EVENTS_MAX_BYTES = 4 * 1024 * 1024;
const HISTORY_EVERY_MS = 30_000;
const HISTORY_ITEMS = 200;
/** Body caps: /running is tiny, /queue carries whole prompt graphs, /history is ~26 KB per entry. */
const RUNNING_MAX_BYTES = 256 * 1024;
const QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
/** Traversal bounds, independent of the byte caps. */
const MAX_HISTORY_ENTRIES = 200;
const MAX_OUTPUT_NODES = 50;
const MAX_RECORDS_PER_NODE = 50;
const MAX_GRAPH_NODES = 500;
const MAX_STUDIO_MODELS = 16;
const LLM_WAIT_EVERY_MS = 10_000;
const HOUR_MS = 3_600_000;
const HOURS = 24;
const MAX_PENDING = 10;
const MAX_RECENT = 12;
const MAX_OUTPUTS = 8;
const MAX_MODELS_PER_BUCKET = 8;
const MAX_WAIT_MODELS = 8;
const ETA_SAMPLES = 8;
const MAX_STR = 200;

/** @param {unknown} v @returns {number | null} */
function numOrNull(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** @param {unknown} v @param {number} [max] @returns {string | null} */
function str(v, max = MAX_STR) {
  return typeof v === "string" && v ? v.slice(0, max) : null;
}

/** @param {string} p */
function basename(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** @param {unknown} e @returns {string} */
function shortError(e) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").slice(0, 120);
}

// ─── Pure helpers (exported for tests) ──────────────────────

const MODEL_INPUT_KEY_RE = /^(?:unet|ckpt|clip|vae|lora|model)_name\d*$/;
const FRAME_KEYS = ["length", "frames", "num_frames", "video_frames"];

/**
 * @param {string} classType
 * @returns {"diffusion" | "textEncoders" | "vae" | "loras" | null}
 */
function modelBucket(classType) {
  if (/Lora/.test(classType)) return "loras";
  if (classType === "VAELoader") return "vae";
  if (classType === "CLIPLoader" || classType === "DualCLIPLoader" || /TextEncoder/.test(classType)) {
    return "textEncoders";
  }
  if (classType === "UNETLoader" || classType.startsWith("CheckpointLoader") || /UNET/.test(classType)) {
    return "diffusion";
  }
  return null;
}

/**
 * Summarize a ComfyUI prompt graph: model buckets (basenames, deduped), frame count and
 * the footprint fields from summarizeComfyPrompt.
 * @param {unknown} graph
 * @returns {{ models: import("./VideoStudioProbe.js").VideoModelsShape, frames: number | null, width: number | null, height: number | null, steps: number | null }}
 */
export function summarizeVideoGraph(graph) {
  /** @type {Record<"diffusion" | "textEncoders" | "vae" | "loras", string[]>} */
  const models = { diffusion: [], textEncoders: [], vae: [], loras: [] };
  /** @type {number | null} */
  let frames = null;
  const g = graph && typeof graph === "object" && !Array.isArray(graph) ? graph : {};
  const bounded = Object.entries(g).slice(0, MAX_GRAPH_NODES);
  for (const [, node] of bounded) {
    if (!node || typeof node !== "object") continue;
    const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs : null;
    if (!inputs) continue;
    if (frames == null) {
      for (const key of FRAME_KEYS) {
        const n = numOrNull(inputs[key]);
        if (n != null) {
          frames = n;
          break;
        }
      }
    }
    const bucket = typeof node.class_type === "string" ? modelBucket(node.class_type) : null;
    if (!bucket) continue;
    for (const [key, val] of Object.entries(inputs)) {
      if (typeof val !== "string" || !val || !MODEL_INPUT_KEY_RE.test(key)) continue;
      const name = basename(val).slice(0, MAX_STR);
      const list = models[bucket];
      if (!list.includes(name) && list.length < MAX_MODELS_PER_BUCKET) list.push(name);
    }
  }
  const s = summarizeComfyPrompt(Object.fromEntries(bounded));
  return { models, frames, width: s.width, height: s.height, steps: s.steps };
}

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const AUDIO_EXT = new Set(["flac", "wav", "mp3", "ogg", "opus", "m4a", "aac"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif"]);

/**
 * ComfyUI SaveVideo files are listed under the `images` key (with `animated: [true]`), so
 * the file extension decides; the node's output key is only a fallback.
 * @param {string} filename
 * @param {string} key
 * @returns {"video" | "audio" | "image" | "other"}
 */
function outputKind(filename, key) {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (IMAGE_EXT.has(ext)) return key === "gifs" && ext === "gif" ? "video" : "image";
  if (key === "videos" || key === "gifs") return "video";
  if (key === "audio") return "audio";
  return "other";
}

const KIND_RANK = { video: 0, audio: 1, image: 2, other: 3 };

/**
 * Flatten a history `outputs` map. A render can save hundreds of frame PNGs, so the result
 * is capped at MAX_OUTPUTS with videos first, then audio, then the rest.
 * @param {unknown} outputs
 * @returns {Array<{ filename: string, subfolder: string, kind: "video" | "audio" | "image" | "other" }>}
 */
function flattenOutputs(outputs) {
  const all = [];
  if (outputs && typeof outputs === "object") {
    for (const node of Object.values(outputs).slice(0, MAX_OUTPUT_NODES)) {
      if (!node || typeof node !== "object") continue;
      let records = 0;
      for (const [key, list] of Object.entries(node)) {
        if (!Array.isArray(list)) continue;
        for (const f of list) {
          if (records >= MAX_RECORDS_PER_NODE) break;
          records += 1;
          if (!f || typeof f !== "object") continue;
          const filename = str(f.filename);
          if (!filename) continue;
          all.push({
            filename,
            subfolder: str(f.subfolder) ?? "",
            kind: outputKind(filename, key),
          });
        }
      }
    }
  }
  all.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return all.slice(0, MAX_OUTPUTS);
}

/**
 * Turn GET /history into render jobs, newest first.
 * Duration = terminal message timestamp − execution_start timestamp (both epoch ms).
 * @param {unknown} history
 * @returns {Array<{ promptId: string, status: "success" | "error" | "interrupted" | "unknown", clientId: string | null, startedAt: number | null, endedAt: number | null, durationMs: number | null, outputs: ReturnType<typeof flattenOutputs> }>}
 */
export function jobsFromHistory(history) {
  if (!history || typeof history !== "object" || Array.isArray(history)) return [];
  const jobs = [];
  // ComfyUI lists oldest first, so the newest MAX_HISTORY_ENTRIES are the tail.
  for (const [promptId, entry] of Object.entries(history).slice(-MAX_HISTORY_ENTRIES)) {
    if (!entry || typeof entry !== "object") continue;
    const status = entry.status && typeof entry.status === "object" ? entry.status : {};
    const messages = Array.isArray(status.messages) ? status.messages : [];
    /** @type {Record<string, number | null>} */
    const ts = {};
    for (const m of messages) {
      if (!Array.isArray(m) || typeof m[0] !== "string") continue;
      ts[m[0]] = numOrNull(m[1]?.timestamp);
    }
    /** @type {"success" | "error" | "interrupted" | "unknown"} */
    let jobStatus = "unknown";
    /** @type {number | null} */
    let endedAt = null;
    // ComfyUI reports an interrupted job as status_str "error" too, so check it first.
    if ("execution_interrupted" in ts) {
      jobStatus = "interrupted";
      endedAt = ts.execution_interrupted ?? null;
    } else if ("execution_error" in ts || status.status_str === "error") {
      jobStatus = "error";
      endedAt = ts.execution_error ?? null;
    } else if ("execution_success" in ts || status.status_str === "success") {
      jobStatus = "success";
      endedAt = ts.execution_success ?? null;
    }
    const startedAt = ts.execution_start ?? null;
    const durationMs =
      startedAt != null && endedAt != null && endedAt >= startedAt ? endedAt - startedAt : null;
    const prompt = Array.isArray(entry.prompt) ? entry.prompt : [];
    const clientId = str(prompt[3]?.extra_data?.client_id ?? prompt[3]?.client_id, 64);
    jobs.push({
      promptId: promptId.slice(0, 64),
      status: jobStatus,
      clientId,
      startedAt,
      endedAt,
      durationMs,
      outputs: flattenOutputs(entry.outputs),
    });
  }
  jobs.sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0));
  return jobs;
}

/**
 * 24 hourly buckets, oldest first; the last one is the hour containing `now`.
 * Busy time is SPLIT across hour boundaries: each job's [start, end] is clipped against
 * every bucket it overlaps, so `busyMs` per bucket never exceeds one hour. `renders`
 * counts successful jobs in the hour of their `endedAt`. A job without `startedAt` but
 * with `durationMs` starts at `endedAt - durationMs`; a failed render still occupied the
 * GPU, so it counts as busy time. Jobs ending outside the window are ignored.
 * @param {Array<{ status: string, startedAt?: number | null, endedAt: number | null, durationMs: number | null }>} jobs
 * @param {number} now
 * @returns {Array<{ hourStart: number, renders: number, busyMs: number }>}
 */
export function hourlyBuckets(jobs, now) {
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;
  const first = current - (HOURS - 1) * HOUR_MS;
  const buckets = Array.from({ length: HOURS }, (_, i) => ({
    hourStart: first + i * HOUR_MS,
    renders: 0,
    busyMs: 0,
  }));
  for (const job of jobs) {
    const end = job.endedAt;
    if (end == null || end < first || end >= current + HOUR_MS) continue;
    const endIdx = Math.floor((end - first) / HOUR_MS);
    if (job.status === "success") buckets[endIdx].renders += 1;
    const start =
      job.startedAt ?? (job.durationMs != null ? end - job.durationMs : null);
    if (start == null || start >= end) continue;
    for (let i = Math.max(0, Math.floor((start - first) / HOUR_MS)); i <= endIdx; i++) {
      const b = buckets[i];
      const overlap = Math.min(end, b.hourStart + HOUR_MS) - Math.max(start, b.hourStart);
      if (overlap > 0) b.busyMs = Math.min(HOUR_MS, b.busyMs + overlap);
    }
  }
  return buckets;
}

/** @param {number[]} values */
function median(values) {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Durations of the most recent successful jobs (input is newest first).
 * @param {Array<{ status: string, durationMs: number | null }>} jobs
 * @param {number} [n]
 * @returns {number[]}
 */
export function recentSuccessDurations(jobs, n = ETA_SAMPLES) {
  const out = [];
  for (const j of jobs) {
    if (out.length >= n) break;
    if (j.status === "success" && j.durationMs != null && j.durationMs > 0) out.push(j.durationMs);
  }
  return out;
}

/**
 * Elapsed time against the median of recent durations. Without history the percent and
 * ETA are null; while the job is still running the percent is capped at 99.
 * @param {number} startedAt epoch ms
 * @param {number} now epoch ms
 * @param {number[]} durations ms of recent successful jobs
 * @returns {{ elapsedMs: number, etaMs: number | null, percent: number | null }}
 */
export function estimateProgress(startedAt, now, durations) {
  const elapsedMs = Math.max(0, now - startedAt);
  const med = median(durations);
  if (med == null) return { elapsedMs, etaMs: null, percent: null };
  return {
    elapsedMs,
    etaMs: Math.max(0, Math.round(med - elapsedMs)),
    percent: Math.min(99, Math.floor((elapsedMs / med) * 100)),
  };
}

/**
 * When did a job that was just first seen in queue_running really start? ComfyUI runs jobs
 * back to back, so it started when the previous one ended or when it was queued, whichever
 * is later. Falls back to `firstSeen` when neither is usable (or would be in the future).
 * @param {{ firstSeen: number, createTime: number | null, lastEndedAt: number | null }} p
 */
export function inferStartedAt({ firstSeen, createTime, lastEndedAt }) {
  const candidates = [createTime, lastEndedAt].filter((n) => n != null && n <= firstSeen);
  return candidates.length > 0 ? Math.max(...candidates) : firstSeen;
}

/**
 * Parse one SSE line from llama-swap /api/events. Returns the waiting-request summary when
 * the line is the inflight snapshot, else null. A request counts as waiting unless its
 * model is in `servedModels` (a ready resident engine, or a studio): those requests are
 * being served, not blocked. Any path counts, so non-/v1 routes for an unloaded model are
 * included. Only model names and elapsed times are read: headers and remote IPs never are.
 * @param {string} line
 * @param {Set<string> | string[]} servedModels ready resident models plus known studios
 * @returns {{ waiting: number, oldestMs: number | null, models: string[] } | null}
 */
export function parseInflightLine(line, servedModels = []) {
  if (!line.startsWith("data:") || !line.includes('"inflight"')) return null;
  let outer;
  try {
    outer = JSON.parse(line.slice(5).trim());
  } catch {
    return null;
  }
  if (!outer || outer.type !== "inflight") return null;
  let inner = outer.data;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      return null;
    }
  }
  if (!inner || typeof inner !== "object" || inner.operation !== "snapshot") return null;
  if (!Array.isArray(inner.requests)) return null;
  const served = servedModels instanceof Set ? servedModels : new Set(servedModels);
  let waiting = 0;
  /** @type {number | null} */
  let oldestMs = null;
  /** @type {string[]} */
  const models = [];
  for (const r of inner.requests) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.model !== "string" || !r.model || served.has(r.model)) continue;
    waiting += 1;
    const ms = numOrNull(r.elapsed_ms);
    if (ms != null && (oldestMs == null || ms > oldestMs)) oldestMs = ms;
    const name = r.model.slice(0, 128);
    if (!models.includes(name) && models.length < MAX_WAIT_MODELS) models.push(name);
  }
  return { waiting, oldestMs, models };
}

/**
 * Parse a buffered SSE body: first inflight snapshot wins.
 * @param {string} sseText
 * @param {Set<string> | string[]} [servedModels]
 */
export function parseInflightSnapshot(sseText, servedModels = []) {
  const served = servedModels instanceof Set ? servedModels : new Set(servedModels);
  for (const line of String(sseText).split("\n")) {
    const hit = parseInflightLine(line.replace(/\r$/, ""), served);
    if (hit) return hit;
  }
  return null;
}

// ─── Probe ──────────────────────────────────────────────────

/**
 * @typedef {{ diffusion: string[], textEncoders: string[], vae: string[], loras: string[] }} VideoModelsShape
 */

export class VideoStudioProbe {
  /**
   * @param {object} spark
   * @param {{
   *   routerPorts?: () => number[],
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   * }} [opts] `routerPorts` returns the spark's LLM ports known to be llama-swap routers
   */
  constructor(spark, opts = {}) {
    this.spark = spark;
    this._routerPorts = typeof opts.routerPorts === "function" ? opts.routerPorts : () => [];
    this._fetch = opts.fetchImpl ?? ((...args) => fetch(...args));
    this._now = opts.now ?? Date.now;
    this._disposed = false;
    /** @type {AbortController | null} */
    this._eventsAbort = null;
    this._reset();
  }

  _reset() {
    /** @type {number | null} sticky: a router stays the target across a transient LlmProbe reset */
    this._port = null;
    /** @type {{ model: string, name: string | null, description: string | null, port: number | null, comfyVersion: string | null } | null} */
    this._lastStudio = null;
    /** @type {Set<string>} */
    this._studioModels = new Set();
    this._jobs = [];
    this._historyAt = 0;
    /** @type {string | null | undefined} undefined = nothing polled yet */
    this._lastRunningId = undefined;
    /** @type {{ promptId: string, startedAt: number } | null} */
    this._activeSeen = null;
    this._queueRunning = 0;
    this._queuePending = 0;
    this._active = null;
    this._pending = [];
    this._llmWait = null;
    this._llmWaitAt = 0;
  }

  /** @param {object} spark */
  setTarget(spark) {
    const prevHost = llmProbeHost(this.spark);
    this.spark = spark ?? this.spark;
    if (llmProbeHost(this.spark) !== prevHost) this._reset();
    else this._port = null;
  }

  /** Abort any in-flight SSE read. */
  dispose() {
    this._disposed = true;
    try {
      this._eventsAbort?.abort();
    } catch {
      /* ignore */
    }
  }

  /** @param {number} port */
  _apiKey(port) {
    const keys = this.spark?.llmApiKeys;
    if (!keys || typeof keys !== "object") return null;
    const raw = keys[String(port)] ?? keys[port];
    const key = raw != null ? String(raw).trim() : "";
    return key || null;
  }

  /**
   * GET that never follows redirects: a 3xx from an upstream must not move the request
   * (and its Authorization header) somewhere the operator did not approve.
   * @param {string} url
   * @param {Record<string, string>} [headers]
   */
  _get(url, headers = {}) {
    return this._fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
      redirect: "manual",
    });
  }

  /**
   * Non-2xx (3xx included) is a failure; the body is read under `maxBytes`.
   * @param {string} url
   * @param {Record<string, string> | undefined} headers
   * @param {number} maxBytes
   */
  async _getJson(url, headers, maxBytes) {
    const res = await this._get(url, headers);
    if (!res.ok) {
      void res.body?.cancel?.().catch?.(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    return readJsonCapped(res, maxBytes);
  }

  /**
   * Read /api/events until the inflight snapshot, then abort the connection.
   * @param {string} base
   * @param {Record<string, string>} headers
   * @param {Set<string>} servedModels ready resident models plus known studios (never "waiting")
   */
  async _readInflight(base, headers, servedModels) {
    const ac = new AbortController();
    this._eventsAbort = ac;
    const timer = setTimeout(() => ac.abort(), EVENTS_TIMEOUT_MS);
    /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
    let reader = null;
    try {
      const res = await this._fetch(`${base}/api/events`, {
        signal: ac.signal,
        headers: { ...headers, Accept: "text/event-stream" },
        redirect: "manual",
      });
      if (!res.ok || !res.body) return null;
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let tail = "";
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        bytes += value.byteLength;
        if (bytes > EVENTS_MAX_BYTES) return null;
        tail += decoder.decode(value, { stream: true });
        const cut = tail.lastIndexOf("\n");
        if (cut < 0) continue;
        const complete = tail.slice(0, cut);
        tail = tail.slice(cut + 1);
        for (const line of complete.split("\n")) {
          const hit = parseInflightLine(line.replace(/\r$/, ""), servedModels);
          if (hit) return hit;
        }
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      ac.abort();
      if (reader) void reader.cancel().catch(() => {});
      if (this._eventsAbort === ac) this._eventsAbort = null;
    }
  }

  /**
   * Find the resident ComfyUI studio among /running rows (ready preferred over loading).
   * @param {import("./swapRouter.js").RunningRow[]} rows
   * @param {string} base
   */
  async _findResidentStudio(rows, base) {
    const candidates = rows
      .filter((r) => isReadyState(r.state) || isLoadingState(r.state))
      .map((row) => ({ row, origin: upstreamBase(row.proxy, base) }));
    const checks = await Promise.all(
      candidates.map(async (c) => {
        // A starting studio has no /system_stats yet; its name was confirmed as ComfyUI
        // earlier, which is enough to tell it from an LLM that is loading.
        if (!isReadyState(c.row.state) && isKnownComfyModel(c.origin, c.row.model)) {
          const prev = this._lastStudio?.model === c.row.model ? this._lastStudio : null;
          return { ...c, comfy: true, version: prev?.comfyVersion ?? null };
        }
        if (!c.origin) return { ...c, comfy: false, version: null };
        const detect = await detectComfyUpstream(c.origin, {
          fetchImpl: this._fetch,
          now: this._now(),
        });
        return { ...c, comfy: detect.isComfy, version: detect.version };
      })
    );
    const studios = checks.filter((c) => c.comfy);
    for (const s of studios) {
      noteComfyModel(s.origin, s.row.model);
      this._noteStudioModel(s.row.model);
    }
    const pick = studios.find((s) => isReadyState(s.row.state)) ?? studios[0];
    if (!pick) return null;
    const portNum = pick.origin ? Number(new URL(pick.origin).port) : NaN;
    return {
      origin: pick.origin,
      state: /** @type {"ready" | "loading"} */ (isReadyState(pick.row.state) ? "ready" : "loading"),
      info: {
        model: pick.row.model,
        name: pick.row.name,
        description: pick.row.description,
        port: Number.isInteger(portNum) && portNum > 0 ? portNum : null,
        comfyVersion: pick.version,
      },
    };
  }

  /** @param {string} model */
  _noteStudioModel(model) {
    this._studioModels.delete(model);
    if (this._studioModels.size >= MAX_STUDIO_MODELS) {
      const oldest = this._studioModels.values().next().value;
      if (oldest !== undefined) this._studioModels.delete(oldest);
    }
    this._studioModels.add(model);
  }

  /**
   * Queue every poll, history at most every 30 s or when the running prompt changes.
   * @param {string} origin
   * @param {number} now
   * @returns {Promise<string[]>} errors
   */
  async _pollStudio(origin, now) {
    /** @type {string[]} */
    const errors = [];
    /** @type {{ running: any[], pending: any[] } | null} */
    let queue = null;
    try {
      const q = await this._getJson(`${origin}/queue`, undefined, QUEUE_MAX_BYTES);
      queue = {
        running: Array.isArray(q?.queue_running) ? q.queue_running : [],
        pending: Array.isArray(q?.queue_pending) ? q.queue_pending : [],
      };
    } catch (err) {
      errors.push(`queue: ${shortError(err)}`);
    }

    const runningItem = queue?.running[0];
    const runningId = queue ? (str(runningItem?.[1], 64) ?? null) : this._lastRunningId;
    const changed = queue != null && this._lastRunningId !== undefined && runningId !== this._lastRunningId;
    let historyFresh = false;
    if (changed || now - this._historyAt >= HISTORY_EVERY_MS) {
      try {
        const h = await this._getJson(
          `${origin}/history?max_items=${HISTORY_ITEMS}`,
          undefined,
          HISTORY_MAX_BYTES
        );
        this._jobs = jobsFromHistory(h);
        this._historyAt = now;
        historyFresh = true;
      } catch (err) {
        this._historyAt = now; // do not hammer a failing endpoint every poll
        errors.push(`history: ${shortError(err)}`);
      }
    }

    if (queue) {
      this._lastRunningId = runningId;
      this._queueRunning = queue.running.length;
      this._queuePending = queue.pending.length;
      this._active = runningItem ? this._buildActive(runningItem, now, historyFresh) : null;
      if (!runningItem) this._activeSeen = null;
      this._pending = queue.pending
        .filter((it) => Array.isArray(it) && it[1] != null)
        .sort((a, b) => (numOrNull(a[0]) ?? 0) - (numOrNull(b[0]) ?? 0))
        .slice(0, MAX_PENDING)
        .map((it) => ({
          promptId: String(it[1]).slice(0, 64),
          clientId: str(it[3]?.client_id, 64),
          queuedAt: numOrNull(it[3]?.create_time),
        }));
    }
    return errors;
  }

  /**
   * @param {any[]} item [number, promptId, graph, extraData, outputsToExecute]
   * @param {number} now
   * @param {boolean} historyFresh history was fetched in this very poll
   */
  _buildActive(item, now, historyFresh) {
    const promptId = String(item[1]).slice(0, 64);
    const extra = item[3] && typeof item[3] === "object" ? item[3] : {};
    if (this._activeSeen?.promptId !== promptId) {
      const lastEndedAt = historyFresh
        ? (this._jobs.find((j) => j.endedAt != null)?.endedAt ?? null)
        : null;
      this._activeSeen = {
        promptId,
        startedAt: inferStartedAt({
          firstSeen: now,
          createTime: numOrNull(extra.create_time),
          lastEndedAt,
        }),
      };
    }
    const { startedAt } = this._activeSeen;
    const g = summarizeVideoGraph(item[2]);
    const est = estimateProgress(startedAt, now, recentSuccessDurations(this._jobs));
    return {
      promptId,
      clientId: str(extra.client_id, 64),
      startedAt,
      elapsedMs: est.elapsedMs,
      etaMs: est.etaMs,
      percent: est.percent,
      models: g.models,
      width: g.width,
      height: g.height,
      frames: g.frames,
      steps: g.steps,
    };
  }

  /**
   * @param {{ reached: boolean, error?: string | null, studioState?: "ready" | "loading" | "unloaded" | null, now: number }} p
   */
  _snapshot({ reached, error, studioState, now }) {
    const studio =
      this._lastStudio && studioState ? { ...this._lastStudio, state: studioState } : null;
    /** @type {Record<string, unknown>} */
    const out = {
      available: reached && this._lastStudio != null,
      studio,
      queueRunning: this._queueRunning,
      queuePending: this._queuePending,
      active: this._active,
      pending: this._pending,
      recent: this._jobs.slice(0, MAX_RECENT).map((j) => ({
        promptId: j.promptId,
        status: j.status,
        clientId: j.clientId,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        durationMs: j.durationMs,
        outputs: j.outputs,
      })),
      hourly: hourlyBuckets(this._jobs, now),
      llmWait: this._llmWait,
      updatedAt: now,
    };
    if (error) out.error = error;
    return out;
  }

  /**
   * One poll. Never throws. Returns null when none of the spark's LLM ports is a
   * llama-swap router (the video panel is only for routed studios).
   * @returns {Promise<object | null>}
   */
  async probe() {
    if (this._disposed) return null;
    const now = this._now();
    try {
      if (this._port == null || !this._routerPorts().includes(this._port)) {
        const known = this._routerPorts()[0];
        if (known != null) this._port = known;
      }
      const host = llmProbeHost(this.spark);
      if (this._port == null || !host) return null;
      const base = `http://${host}:${this._port}`;
      const key = this._apiKey(this._port);
      const headers = key ? { Authorization: `Bearer ${key}` } : {};

      /** @type {import("./swapRouter.js").RunningRow[] | null} */
      let rows;
      /** @type {string | null} */
      let routerError = null;
      try {
        rows = parseRunning(await this._getJson(`${base}/running`, headers, RUNNING_MAX_BYTES));
      } catch (err) {
        rows = null;
        routerError = `llama-swap: ${shortError(err)}`;
      }
      if (rows == null) {
        // Router unreachable: nothing is known to be waiting, so do not replay the
        // last count as if it were current.
        this._llmWait = null;
        this._llmWaitAt = 0;
        return this._snapshot({
          reached: false,
          error: routerError ?? "llama-swap: unexpected /running payload",
          studioState: this._lastStudio ? "unloaded" : null,
          now,
        });
      }

      const resident = await this._findResidentStudio(rows, base);
      /** @type {string[]} */
      let errors = [];
      /** @type {"ready" | "loading" | "unloaded" | null} */
      let studioState = null;
      if (resident) {
        this._lastStudio = resident.info;
        studioState = resident.state;
        if (resident.state === "ready" && resident.origin) {
          errors = await this._pollStudio(resident.origin, now);
        } else {
          this._clearLive();
        }
      } else if (this._lastStudio) {
        studioState = "unloaded";
        this._clearLive();
      }

      // llmWait only means something while a studio holds the GPU lease; with none
      // resident, nothing is blocked on it and /api/events is not even opened.
      if (resident) {
        if (now - this._llmWaitAt >= LLM_WAIT_EVERY_MS) {
          this._llmWaitAt = now;
          const served = new Set(rows.filter((r) => isReadyState(r.state)).map((r) => r.model));
          for (const m of this._studioModels) served.add(m);
          this._llmWait = await this._readInflight(base, headers, served);
        }
      } else {
        this._llmWait = null;
        this._llmWaitAt = 0;
      }

      if (this._disposed) return null;
      return this._snapshot({
        reached: true,
        error: errors.length > 0 ? errors.join("; ").slice(0, 200) : null,
        studioState,
        now,
      });
    } catch (err) {
      return this._snapshot({
        reached: false,
        error: shortError(err),
        studioState: this._lastStudio ? "unloaded" : null,
        now,
      });
    }
  }

  /** Drop live render state; recent jobs and the history cache are kept. */
  _clearLive() {
    this._queueRunning = 0;
    this._queuePending = 0;
    this._active = null;
    this._activeSeen = null;
    this._pending = [];
    this._lastRunningId = undefined;
  }
}
