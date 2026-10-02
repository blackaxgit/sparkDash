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
