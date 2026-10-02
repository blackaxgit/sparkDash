/**
 * Is a llama-swap upstream a ComfyUI server (a "video studio") rather than an LLM engine?
 *
 * llama-swap lists every resident member in GET /running, including ComfyUI studios
 * (ltx-studio, h3-studio) that have no /metrics and no chat API. Both the LLM probe (to
 * keep studios out of engine selection) and the video probe (to find them) ask this.
 *
 * Callers pass the upstream ORIGIN from swapRouter.upstreamBase() — never a llama-swap
 * /upstream/<model>/ path, because a request through llama-swap can load a model.
 *
 * Results are cached per origin: a confirmed studio for 5 min, a confirmed non-studio
 * (answered, but not ComfyUI) for 60 s, and a network failure for 10 s so a studio that
 * was briefly unreachable is not misclassified for long. A failure never downgrades an
 * origin that was already confirmed as ComfyUI: the positive verdict is kept and only the
 * (short) failure TTL applies, so the next poll re-checks it soon.
 *
 * Safety: requests use `redirect: "manual"` and any non-2xx (3xx included) is "not ComfyUI",
 * so a hostile upstream cannot bounce the dashboard somewhere else. Bodies are read under a
 * byte cap (`readJsonCapped`).
 */

const COMFY_TTL_MS = 5 * 60_000;
const NOT_COMFY_TTL_MS = 60_000;
const FAILED_TTL_MS = 10_000;
const DETECT_TIMEOUT_MS = 2_000;
const STATS_MAX_BYTES = 64 * 1024;
const MAX_ORIGINS = 64;
const MAX_KNOWN_MODELS = 16;
const MAX_MODEL_CHARS = 256;

/** @typedef {{ isComfy: boolean, version: string | null, failed: boolean, at: number }} ComfyDetect */

/** @type {Map<string, ComfyDetect>} */
const cache = new Map();

/** Model names confirmed as ComfyUI at some point (insertion order = age). */
/** @type {Set<string>} */
const knownModels = new Set();

/** @param {ComfyDetect} entry */
function ttl(entry) {
  if (entry.failed) return FAILED_TTL_MS;
  return entry.isComfy ? COMFY_TTL_MS : NOT_COMFY_TTL_MS;
}

/** Drop the oldest entry when inserting a new origin into a full cache. */
function makeRoom(origin) {
  if (cache.has(origin) || cache.size < MAX_ORIGINS) return;
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, entry] of cache) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at;
      oldestKey = key;
    }
  }
  if (oldestKey != null) cache.delete(oldestKey);
}

/**
 * Parse a JSON body while reading at most `maxBytes`. A longer body aborts the read and
 * throws, so a hostile or runaway endpoint cannot make the dashboard buffer megabytes.
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
export async function readJsonCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel?.().catch?.(() => {});
    throw new Error(`response over ${maxBytes} bytes`);
  }
  const body = res.body;
  if (!body || typeof body.getReader !== "function") return res.json();
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @param {string} origin upstream origin, e.g. "http://127.0.0.1:8189"
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [opts]
 * @returns {Promise<ComfyDetect>}
 */
export async function detectComfyUpstream(origin, { fetchImpl = fetch, now = Date.now() } = {}) {
  const hit = cache.get(origin);
  if (hit && now - hit.at < ttl(hit)) return hit;

  /** @type {ComfyDetect} */
  let entry = { isComfy: false, version: null, failed: false, at: now };
  try {
    const res = await fetchImpl(`${origin}/system_stats`, {
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
      redirect: "manual",
    });
    if (res.ok) {
      const body = await readJsonCapped(res, STATS_MAX_BYTES);
      const version = body?.system?.comfyui_version;
      if (typeof version === "string" && version.length > 0) {
        entry = { isComfy: true, version: version.slice(0, 64), failed: false, at: now };
      }
    } else {
      void res.body?.cancel?.().catch?.(() => {});
      // A confirmed studio that now answers oddly (busy, restarting) keeps its verdict.
      if (hit?.isComfy) entry = { ...hit, failed: true, at: now };
    }
  } catch {
    entry =
      hit?.isComfy === true
        ? { ...hit, failed: true, at: now }
        : { isComfy: false, version: null, failed: true, at: now };
  }
  makeRoom(origin);
  cache.set(origin, entry);
  return entry;
}

/** Cached verdict without I/O: true only for an origin already confirmed as ComfyUI. */
export function isKnownComfyUpstream(origin) {
  return cache.get(origin)?.isComfy === true;
}

/**
 * Remember that a llama-swap model, served from this upstream origin, is a ComfyUI
 * studio, so a row that is still "starting" (its /system_stats is not up yet) is
 * recognised. Keyed by origin AND name: a name alone could be claimed by any row of a
 * hostile /running and turn an LLM into a "studio".
 * @param {string | null} origin
 * @param {string} model
 */
export function noteComfyModel(origin, model) {
  if (typeof origin !== "string" || !origin) return;
  if (typeof model !== "string" || !model || model.length > MAX_MODEL_CHARS) return;
  const key = `${origin} ${model}`;
  knownModels.delete(key); // re-insert as newest
  if (knownModels.size >= MAX_KNOWN_MODELS) {
    const oldest = knownModels.values().next().value;
    if (oldest !== undefined) knownModels.delete(oldest);
  }
  knownModels.add(key);
}

/**
 * @param {string | null} origin
 * @param {string} model
 */
export function isKnownComfyModel(origin, model) {
  if (typeof origin !== "string" || !origin) return false;
  return knownModels.has(`${origin} ${model}`);
}

/** Test hook. */
export function resetComfyDetectCache() {
  cache.clear();
  knownModels.clear();
}
