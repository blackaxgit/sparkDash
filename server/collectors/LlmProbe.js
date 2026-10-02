/**
 * LlmProbe — probes an LLM server on port 8888, auto-detects backend,
 * computes live tokens/sec (generation + prefill).
 *
 * Ported from legacy `probeLlamaServerType` and `_getLlamaMetricsFor`.
 */
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { classifyHostScope } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";
import { fetch as undiciFetch } from "undici";
import { generationTokensFromMetrics, LLM_STREAM_AGENT } from "./LlmStreaming.js";
import {
  isSwapOwner,
  parseRunning,
  isReadyState,
  isLoadingState,
  upstreamBase,
  processStartTime,
  pickNewestEngine,
  diffRouterRows,
  buildRouterActivity,
  ACTIVITY_LIMIT,
  isSafePathId,
  parseRouterModels,
  promptTokensFromMetrics,
} from "./swapRouter.js";
import { detectComfyUpstream, isKnownComfyModel, noteComfyModel, readJsonCapped } from "./comfyDetect.js";

/** llama-swap /running lists a handful of rows; a bigger body is hostile or broken. */
const RUNNING_MAX_BYTES = 256 * 1024;
/** The activity page is up to 999 rows (~300 KB); a bigger body is broken or hostile. */
const ACTIVITY_MAX_BYTES = 1_500_000;
const MODELS_MAX_BYTES = 512 * 1024;
/** Activity and the model list are read at most this often, inside the router poll. */
const ROUTER_REFRESH_MS = 60_000;
/** An activity endpoint that 404s (older llama-swap) is asked again this rarely. */
const ACTIVITY_MISSING_BACKOFF_MS = 10 * 60_000;
/** A failing activity/model read backs off 1, 2, 4… minutes up to this cap. */
const ROUTER_FEED_BACKOFF_MAX_MS = 10 * 60_000;
const ACTIVITY_TIMEOUT_MS = 5_000;
const ROUTER_UNLOAD_TIMEOUT_MS = 60_000;
/** A model load queued behind a video studio can wait a long time. */
const ROUTER_LOAD_TIMEOUT_MS = 20 * 60_000;

const FAIL_RESET_THRESHOLD = 3;
const REDETECT_INTERVAL_MS = 60_000;
/** Current SGLang names first. Deprecated aliases still work but log a warning per hit. */
const SGLANG_SERVER_INFO_PATHS = ["/server_info", "/get_server_info"];
const SGLANG_MODEL_INFO_PATHS = ["/model_info", "/get_model_info"];
/**
 * SGLang's last_gen_throughput is a sticky gauge (holds last decode rate when
 * idle). Only treat it as live after we observe a change between polls, and
 * expire back to 0 if it stops changing.
 */
const SGLANG_STICKY_TPS_LIVE_MS = 6_000;
/**
 * Consecutive failed scrapes of the followed engine before the panel hands
 * over to another resident one. A busy engine can miss a 3 s probe; only a
 * run of misses means it is really gone.
 */
const SWAP_FAILOVER_MISSES = 3;

/**
 * Prefer a short model id when the server returns a Hugging Face hub cache path.
 * e.g. /root/.cache/huggingface/hub/models--org--Name/snapshots/<hash>
 *   → org/Name
 * @param {unknown} id
 * @returns {string | null}
 */
export function normalizeModelId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;

  const hub = s.match(/(?:^|\/)models--([^/]+?)(?:\/snapshots\/[^/]+)?\/?$/);
  if (hub) return hub[1].replace(/--/g, "/");

  const mid = s.match(/models--([^/]+)\/snapshots\//);
  if (mid) return mid[1].replace(/--/g, "/");

  return s;
}

/** True when `id` looks like a Hugging Face hub cache directory (models--org--name). */
export function isHfHubCachePath(id) {
  if (id == null) return false;
  return /(?:^|\/)models--[^/]+/.test(String(id));
}

/**
 * Set modelId (always normalized) and modelPath (omit HF hub cache paths —
 * they duplicate the short id and clutter the LLM panel).
 * @param {unknown} raw
 */
function applyModelRef(probe, raw) {
  if (raw == null || raw === "") return;
  const s = String(raw);
  probe.modelId = normalizeModelId(s);
  probe.modelPath = isHfHubCachePath(s) ? null : s;
}

export class LlmProbe {
  constructor(spark, port = 8888) {
    this.spark = spark;
    this.port = port;
    this.baseUrl = `http://${llmProbeHost(spark)}:${port}`;

    // State
    this.backendType = null; // 'vllm' | 'llama.cpp' | 'sglang' | 'ds4' | 'exl3' | 'q27' | 'tensorfold' | null
    this.serverIsOpenAI = null; // true = OpenAI-compatible
    /** "llama-swap" when this port is a model router, else null. */
    this.router = null;
    /** Router key of the engine the panel is showing (what clients must send). */
    this.routerModel = null;
    /** Human label for that model from the router config. */
    this.routerModelName = null;
    /** Router key of a model that is mid-load (cold start), else null. */
    this.routerLoading = null;
    /** Resident ComfyUI video studio holding the GPU (not an LLM engine), else null. */
    this.studio = null;
    /** True once the resolved engine's /v1/models has been read. */
    this._engineInfoRead = false;
    /** Models holding memory behind the router right now. */
    this.routerResident = 0;
    /** Base URL of the resolved upstream engine, else null. */
    this.engineUrl = null;
    /** `${model}@${processStart}` — changes on every swap or engine restart. */
    this.engineId = null;
    /** Consecutive polls the followed engine failed to answer. */
    this._swapMisses = 0;
    /**
     * Per-resident-model generated tokens and live rate.
     * @type {Map<string, {engineId: string, name: string|null, total: number, tps: number, promptTotal: number|null, promptTps: number, at: number}>}
     */
    this._engineStats = new Map();
    /** Last /running rows (null before the first poll); the router action routes check against them. */
    this._routerRows = null;
    /** Per-model state of the previous poll, for event diffing. Null until the first poll seeds it. */
    this._routerPrev = null;
    /** @type {import("../../src/api/types").LlmRouterEvent[]} Newest first, max 10. */
    this.routerEvents = [];
    /** @type {import("../../src/api/types").LlmRouterActivity | null} */
    this.routerActivity = null;
    /** @type {import("../../src/api/types").LlmRouterModel[]} */
    this.routerModels = [];
    this._activityNextAt = 0;
    this._modelsNextAt = 0;
    /** In-flight background reads (single-flight); null when idle. */
    this._activityRun = null;
    this._modelsRun = null;
    /** Consecutive failures and logged state per router feed, for backoff and log-once. */
    this._feedHealth = { activity: { fails: 0, failing: false }, models: { fails: 0, failing: false } };
    /** True while a fire-and-forget model load is outstanding. */
    this._routerLoadInFlight = false;
    /** Whether /v1/models (or /slots) answered without credentials. null = unknown. */
    this.authOpen = null;
    this.stepId = 0;
    this.modelId = null;
    this.modelPath = null;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.generationTps = 0;
    this.prefillTps = 0;
    /** Live cached-prefill tok/s when the backend splits kinds (ds4 / llama.cpp / sglang). null otherwise. */
    this.cachedPrefillTps = null;
    /** Live uncached/computed prefill tok/s when split is available. null otherwise. */
    this.uncachedPrefillTps = null;
    this.error = null;

    // Per-slot rate tracking (for llama.cpp native path)
    this.slotState = new Map();
    /** Monotonic prefill counters rebuilt from same-task slot deltas (llama.cpp). */
    this._llamaCachedCum = 0;
    this._llamaComputedCum = 0;
    /** null = untried, false = server has no /metrics (don't re-probe). */
    this._llamaMetricsOk = null;
    /** Monotonic tokens_predicted_total; null when /metrics did not answer. */
    this._llamaCumulative = null;
    this.lastTokenCounts = { input: 0, output: 0 };
    /** Previous prefill counters by kind; null until first labeled sample. */
    this.lastPrefillKinds = null;
    /** Previous vLLM TTFT histogram `_sum` (seconds). null until first sample. */
    this.lastTtftSum = null;
    /** Previous vLLM TTFT histogram `_count` (requests). null until first sample. */
    this.lastTtftCount = null;
    /** Previous `vllm:iteration_tokens_total_sum` (engine-step tokens). */
    this.lastIterSum = null;
    this.lastProbeTime = 0;

    // Cumulative total output tokens (generation) as reported by the LLM server
    this.totalOutputTokens = 0;
    /** Cumulative total prompt (prefill) tokens as reported by the LLM server. */
    this.totalPromptTokens = null;
    /**
     * Cumulative cached (prefix-cache served) prompt tokens, when the backend
     * reports the split. Subset of totalPromptTokens (for ds4/q27 the raw
     * prefill counter is computed-only, so prompt = computed + cached).
     */
    this.totalCachedTokens = null;

    // vLLM inference metrics from /metrics (null when not vLLM / missing series)
    // Metric names follow stock vLLM Prometheus exposition (versions may differ).
    this.kvCacheUsage = null; // 0–1 fraction
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    /** Live recent-window mean TTFT (seconds) from histogram sum/count deltas. null when unavailable. */
    this.ttftSeconds = null;
    this.preemptionsTotal = null; // cumulative counter
    /** Prefix cache hit rate 0–1 (hits/queries). */
    this.prefixCacheHitRate = null;
    /** End-to-end request latency p95 (seconds). */
    this.e2eP95Seconds = null;
    /** Inter-token latency p95 (seconds). */
    this.itlP95Seconds = null;
    /** Speculative/MTP acceptance rate 0–1 (accepted/drafted). */
    this.mtpAcceptanceRate = null;

    this._consecutiveFailures = 0;
    this._lastDetectAt = 0;
    /** @type {{ value: number, liveUntil: number } | null} */
    this._sglangStickyTps = null;
    /** Latest gen_throughput from /v1/loads, if that payload carried one. */
    this._sglangLoadGenTps = null;
    /** Whether this poll's /server_info carried total_input/output_tokens. */
    this._sglangTotalsPolled = false;
    /**
     * Series that seeded `lastTokenCounts` — "server_info" or "prometheus".
     * They count the same work under different names, so a hand-off re-seeds
     * the baseline instead of differencing across the two.
     * @type {"server_info" | "prometheus" | null}
     */
    this._sglangTokenSource = null;
  }

  /**
   * Prefill is a short burst; decode then runs with Δprompt=0.
   * Keep the last real prefill rate while the engine is still in-flight, then 0.
   * @param {number} rate
   * @param {boolean} inflight
   */
  _setPrefillTps(rate, inflight) {
    const rounded = Math.max(0, Math.round(rate * 100) / 100);
    if (rounded > 0) this.prefillTps = rounded;
    else if (!inflight) this.prefillTps = 0;
  }

  /**
   * Live cached vs computed prefill tok/s from cumulative counters.
   * First sample seeds the baseline (0 tok/s). Missing either side clears the split.
   * @param {number|null|undefined} cachedCount
   * @param {number|null|undefined} computedCount
   * @param {number} dtSec
   */
  _setPrefillSplitRates(cachedCount, computedCount, dtSec) {
    if (cachedCount == null || computedCount == null || !Number.isFinite(cachedCount) || !Number.isFinite(computedCount)) {
      this.cachedPrefillTps = null;
      this.uncachedPrefillTps = null;
      this.lastPrefillKinds = null;
      return;
    }
    const total = cachedCount + computedCount;
    this.prefixCacheHitRate =
      total > 0 ? Math.round((cachedCount / total) * 10000) / 10000 : null;
    if (this.lastPrefillKinds == null) {
      this.lastPrefillKinds = { cached: cachedCount, computed: computedCount };
      this.cachedPrefillTps = 0;
      this.uncachedPrefillTps = 0;
      return;
    }
    if (dtSec > 0 && dtSec < 10) {
      const dCached = cachedCount - this.lastPrefillKinds.cached;
      const dComputed = computedCount - this.lastPrefillKinds.computed;
      this.cachedPrefillTps = Math.max(0, Math.round((dCached / dtSec) * 100) / 100);
      this.uncachedPrefillTps = Math.max(0, Math.round((dComputed / dtSec) * 100) / 100);
    }
    this.lastPrefillKinds = { cached: cachedCount, computed: computedCount };
  }

  /** Update probe port (and host from spark). Resets detection when the target changes. */
  setPort(port) {
    const next = Number(port);
    const prevUrl = this.baseUrl;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this.baseUrl = `http://${llmProbeHost(this.spark)}:${this.port}`;
    if (this.baseUrl !== prevUrl) {
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Probe the LLM server and return a snapshot. */
  async probe() {
    try {
      const shouldDetect =
        this.serverIsOpenAI === null ||
        Date.now() - this._lastDetectAt > REDETECT_INTERVAL_MS;

      if (shouldDetect) {
        await this._detectServerType();
        this._lastDetectAt = Date.now();
      }

      if (this.serverIsOpenAI === false) {
        const snap = await this._probeLlamaCpp();
        this._noteSuccess();
        return snap;
      } else if (this.serverIsOpenAI === true) {
        const snap = await this._probeOpenAICompatible();
        this._noteSuccess();
        return snap;
      } else {
        this._noteFailure("LLM server not reachable");
        return this._defaultLlm();
      }
    } catch (err) {
      this._noteFailure(err.message);
      return this._defaultLlm();
    }
  }

  _noteSuccess() {
    this._consecutiveFailures = 0;
    this.error = null;
  }

  _noteFailure(message) {
    this.error = message;
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= FAIL_RESET_THRESHOLD) {
      this._resetDetection();
    }
  }

  /** Forget what kind of server this is. Engine-owned state goes with it. */
  _resetDetection() {
    this.serverIsOpenAI = null;
    this.backendType = null;
    this.authOpen = null;
    this.slotState.clear();
    this._llamaCachedCum = 0;
    this._llamaComputedCum = 0;
    /** null = untried, false = server has no /metrics (don't re-probe). */
    this._llamaMetricsOk = null;
    /** Monotonic tokens_predicted_total; null when /metrics did not answer. */
    this._llamaCumulative = null;
    this._sglangStickyTps = null;
    this.router = null;
    this.studio = null;
    // Owns modelId / modelPath / contextLength, every tile and every series.
    this._clearEngine();
  }

  /**
   * Forget the engine behind a router: identity, series and every tile that
   * belongs to a specific process. Called on swap, engine restart and when the
   * router has nothing loaded — otherwise the panel keeps showing the last
   * model's KV / TTFT / MTP numbers forever.
   */
  _clearEngine() {
    this.routerModel = null;
    this.routerModelName = null;
    this.routerLoading = null;
    this.engineUrl = null;
    this.engineId = null;
    this._engineInfoRead = false;
    this.routerResident = 0;
    this._swapMisses = 0;
    this._engineStats.clear();
    this.modelId = null;
    this.modelPath = null;
    this.contextLength = null;
    this._resetEngineSeries();
  }

  /** Zero the rate/tile state that a counter reset would otherwise corrupt. */
  _resetEngineSeries() {
    this.lastTokenCounts = { input: 0, output: 0 };
    this.lastPrefillKinds = null;
    this.lastTtftSum = null;
    this.lastIterSum = null;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;
    this.totalOutputTokens = 0;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.totalPromptTokens = null;
    this.totalCachedTokens = null;
    this.kvCacheUsage = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttftSeconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this.lastTtftCount = null;
    this._sglangLoadGenTps = null;
  }

  /** Note auth from an HTTP status on an unauthenticated probe request. */
  _noteAuthStatus(status) {
    if (status >= 200 && status < 300) {
      this.authOpen = true;
      return "ok";
    }
    if (status === 401 || status === 403) {
      this.authOpen = false;
      return "auth";
    }
    return "other";
  }

  // ─── Server type detection ───────────────────────────────
  async _detectServerType() {
    // Skip the llama.cpp /slots probe once we've positively identified an
    // OpenAI-compatible backend. vLLM / sglang / ds4-server have no /slots,
    // so re-probing it on every re-detect cycle just spams 404s in the
    // backend's access log (#15). Still probe /slots on first contact, when
    // the type is unknown, or when the backend was previously llama.cpp.
    if (
      this.router == null &&
      this.backendType !== "vllm" &&
      this.backendType !== "sglang" &&
      this.backendType !== "ds4" &&
      this.backendType !== "exl3" &&
      this.backendType !== "q27" &&
      this.backendType !== "tensorfold"
    ) {
      const slotUrl = `${this.baseUrl}/slots`;
      try {
        const slotRes = await this._fetch(slotUrl);
        const auth = this._noteAuthStatus(slotRes.status);
        if (auth === "ok") {
          const slots = await slotRes.json();
          if (Array.isArray(slots)) {
            this.serverIsOpenAI = false;
            this.backendType = "llama.cpp";
            return;
          }
        } else if (auth === "auth") {
          // Authenticated llama.cpp — treat as protected OpenAI-style for posture
          this.serverIsOpenAI = false;
          this.backendType = "llama.cpp";
          return;
        }
      } catch {}
    }

    // Try OpenAI-compatible (vLLM, SGLang, or ds4-server)
    try {
      const modelRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelRes.status);
      if (auth === "ok" || auth === "auth") {
        this.serverIsOpenAI = true;
        let owned = null;
        if (auth === "ok") {
          try {
            const modelsData = await modelRes.json();
            owned = modelsData?.data?.[0]?.owned_by;
          } catch {
            /* body optional for detection */
          }
        }
        // llama-server reports owned_by "llamacpp". If the /slots probe
        // failed transiently (server busy or waking from --sleep-idle-seconds),
        // the fallback must not classify it as vLLM: that misdetection is
        // sticky (the anti-404-spam guard above never re-probes /slots for
        // "vllm") and blanks every metric tile.
        if (typeof owned === "string" && /llama[._-]?cpp/i.test(owned)) {
          this.serverIsOpenAI = false;
          this.backendType = "llama.cpp";
          return;
        }
        // llama-swap fronts N engines on one port: its model list is config,
        // not state. Identity and metrics come from the running engine
        // (_probeSwapRouter), so classify the backend there.
        if (isSwapOwner(owned)) {
          this.router = "llama-swap";
          return;
        }
        this.backendType = await this._classifyOpenAIBackend(owned);
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
  }

  /**
   * Classify an OpenAI-compatible server: ds4, SGLang, EXL3, q27, TensorFold, or vLLM (default).
   * @param {unknown} ownedBy
   * @returns {Promise<"ds4" | "sglang" | "exl3" | "q27" | "tensorfold" | "vllm">}
   */
  async _classifyOpenAIBackend(ownedBy) {
    if (typeof ownedBy === "string") {
      if (/ds4/i.test(ownedBy)) return "ds4";
      if (/sglang/i.test(ownedBy)) return "sglang";
      if (/exl3/i.test(ownedBy)) return "exl3";
      // q27's /v1/models reports owned_by: "q27" (signalnine/q27 engine).
      if (/q27/i.test(ownedBy)) return "q27";
      // TensorFold (ashhart/TensorFold) reports owned_by: "tensorfold" on both MLX and CUDA servers.
      if (/tensorfold/i.test(ownedBy)) return "tensorfold";
    }
    if (await this._probeIsDs4()) return "ds4";
    if (await this._probeIsSglang()) return "sglang";
    if (await this._probeIsExl3()) return "exl3";
    if (await this._probeIsQ27()) return "q27";
    return "vllm";
  }

  /**
   * True when EXL3 `tools/serve_openai.py` /health exposes backend + token totals.
   * Distinguishes from vLLM's /health (no `busy` + `completion_tokens_total`).
   */
  async _probeIsExl3() {
    try {
      const res = await this._fetch(`${this.baseUrl}/health`);
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return LlmProbe._healthLooksLikeExl3(data);
    } catch {
      return false;
    }
  }

  /** @param {unknown} data */
  static _healthLooksLikeExl3(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (data.backend === "exl3") return true;
    // tools/serve_openai.py: { ok, busy } even before token counters existed.
    return data.ok === true && typeof data.busy === "boolean";
  }

  /**
   * First successful SGLang JSON from `paths` (current name, then deprecated alias).
   * @param {string[]} paths
   * @returns {Promise<object|null>}
   */
  async _fetchSglangJson(paths) {
    for (const path of paths) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (data && typeof data === "object" && !Array.isArray(data)) return data;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** True when SGLang native server-info endpoints respond. */
  async _probeIsSglang() {
    return (await this._fetchSglangJson(SGLANG_SERVER_INFO_PATHS)) != null;
  }

  /** True when Prometheus /metrics exposes ds4-server series (ds4-on-spark). */
  async _probeIsDs4() {
    try {
      const res = await this._fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return false;
      const txt = await res.text();
      return LlmProbe._metricsLookLikeDs4(txt);
    } catch {
      return false;
    }
  }

  /** @param {string} body */
  static _metricsLookLikeVllm(body) {
    return typeof body === "string" && (body.includes("vllm:") || body.includes("vllm_"));
  }

  /** @param {string} body */
  static _metricsLookLikeDs4(body) {
    return /(?:^|\n)ds4_tokens_decoded_total(?:\{|\s)/m.test(String(body || ""));
  }

  /** True when Prometheus /metrics exposes q27-series (signalnine/q27 engine). */
  async _probeIsQ27() {
    try {
      const res = await this._fetch(`${this.baseUrl}/metrics`);
      if (!res.ok) return false;
      const txt = await res.text();
      return LlmProbe._metricsLookLikeQ27(txt);
    } catch {
      return false;
    }
  }

  /** @param {string} body */
  static _metricsLookLikeQ27(body) {
    return /(?:^|\n)q27_(?:decode_tokens_(?:processed_)?total|requests_total)(?:\{|\s)/m.test(
      String(body || "")
    );
  }

  // ─── OpenAI-compatible path (vLLM/sglang/ds4) ────────────
  async _probeOpenAICompatible() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models — 401/403 means protected; other failure = down
    let modelsOk = false;
    let owned = null;
    let servedModelId = null;
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      const auth = this._noteAuthStatus(modelsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const model = modelsData?.data?.[0];
        servedModelId = normalizeModelId(model?.id || null);
        owned = model?.owned_by;
        // A router's list is its config (every model and alias), so it says
        // nothing about what is loaded — leave identity to _probeSwapRouter.
        if (isSwapOwner(owned)) {
          this.router = "llama-swap";
        } else {
          this.modelId = normalizeModelId(model?.id || null);
          // Drop HF hub cache paths from modelPath if /v1/models id was a cache dir
          if (isHfHubCachePath(model?.id)) this.modelPath = null;
          // ds4-server uses context_length; vLLM uses max_model_len
          this.contextLength =
            model?.max_model_len ?? model?.context_length ?? this.contextLength;
        }
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("OpenAI-compatible /v1/models unreachable");
    }

    if (this.router === "llama-swap") return this._probeSwapRouter(dtSec);

    // Self-heal backend from owned_by before branching (cheap, no extra HTTP)
    if (typeof owned === "string") {
      if (/ds4/i.test(owned)) this.backendType = "ds4";
      else if (/sglang/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "sglang";
      } else if (/exl3/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "exl3";
      } else if (/tensorfold/i.test(owned) && this.backendType !== "ds4") {
        this.backendType = "tensorfold";
      }
    }

    // TensorFold: no Prometheus. /health carries cumulative token totals when the
    // server publishes them; without them tok/s stays 0 rather than guessing.
    if (this.backendType === "tensorfold") {
      try {
        const healthRes = await this._fetch(`${this.baseUrl}/health`);
        if (healthRes.ok) {
          const health = await healthRes.json().catch(() => null);
          this._applyTensorFoldHealth(health, dtSec);
        } else {
          this._applyTensorFoldHealth(null, dtSec);
        }
      } catch {
        this._applyTensorFoldHealth(null, dtSec);
      }
      return this._getSnapshot();
    }

    // EXL3 serve_openai.py: live tok/s from /health cumulative counters (no Prometheus).
    if (this.backendType === "exl3" || this.backendType == null) {
      try {
        const healthRes = await this._fetch(`${this.baseUrl}/health`);
        if (healthRes.ok) {
          const health = await healthRes.json().catch(() => null);
          if (LlmProbe._healthLooksLikeExl3(health)) {
            this.backendType = "exl3";
            this._applyExl3Health(health, dtSec);
            return this._getSnapshot();
          }
        }
      } catch {
        /* health optional unless already classified exl3 */
      }
      if (this.backendType === "exl3") return this._getSnapshot();
    }

    // SGLang: native info endpoints. Skip on known vLLM/ds4 to avoid 404 spam.
    // Prefer /server_info — /get_server_info is a deprecated alias that logs every poll.
    if (this.backendType === "sglang" || this.backendType == null) {
      this._sglangTotalsPolled = false;
      const sgData = await this._fetchSglangJson(SGLANG_SERVER_INFO_PATHS);
      if (sgData) {
        this.backendType = "sglang";
        // Load before last_gen_throughput so inflight can keep a steady rate live.
        await this._probeSglangLoad();
        this._applySglangServerInfo(sgData, dtSec);
        // Engine tile: Active vs Sleeping. SGLang has no live sleep gauge
        // (sleep_on_idle is a launch flag, not current state). A reachable
        // server with weights resident is Active / ready.
        if (this.gpuMemoryUtilization == null) this.gpuMemoryUtilization = 1;
      }
    }

    if (this.backendType === "sglang") {
      // Prometheus is optional (--enable-metrics). Do not mix those counters
      // into lastTokenCounts when this poll's server-info totals own them.
      // Gate on which series answered, never on the displayed rates: a live
      // rate keeps the split path selected forever, and the split path is not
      // allowed to clear prefillTps — the value then latches (#99).
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          const txt = await metricsRes.text();
          if (this._sglangTotalsPolled) this._applySglangPrefillSplit(txt, dtSec);
          else this._applySglangMetrics(txt, dtSec);
        }
      } catch {
        /* metrics optional */
      }
      await this._enrichSglangModelInfo();
      // Native SGLang endpoints expose the storage path (often just `/model`).
      // Keep that as modelPath, but show/use the client-facing served model ID.
      if (servedModelId) this.modelId = servedModelId;
      return this._getSnapshot();
    }

    // Single /metrics fetch: ds4-server or vLLM Prometheus exposition.
    // A router's own /metrics never lands here — _probeSwapRouter scrapes the
    // engine it names, so there is no port to guess.
    try {
      const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
      const txt = metricsRes.ok ? await metricsRes.text() : "";
      if (this.backendType === "ds4" || LlmProbe._metricsLookLikeDs4(txt)) {
        this.backendType = "ds4";
        this._applyDs4Metrics(txt, dtSec);
      } else if (this.backendType === "q27" || LlmProbe._metricsLookLikeQ27(txt)) {
        this.backendType = "q27";
        this._applyQ27Metrics(txt, dtSec);
      } else if (LlmProbe._metricsLookLikeVllm(txt)) {
        this.backendType = "vllm";
        this._applyVllmMetrics(txt, dtSec);
      } else if (
        this.backendType !== "ds4" &&
        this.backendType !== "exl3" &&
        this.backendType !== "q27"
      ) {
        this.backendType = "vllm";
      }
    } catch {
      if (
        this.backendType !== "ds4" &&
        this.backendType !== "exl3" &&
        this.backendType !== "q27"
      ) {
        this.backendType = "vllm";
      }
    }

    return this._getSnapshot();
  }

  // ─── llama-swap router path ──────────────────────────────
  /**
   * Probe the engine a llama-swap proxy is actually running.
   *
   * The router's /v1/models is its config; /running is its state. Everything
   * the panel shows — model, context, tok/s, tiles — comes from the engine
   * named there, scraped at its own upstream address.
   * @param {number} dtSec
   */
  async _probeSwapRouter(dtSec) {
    let rows = null;
    try {
      const res = await this._fetch(`${this.baseUrl}/running`);
      if (res.ok) rows = parseRunning(await readJsonCapped(res, RUNNING_MAX_BYTES).catch(() => null));
      else await res.body?.cancel().catch(() => {});
    } catch {
      /* reported below */
    }
    if (rows == null) throw new Error("llama-swap /running unreachable");
    const polledAt = Date.now();
    this._routerRows = rows;
    const diff = diffRouterRows(this._routerPrev, rows, polledAt, this.routerEvents);
    this._routerPrev = diff.state;
    this.routerEvents = diff.events;
    // Slow, non-essential feeds: never hold up the 2 s poll. Each is single-flight.
    this._activityRun ??= this._refreshRouterActivity(polledAt).finally(() => {
      this._activityRun = null;
    });
    this._modelsRun ??= this._refreshRouterModels(polledAt).finally(() => {
      this._modelsRun = null;
    });

    // A ComfyUI studio is a llama-swap member but not an LLM engine: it has no
    // /metrics and no chat API, so it must stay out of engine selection, the
    // resident list and loading detection. Origins come from /running via
    // upstreamBase — never through llama-swap's /upstream/ path.
    // Per ROW, not per name: a /running that repeats a name across origins must not
    // let one studio row hide an LLM row that shares its name.
    /** @type {Set<import("./swapRouter.js").RunningRow>} */
    const comfy = new Set();
    await Promise.all(
      rows.map(async (r) => {
        if (!r.proxy || !(isReadyState(r.state) || isLoadingState(r.state))) return;
        const base = upstreamBase(r.proxy, this.baseUrl);
        if (!base) return;
        // A studio that is still starting answers nothing yet; its name at this
        // origin, learned while it was ready, keeps it from reading as a loading LLM.
        if (isLoadingState(r.state) && isKnownComfyModel(base, r.model)) {
          comfy.add(r);
          return;
        }
        // Unauthenticated: the router's API key must not reach a studio origin.
        const det = await detectComfyUpstream(base, {
          fetchImpl: (u) => this._fetch(u, { authenticated: false }),
        });
        if (det.isComfy) {
          comfy.add(r);
          noteComfyModel(base, r.model);
        }
      })
    );
    const studioRow = rows.find((r) => comfy.has(r) && isReadyState(r.state) && r.proxy);
    this.studio = studioRow ? { model: studioRow.model, name: studioRow.name } : null;

    // Only an *incoming* model is "loading". During a swap the outgoing one is
    // also non-ready ("stopping"), and naming that in the UI would tell the
    // operator a model is arriving when it is leaving.
    const loading = rows.find((r) => isLoadingState(r.state) && !comfy.has(r));
    const ready = rows.filter((r) => isReadyState(r.state) && r.proxy && !comfy.has(r));
    // How many models hold memory right now — the number that matters on a
    // single unified pool, and the one the Slots tile has no meaning for.
    this.routerResident = ready.length;
    const scanned = await this._scanEngines(ready);
    this._trackEngineTokens(scanned, Date.now());
    const picked = this._chooseEngine(scanned);
    if (!picked) {
      // Router up, nothing serving: an idle panel, not a stale one.
      this._clearEngine();
      this.routerLoading = loading ? loading.model : null;
      return this._getSnapshot();
    }

    // A poll that could not scrape the engine knows no start time. Keep the
    // identity we already had for that model: treating one transient /metrics
    // failure as two swaps would wipe the tiles, re-baseline the hourly
    // series twice and re-read /v1/models, all for an engine that never moved.
    const sameModel = this.engineId != null && this.routerModel === picked.row.model;
    const engineId =
      picked.startedAt != null
        ? `${picked.row.model}@${picked.startedAt}`
        : sameModel
          ? this.engineId
          : `${picked.row.model}@?`;
    const engineChanged = engineId !== this.engineId;
    if (engineChanged) {
      // Swap or restart: counters start from zero again, so every delta and
      // every tile from the previous engine is meaningless.
      this._resetEngineSeries();
      this.engineId = engineId;
      this.backendType = null;
      this.contextLength = null;
      this.modelPath = null;
      this._engineInfoRead = false;
    }
    this.engineUrl = picked.base;
    this.routerModel = picked.row.model;
    this.routerModelName = picked.row.name;
    this.routerLoading = loading ? loading.model : null;
    // The router key, not the upstream's served name: this is the id clients
    // (benchmark, showcase) must send back through the proxy.
    this.modelId = picked.row.model;

    // Once per engine: an upstream that reports no context (llama.cpp) must
    // not be re-asked every 2 s forever.
    if (picked.base && !this._engineInfoRead) {
      this._engineInfoRead = await this._readEngineModelInfo(picked.base);
    }
    // dt 0 on the first sample of an engine: store the counters as the
    // baseline without turning "everything it ever generated" into a rate.
    if (picked.metrics) this._applyEngineMetrics(picked.metrics, engineChanged ? 0 : dtSec);
    else if (engineChanged) this.backendType = null;
    return this._getSnapshot();
  }

  /**
   * Scrape every ready engine once, then decide which one the panel follows.
   *
   * Every resident engine is read on every poll because the card reports each
   * one's tokens, not just the followed model's — on a single unified pool
   * "what else is holding memory, and is it working?" is the question the
   * operator actually has. Bounded by parseRunning's row cap and by physics:
   * a 121 GB pool holds two or three engines, not thirty.
   * @param {import("./swapRouter.js").RunningRow[]} ready
   * @returns {Promise<Array<{row: import("./swapRouter.js").RunningRow, base: string|null, metrics: string|null, startedAt: number|null}>>}
   */
  async _scanEngines(ready) {
    const scanned = [];
    for (const row of ready) {
      const resolved = await this._readEngine(row);
      if (resolved) scanned.push(resolved);
    }
    return scanned;
  }

  /**
   * The engine the panel follows: the most recently started one that answered.
   *
   * A scrape can fail on a busy engine (3 s probe timeout under decode), so
   * the engine currently being followed keeps the panel for a few polls before
   * handing over — bouncing to an always-resident helper and back would cost
   * two engine changes, two hourly re-baselines, and the tokens in between.
   * @param {Awaited<ReturnType<LlmProbe["_scanEngines"]>>} scanned
   */
  _chooseEngine(scanned) {
    if (!scanned.length) {
      this._swapMisses = 0;
      return null;
    }
    const followed = scanned.find((c) => c.row.model === this.routerModel);
    if (followed && followed.metrics == null) {
      this._swapMisses += 1;
      if (this._swapMisses < SWAP_FAILOVER_MISSES) return followed;
    } else {
      this._swapMisses = 0;
    }
    const answered = scanned.filter((c) => c.metrics != null);
    return pickNewestEngine(answered.length ? answered : scanned);
  }

  /**
   * Per-engine generated tokens and live rate, for every resident model.
   *
   * Kept separately from the followed engine's series: each engine counts from
   * its own start, so one shared baseline would attribute a swap-in's history
   * to whichever model happens to be on screen.
   * @param {Awaited<ReturnType<LlmProbe["_scanEngines"]>>} scanned
   * @param {number} now
   */
  _trackEngineTokens(scanned, now) {
    const seen = new Set();
    for (const c of scanned) {
      const model = c.row.model;
      seen.add(model);
      const id = c.startedAt != null ? `${model}@${c.startedAt}` : model;
      const total = c.metrics != null ? generationTokensFromMetrics(c.metrics) : null;
      const promptTotal = c.metrics != null ? promptTokensFromMetrics(c.metrics) : null;
      const prev = this._engineStats.get(model);
      if (!prev || prev.engineId !== id) {
        // New process: seed, never diff across the restart.
        this._engineStats.set(model, {
          engineId: id,
          name: c.row.name,
          total: total ?? 0,
          tps: 0,
          promptTotal,
          promptTps: 0,
          at: now,
        });
        continue;
      }
      prev.name = c.row.name;
      if (total == null && promptTotal == null) continue;
      const dt = (now - prev.at) / 1000;
      if (total != null) {
        if (total < prev.total) prev.tps = 0;
        else if (dt > 0 && dt < 10) prev.tps = Math.round(((total - prev.total) / dt) * 100) / 100;
        prev.total = total;
      }
      if (promptTotal != null) {
        // A counter first seen after the seed has no baseline to diff against.
        if (prev.promptTotal == null || promptTotal < prev.promptTotal) prev.promptTps = 0;
        else if (dt > 0 && dt < 10) {
          prev.promptTps = Math.round(((promptTotal - prev.promptTotal) / dt) * 100) / 100;
        }
        prev.promptTotal = promptTotal;
      }
      prev.at = now;
    }
    for (const model of this._engineStats.keys()) {
      if (!seen.has(model)) this._engineStats.delete(model);
    }
  }

  /** Snapshot rows for the resident-models list: followed engine first. */
  _routerEngines() {
    const rows = [];
    for (const [model, st] of this._engineStats) {
      rows.push({
        model,
        name: st.name || null,
        generationTps: st.tps,
        totalOutputTokens: st.total,
        active: model === this.routerModel,
        promptTps: st.promptTps,
      });
    }
    rows.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.model.localeCompare(b.model);
    });
    return rows;
  }

  /**
   * Record one router-feed outcome. Logs once per ok↔failing change and returns
   * how long to leave the feed alone (0 after a success).
   * @param {"activity" | "models"} feed
   * @param {string | null} failure what went wrong, or null on success
   * @param {string} path URL path, for the log
   */
  _noteRouterFeed(feed, failure, path) {
    const h = this._feedHealth[feed];
    if (failure == null) {
      if (h.failing) console.warn(`[LlmProbe] router ${feed} ${path} on :${this.port} recovered`);
      h.fails = 0;
      h.failing = false;
      return 0;
    }
    h.fails += 1;
    if (!h.failing) {
      h.failing = true;
      console.warn(`[LlmProbe] router ${feed} ${path} on :${this.port} failing: ${failure}`);
    }
    return Math.min(ROUTER_FEED_BACKOFF_MAX_MS, ROUTER_REFRESH_MS * 2 ** (h.fails - 1));
  }

  /** Request outcomes from llama-swap's activity log; keeps the previous value on failure. */
  async _refreshRouterActivity(now) {
    if (now < this._activityNextAt) return;
    this._activityNextAt = now + ROUTER_REFRESH_MS;
    const path = "/api/metrics/activity";
    let failure = null;
    try {
      const start = encodeURIComponent(new Date(now - 24 * 3_600_000).toISOString());
      const res = await this._fetch(`${this.baseUrl}${path}?limit=${ACTIVITY_LIMIT}&start=${start}`, {
        timeoutMs: ACTIVITY_TIMEOUT_MS,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 404) {
          this._activityNextAt = now + ACTIVITY_MISSING_BACKOFF_MS;
          return;
        }
        failure = `HTTP ${res.status}`;
      } else {
        const activity = buildRouterActivity(await readJsonCapped(res, ACTIVITY_MAX_BYTES), now);
        if (activity) this.routerActivity = activity;
        else failure = "unexpected payload";
      }
    } catch (err) {
      failure = err?.message || String(err);
    }
    const backoff = this._noteRouterFeed("activity", failure, path);
    if (backoff) this._activityNextAt = now + backoff;
  }

  /** Configured models from /v1/models; keeps the previous list on failure. */
  async _refreshRouterModels(now) {
    if (now < this._modelsNextAt) return;
    this._modelsNextAt = now + ROUTER_REFRESH_MS;
    const path = "/v1/models";
    let failure = null;
    try {
      const res = await this._fetch(`${this.baseUrl}${path}`);
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        failure = `HTTP ${res.status}`;
      } else {
        const models = parseRouterModels(await readJsonCapped(res, MODELS_MAX_BYTES));
        if (models) this.routerModels = models;
        else failure = "unexpected payload";
      }
    } catch (err) {
      failure = err?.message || String(err);
    }
    const backoff = this._noteRouterFeed("models", failure, path);
    if (backoff) this._modelsNextAt = now + backoff;
  }

  /** Model names in the router's last /running rows; [] when this is not a router or nothing was read. */
  runningModels() {
    return this.router === "llama-swap" && this._routerRows ? this._routerRows.map((r) => r.model) : [];
  }

  /** True while a fire-and-forget model load is outstanding. */
  isLoadInFlight() {
    return this._routerLoadInFlight;
  }

  /**
   * Unload one model (llama-swap POST /api/models/unload/{model}).
   * @param {string} model
   * @returns {Promise<{ok: boolean, status: number, message: string}>}
   */
  async routerUnload(model) {
    if (!isSafePathId(model)) return { ok: false, status: 400, message: "invalid model id" };
    try {
      const res = await this._fetch(
        `${this.baseUrl}/api/models/unload/${encodeURIComponent(model)}`,
        { method: "POST", timeoutMs: ROUTER_UNLOAD_TIMEOUT_MS }
      );
      const body = await res.text().catch(() => "");
      return {
        ok: res.ok,
        status: res.status,
        message: res.ok ? "unloaded" : body.trim().slice(0, 200) || `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, status: 0, message: err?.message || String(err) };
    } finally {
      this._modelsNextAt = 0; // the loaded flags changed; re-read on the next poll
    }
  }

  /**
   * Ask llama-swap to load one model by requesting its health endpoint, which
   * blocks until the model is up. Fire-and-forget; one load in flight per probe.
   * @param {string} model
   * @returns {{started: true} | {started: false, reason: "busy" | "invalid"}}
   */
  routerLoad(model) {
    if (!isSafePathId(model)) return { started: false, reason: "invalid" };
    if (this._routerLoadInFlight) return { started: false, reason: "busy" };
    this._routerLoadInFlight = true;
    const t0 = Date.now();
    void (async () => {
      try {
        const res = await this._fetch(
          `${this.baseUrl}/upstream/${encodeURIComponent(model)}/health`,
          { timeoutMs: ROUTER_LOAD_TIMEOUT_MS, longLived: true }
        );
        await res.body?.cancel().catch(() => {});
        console.log(`[LlmProbe] router load ${model} on :${this.port} -> HTTP ${res.status} after ${Date.now() - t0} ms`);
      } catch (err) {
        console.log(`[LlmProbe] router load ${model} on :${this.port} failed after ${Date.now() - t0} ms: ${err?.message || err}`);
      } finally {
        this._routerLoadInFlight = false;
        this._modelsNextAt = 0;
      }
    })();
    return { started: true };
  }

  /**
   * Resolve one running row to an engine: its Prometheus body and start time
   * when it can be scraped, identity alone when it cannot. A ready engine
   * started with metrics disabled, or one the router puts on a host we refuse
   * to fetch, is still the model that is loaded — reporting "no model" there
   * would be a lie, just a different one.
   * @param {import("./swapRouter.js").RunningRow | undefined} row
   */
  async _readEngine(row) {
    if (!row) return null;
    const base = upstreamBase(row.proxy, this.baseUrl);
    if (!base) return { row, base: null, metrics: null, startedAt: null };
    try {
      const res = await this._fetch(`${base}/metrics`);
      if (!res.ok) return { row, base, metrics: null, startedAt: null };
      const metrics = await res.text();
      return { row, base, metrics, startedAt: processStartTime(metrics) };
    } catch {
      return { row, base, metrics: null, startedAt: null };
    }
  }

  /**
   * Context length and upstream repo id, straight from the engine.
   * @param {string} base
   * @returns {Promise<boolean>} true when the engine answered (do not re-ask).
   */
  async _readEngineModelInfo(base) {
    try {
      const res = await this._fetch(`${base}/v1/models`);
      if (!res.ok) return false;
      const data = await res.json();
      const model = data?.data?.[0];
      const ctx = model?.max_model_len ?? model?.context_length;
      if (Number.isFinite(Number(ctx)) && Number(ctx) > 0) {
        this.contextLength = Math.round(Number(ctx));
      }
      const root = model?.root || model?.id;
      if (root && !isHfHubCachePath(root)) this.modelPath = String(root);
      return true;
    } catch {
      // Engine still warming: retry on the next poll.
      return false;
    }
  }

  /**
   * Apply an engine's Prometheus body, whatever engine it is.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyEngineMetrics(txt, dtSec) {
    if (LlmProbe._metricsLookLikeDs4(txt)) {
      this.backendType = "ds4";
      this._applyDs4Metrics(txt, dtSec);
    } else if (txt.includes("sglang:") || txt.includes("sglang_")) {
      this.backendType = "sglang";
      this._applySglangMetrics(txt, dtSec);
    } else if (txt.includes("llamacpp:")) {
      this.backendType = "llama.cpp";
      this._applyLlamaCppMetrics(txt, dtSec);
    } else if (LlmProbe._metricsLookLikeVllm(txt)) {
      this.backendType = "vllm";
      this._applyVllmMetrics(txt, dtSec);
    }
  }

  /**
   * llama.cpp behind a router: /slots belongs to the engine, not the proxy, so
   * rates come from the same monotonic counters the native path falls back to.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyLlamaCppMetrics(txt, dtSec) {
    const predicted = this._getPromMetric(txt, "llamacpp:tokens_predicted_total");
    const prompt = this._getPromMetric(txt, "llamacpp:prompt_tokens_total");
    if (predicted != null && dtSec > 0 && dtSec < 10) {
      const deltaOut = predicted - this.lastTokenCounts.output;
      this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
      if (prompt != null) {
        this._setPrefillTps((prompt - this.lastTokenCounts.input) / dtSec, deltaOut > 0);
      }
    }
    if (predicted != null) {
      this.lastTokenCounts.output = predicted;
      this.totalOutputTokens = predicted;
      this._llamaCumulative = predicted;
    }
    if (prompt != null) this.lastTokenCounts.input = prompt;

    const running = this._getPromMetric(txt, "llamacpp:requests_processing");
    const waiting = this._getPromMetric(txt, "llamacpp:requests_deferred");
    this.requestsRunning = running;
    this.requestsWaiting = waiting;
    if (running != null) this.slotsActive = Math.round(running);
    this.kvCacheUsage = this._getPromMetric(txt, "llamacpp:kv_cache_usage_ratio");
    this.gpuMemoryUtilization = 1;
  }

  /**
   * Apply ds4-server Prometheus /metrics (Entrpi/ds4-on-spark).
   * Live tok/s from counter diffs (same as vLLM) so idle → 0. The engine's
   * `ds4_decode_tok_s` / `ds4_prefill_tok_s` gauges are ~60s windows and stay
   * non-zero long after requests finish — do not use them for the live panel.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyDs4Metrics(txt, dtSec) {
    const decoded = this._getPromMetric(txt, "ds4_tokens_decoded_total");
    const computedPrefill = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "computed"
    );
    const prefilled =
      computedPrefill ?? this._getPromMetric(txt, "ds4_tokens_prefilled_total");
    const inflightHint = this._getPromMetric(txt, "ds4_requests_inflight");
    const inflight = inflightHint != null && inflightHint > 0;
    // Cumulative cached prefill for the token ledger (kind="cached" label).
    const cachedTotal = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "cached"
    );

    if (decoded != null) {
      if (prefilled != null && dtSec > 0 && dtSec < 10) {
        const deltaIn = prefilled - this.lastTokenCounts.input;
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      } else if (dtSec > 0 && dtSec < 10) {
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (!inflight && deltaOut <= 0) this.prefillTps = 0;
      }
      if (prefilled != null) this.lastTokenCounts.input = prefilled;
      this.lastTokenCounts.output = decoded;
      this.totalOutputTokens = decoded;
      // ds4's prefill counter is COMPUTED-only when the kind labels exist;
      // the token ledger wants the full prompt, so add the cached share.
      if (prefilled != null) {
        this.totalPromptTokens =
          cachedTotal != null && computedPrefill != null
            ? prefilled + cachedTotal
            : prefilled;
      }
      if (cachedTotal != null) this.totalCachedTokens = cachedTotal;
    } else {
      // No counters — fall back to window gauges only while something is in flight
      const gaugeGen = this._getPromMetric(txt, "ds4_decode_tok_s");
      const gaugePrefill = this._getPromMetric(txt, "ds4_prefill_tok_s");
      if (inflight) {
        if (gaugeGen != null) {
          this.generationTps = Math.max(0, Math.round(gaugeGen * 100) / 100);
        }
        if (gaugePrefill != null) {
          this.prefillTps = Math.max(0, Math.round(gaugePrefill * 100) / 100);
        }
      } else {
        this.generationTps = 0;
        this.prefillTps = 0;
      }
    }

    const inflightCount = this._getPromMetric(txt, "ds4_requests_inflight");
    this.requestsRunning = inflightCount;
    if (inflightCount != null) this.slotsActive = Math.round(inflightCount);

    const banksTotal = this._getPromMetric(txt, "ds4_banks_total");
    if (banksTotal != null) this.slotsTotal = Math.round(banksTotal);

    const specAccept = this._getPromMetric(txt, "ds4_spec_accept_ratio");
    this.mtpAcceptanceRate =
      specAccept != null ? Math.round(specAccept * 10000) / 10000 : null;

    // Prefix-cache hit rate + live tok/s from prefill kind labels
    const cached = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "cached"
    );
    const computed = this._getPromMetricLabeled(
      txt,
      "ds4_tokens_prefilled_total",
      "kind",
      "computed"
    );
    this._setPrefillSplitRates(cached, computed, dtSec);

    // Clear tiles that are vLLM-histogram-specific (no ds4 equivalent yet)
    this.kvCacheUsage = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttftSeconds = null;
    this.preemptionsTotal = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
  }

  /**
   * Apply q27 (signalnine/q27 engine) Prometheus /metrics.
   *
   * The engine exposes the [req]-universe telemetry that was previously only
   * in stderr logs, under q27_* series with an api= label (chat / completions /
   * messages / responses). The probe sums across label sets, exactly like the
   * ds4/vLLM paths: live tok/s from counter deltas so idle → 0.
   *
   * Semantics vs the vLLM path: prefill accounting is EXACT (per-request
   * token counts, not vLLM's estimates) and the prefix split (computed/cached)
   * doubles as the prefix-cache hit rate; the main prefill tile follows the
   * ds4 convention and counts COMPUTED tokens only. The waiting tile stays
   * null → the panel shows "—" (q27 FIFO-queues, no scheduler wait), while
   * preemptions are exposed as a constant-0 counter so Preempts reads 0.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyQ27Metrics(txt, dtSec) {
    // Live processed counters first (move during generation -> real-time
    // tok/s); fall back to the completion-based per-api totals for older
    // q27 binaries (step function: 0 during generation, jump at completion).
    const decoded =
      this._getPromMetric(txt, "q27_decode_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_decode_tokens_total");
    // Exact prefill (not estimated like vLLM). Follow the ds4 convention:
    // the main prefill tile counts COMPUTED tokens only -- cache-served
    // tokens go to the cached/uncached split below, so a cache hit does not
    // inflate the "real work" rate.
    const computed =
      this._getPromMetric(txt, "q27_prefill_computed_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_prefill_computed_tokens_total");
    if (decoded != null) {
      if (dtSec > 0 && dtSec < 10) {
        const deltaOut = decoded - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (computed != null) {
          const deltaIn = computed - this.lastTokenCounts.input;
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
        }
      }
      if (computed != null) this.lastTokenCounts.input = computed;
      this.lastTokenCounts.output = decoded;
      this.totalOutputTokens = decoded;
      // q27's prefill counter is computed-only; the token ledger wants the
      // full prompt (computed + cached).
      const cachedTok =
        this._getPromMetric(txt, "q27_prefill_cached_tokens_processed_total") ??
        this._getPromMetric(txt, "q27_prefill_cached_tokens_total");
      if (computed != null) {
        this.totalPromptTokens = cachedTok != null ? computed + cachedTok : computed;
      }
      if (cachedTok != null) this.totalCachedTokens = cachedTok;
    }

    const inflight = this._getPromMetric(txt, "q27_requests_inflight");
    this.requestsRunning = inflight;
    if (inflight != null) this.slotsActive = Math.round(inflight);

    const slotsTotal = this._getPromMetric(txt, "q27_slots_total");
    if (slotsTotal != null) this.slotsTotal = Math.round(slotsTotal);

    this.kvCacheUsage = this._getPromMetric(txt, "q27_kv_usage_perc");
    this.requestsWaiting = null; // not exposed: q27 FIFO-queues, no wait gauge
    // q27 never preempts (FIFO admission) — the server exposes a constant-0
    // counter, so the Preempts tile reads 0 instead of "—".
    this.preemptionsTotal = this._getPromMetric(txt, "q27_preemptions_total");
    // Engine state: q27 keeps weights resident and is ready whenever the
    // server is up (no sleep state / memory release), so report Active like
    // the SGLang path does.
    if (this.gpuMemoryUtilization == null) this.gpuMemoryUtilization = 1;

    // Histograms (cumulative buckets, +Inf == _count by construction).
    const ttftHist = this._parseHistogram(
      txt,
      "q27_ttft_seconds",
      "q27_ttft_seconds_count"
    );
    const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
    this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

    const e2eHist = this._parseHistogram(
      txt,
      "q27_e2e_seconds",
      "q27_e2e_seconds_count"
    );
    const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
    this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

    const itlHist = this._parseHistogram(
      txt,
      "q27_itl_seconds",
      "q27_itl_seconds_count"
    );
    const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
    this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

    // Prefix-cache hit rate + live cached/uncached prefill split (live
    // processed counters, with completion-based fallback).
    const cachedSplit =
      this._getPromMetric(txt, "q27_prefill_cached_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_prefill_cached_tokens_total");
    const computedSplit =
      this._getPromMetric(txt, "q27_prefill_computed_tokens_processed_total") ??
      this._getPromMetric(txt, "q27_prefill_computed_tokens_total");
    this._setPrefillSplitRates(cachedSplit, computedSplit, dtSec);

    const specAccept = this._getPromMetric(txt, "q27_spec_accept_ratio");
    this.mtpAcceptanceRate =
      specAccept != null ? Math.round(specAccept * 10000) / 10000 : null;
  }

  /**
   * Apply EXL3 tools/serve_openai.py GET /health.
   * Live tok/s from cumulative counter diffs so idle → 0.
   * @param {Record<string, unknown>} data
   * @param {number} dtSec
   */
  _applyExl3Health(data, dtSec) {
    const prompt = Number(data?.prompt_tokens_total);
    const completion = Number(data?.completion_tokens_total);
    const busy = data?.busy === true;
    const ctx = Number(data?.context_length);
    if (Number.isFinite(ctx) && ctx > 0) this.contextLength = Math.round(ctx);

    this.requestsRunning = busy ? 1 : 0;
    this.slotsActive = busy ? 1 : 0;
    this.slotsTotal = 1;
    this.kvCacheUsage = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttftSeconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this.cachedPrefillTps = null;
    this.uncachedPrefillTps = null;

    if (!Number.isFinite(completion)) {
      this.generationTps = busy ? this.generationTps : 0;
      if (!busy) this.prefillTps = 0;
      return;
    }

    if (dtSec > 0 && dtSec < 10) {
      const deltaOut = completion - this.lastTokenCounts.output;
      this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
      if (Number.isFinite(prompt)) {
        const deltaIn = prompt - this.lastTokenCounts.input;
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      } else if (!busy && this.generationTps <= 0) {
        this.prefillTps = 0;
      }
    } else if (!busy) {
      this.generationTps = 0;
      this.prefillTps = 0;
    }

    if (Number.isFinite(prompt)) this.lastTokenCounts.input = prompt;
    this.lastTokenCounts.output = completion;
    this.totalOutputTokens = completion;
    if (Number.isFinite(prompt)) this.totalPromptTokens = prompt;
  }

  /**
   * Apply TensorFold GET /health. Same counter contract as EXL3 (`prompt_tokens_total`,
   * `completion_tokens_total`, optional `busy` / `context_length`). The MLX server's
   * `max_batch_size` sizes the slot tile; the CUDA server's `{ok: true}` has no counters,
   * so rates read 0 instead of a made-up number.
   * @param {Record<string, unknown> | null} data
   * @param {number} dtSec
   */
  _applyTensorFoldHealth(data, dtSec) {
    const health = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    this._applyExl3Health(health, dtSec);
    // TensorFold 0.5.0 (cuda/health.py) publishes cumulative cached prompt tokens
    // alongside the EXL3-style counters; older builds omit it (stays null).
    const cached = Number(health.cached_tokens_total);
    if (Number.isFinite(cached) && cached >= 0) this.totalCachedTokens = cached;
    const batch = Number(health.max_batch_size);
    if (Number.isFinite(batch) && batch > 0) this.slotsTotal = Math.round(batch);
  }

  /**
   * Apply stock vLLM Prometheus /metrics (tok/s + inference tiles).
   * @param {string} txt
   * @param {number} dtSec
   */
  _applyVllmMetrics(txt, dtSec) {
    const promptTokens = this._getVllmMetric(txt, "prompt_tokens_total");
    const genTokens = this._getVllmMetric(txt, "generation_tokens_total");
    const running = this._getVllmMetric(txt, "num_requests_running");
    const iterSum = this._getVllmMetric(txt, "iteration_tokens_total_sum");
    // A counter that went backwards is a restarted engine, not negative work.
    // Seed the baseline and skip this interval: without it the next poll
    // reports the whole of the new process's history as one burst. Catches the
    // restart that engine identity cannot, when /metrics has no
    // process_start_time_seconds to identify the process by.
    if (
      (promptTokens != null && promptTokens < this.lastTokenCounts.input) ||
      (genTokens != null && genTokens < this.lastTokenCounts.output)
    ) {
      this._resetEngineSeries();
      this.lastTokenCounts = {
        input: promptTokens ?? 0,
        output: genTokens ?? 0,
      };
      this.totalOutputTokens = genTokens ?? 0;
      if (iterSum != null) this.lastIterSum = iterSum;
      return;
    }
    if (promptTokens != null && genTokens != null) {
      const deltaIn = promptTokens - this.lastTokenCounts.input;
      const deltaOut = genTokens - this.lastTokenCounts.output;
      this.lastTokenCounts.input = promptTokens;
      this.lastTokenCounts.output = genTokens;
      this.totalOutputTokens = genTokens;
      this.totalPromptTokens = promptTokens;
      // vLLM prefix-cache counters are token-granular (queries += prompt
      // tokens/request, hits += tokens served from cache), so cached_tokens
      // is directly the cumulative cached share of the prompt.
      const cachedTok = this._getVllmMetric(txt, "prefix_cache_hits_total");
      if (cachedTok != null) this.totalCachedTokens = cachedTok;
      const ttftSum = this._getVllmMetric(txt, "time_to_first_token_seconds_sum");
      const deltaIter =
        iterSum != null && this.lastIterSum != null ? iterSum - this.lastIterSum : 0;
      if (dtSec > 0 && dtSec < 10) {
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        const deltaTtft =
          ttftSum != null && this.lastTtftSum != null ? ttftSum - this.lastTtftSum : 0;
        // Engine-step tokens include prefill+decode. Surplus over generation is
        // prefill, including the common case where a short/cached prefill lands
        // in the same poll as the first decode tokens.
        const prefillIter = Math.max(0, deltaIter - Math.max(0, deltaOut));
        const specNoise = deltaOut > 0 && prefillIter > 0 && prefillIter < deltaOut * 0.5;
        const livePrefill =
          prefillIter > 0 && !specNoise ? prefillIter / dtSec : 0;
        const finishedPrefill =
          deltaIn > 0 && deltaTtft > 0
            ? deltaIn / deltaTtft
            : deltaIn > 0 && livePrefill <= 0
              ? deltaIn / dtSec
              : 0;
        this.prefillTps = Math.max(
          0,
          Math.round((livePrefill > 0 ? livePrefill : finishedPrefill) * 100) / 100
        );
      }
      // Live mean TTFT over the last poll window from histogram sum/count deltas.
      // Computed BEFORE lastTtftSum is advanced so the delta is real, not 0.
      const ttftCount = this._getVllmMetric(txt, "time_to_first_token_seconds_count");
      if (ttftCount != null) {
        const deltaSum =
          ttftSum != null && this.lastTtftSum != null ? ttftSum - this.lastTtftSum : null;
        const deltaCount =
          this.lastTtftCount != null ? ttftCount - this.lastTtftCount : null;
        this.ttftSeconds =
          deltaSum != null && deltaCount != null && deltaCount > 0 && deltaSum >= 0
            ? Math.round((deltaSum / deltaCount) * 1000) / 1000
            : null;
        this.lastTtftCount = ttftCount;
      } else {
        this.ttftSeconds = null;
      }
      if (ttftSum != null) this.lastTtftSum = ttftSum;
    }
    if (iterSum != null) this.lastIterSum = iterSum;

    this.requestsRunning = running;
    if (running != null) this.slotsActive = Math.round(running);

    // vLLM ≥0.11 exposes engine_sleep_state as one series per state
    // (awake / weights_offloaded / discard_all), so the unlabeled sum is
    // always 1 and can never report Sleeping. Read the awake series when it
    // is there, and keep the old single-gauge reading as the fallback.
    const awake = this._getPromMetricLabeled(
      txt,
      "vllm:engine_sleep_state",
      "sleep_state",
      "awake"
    );
    if (awake != null) {
      this.gpuMemoryUtilization = awake > 0 ? 1 : 0;
    } else if (this.gpuMemoryUtilization == null) {
      const sleepState = this._getVllmMetric(txt, "engine_sleep_state");
      if (sleepState != null) this.gpuMemoryUtilization = sleepState;
    }

    this.requestsWaiting = this._getVllmMetric(txt, "num_requests_waiting");
    this.kvCacheUsage = this._getVllmMetric(txt, "kv_cache_usage_perc");
    this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");

    const ttftHist = this._parseVllmHistogram(txt, "vllm:time_to_first_token_seconds");
    const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
    this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

    const e2eHist = this._parseVllmHistogram(txt, "vllm:e2e_request_latency_seconds");
    const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
    this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

    const itlHist = this._parseVllmHistogram(txt, "vllm:inter_token_latency_seconds");
    const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
    this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

    const prefixHits = this._getVllmMetric(txt, "prefix_cache_hits_total");
    const prefixQueries = this._getVllmMetric(txt, "prefix_cache_queries_total");
    this.prefixCacheHitRate =
      prefixHits != null && prefixQueries != null && prefixQueries > 0
        ? Math.round((prefixHits / prefixQueries) * 10000) / 10000
        : null;

    const mtpAccepted = this._getVllmMetric(txt, "spec_decode_num_accepted_tokens_total");
    const mtpDrafted = this._getVllmMetric(txt, "spec_decode_num_draft_tokens_total");
    this.mtpAcceptanceRate =
      mtpAccepted != null && mtpDrafted != null && mtpDrafted > 0
        ? Math.round((mtpAccepted / mtpDrafted) * 10000) / 10000
        : null;
  }

  /**
   * Apply SGLang /server_info (or deprecated /get_server_info).
   * Older builds expose total_input_tokens / total_output_tokens.
   * Current builds (metrics often off) expose sticky last_gen_throughput under
   * internal_states[i]. Only treat it as live after the value changes between
   * polls, then expire to 0 when it stops moving (idle leftover).
   * @param {Record<string, unknown>} sgData
   * @param {number} dtSec
   */
  _applySglangServerInfo(sgData, dtSec) {
    // Prefer true max context (context_length / max_total_tokens). Do NOT use
    // max_total_num_tokens — that is the KV-cache pool budget across concurrent
    // sequences and is often ~2× the configured context (showed 2.1M for a 1M run).
    const explicitCtx =
      LlmProbe._positiveNumber(sgData.context_length) ??
      LlmProbe._positiveNumber(sgData.max_total_tokens);
    if (explicitCtx != null) {
      this.contextLength = explicitCtx;
    } else if (this.contextLength == null) {
      this.contextLength =
        LlmProbe._positiveNumber(sgData.max_req_input_len) ??
        LlmProbe._positiveNumber(sgData.max_total_num_tokens) ??
        null;
    }

    if (sgData.model_path) {
      applyModelRef(this, sgData.model_path);
    }

    const maxRunning = Number(sgData.max_running_requests);
    if (Number.isFinite(maxRunning) && maxRunning > 0) {
      this.slotsTotal = Math.round(maxRunning);
    }

    const inTok = sgData.total_input_tokens;
    const outTok = sgData.total_output_tokens;
    // Newer SGLang builds expose total_cached_tokens (radix/prefix cache
    // served) next to the totals; older ones fall back to Prometheus.
    const cachedNum = Number(sgData.total_cached_tokens);
    const sgCached = Number.isFinite(cachedNum) && cachedNum >= 0 ? cachedNum : null;
    if (inTok != null && outTok != null) {
      const input = Number(inTok);
      const output = Number(outTok);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        const deltaIn = input - this.lastTokenCounts.input;
        const deltaOut = output - this.lastTokenCounts.output;
        this.lastTokenCounts.input = input;
        this.lastTokenCounts.output = output;
        this.totalOutputTokens = output;
        this.totalPromptTokens = input;
        if (sgCached != null) this.totalCachedTokens = sgCached;
        this._sglangTotalsPolled = true;
        this._sglangTokenSource = "server_info";
        if (dtSec > 0 && dtSec < 10) {
          this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
          this._setPrefillTps(deltaIn / dtSec, deltaOut > 0);
        }
        return;
      }
    }

    // No cumulative counters — sticky last_gen_throughput only while it moves,
    // unless /v1/loads (or /get_load) says requests are in flight.
    const lastGen = LlmProbe._sglangLastGenThroughput(sgData);
    this.generationTps = this._sglangStickyThroughput(lastGen, this._sglangInflight());
  }

  /** True when SGLang load probe reported running or waiting requests. */
  _sglangInflight() {
    return (
      this.slotsActive > 0 ||
      (this.requestsRunning != null && this.requestsRunning > 0) ||
      (this.requestsWaiting != null && this.requestsWaiting > 0)
    );
  }

  /**
   * Prefer /v1/loads (num_running_reqs). Fall back to /get_load, where
   * num_reqs is running + waiting.
   */
  async _probeSglangLoad() {
    this._sglangLoadGenTps = null;
    for (const path of ["/v1/loads", "/get_load"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (this._applySglangLoad(data)) return;
      } catch {
        /* try next */
      }
    }
  }

  /**
   * Apply SGLang /v1/loads or /get_load. Returns true when a row was applied.
   * @param {unknown} payload
   * @returns {boolean}
   */
  _applySglangLoad(payload) {
    const rows = LlmProbe._sglangLoadRows(payload);
    if (!rows.length) return false;
    let running = 0;
    let waiting = 0;
    let saw = false;
    let loadGen = null;
    for (const row of rows) {
      const gen = Number(row.gen_throughput);
      if (Number.isFinite(gen) && gen >= 0) {
        loadGen = loadGen == null ? gen : Math.max(loadGen, gen);
      }
      const wait = Number(row.num_waiting_reqs);
      const runDirect = Number(row.num_running_reqs);
      const total = Number(row.num_reqs);
      if (Number.isFinite(wait) && wait >= 0) {
        waiting += wait;
        saw = true;
      }
      if (Number.isFinite(runDirect) && runDirect >= 0) {
        running += runDirect;
        saw = true;
      } else if (Number.isFinite(total) && total >= 0) {
        const waitPart = Number.isFinite(wait) && wait >= 0 ? wait : 0;
        running += Math.max(0, total - waitPart);
        saw = true;
      }
    }
    if (!saw) return false;
    this._sglangLoadGenTps = loadGen;
    this.requestsRunning = running;
    this.requestsWaiting = waiting;
    this.slotsActive = Math.round(running);
    return true;
  }

  /**
   * @param {unknown} payload
   * @returns {Array<Record<string, unknown>>}
   */
  static _sglangLoadRows(payload) {
    if (payload == null) return [];
    if (Array.isArray(payload)) {
      return payload.filter((row) => row && typeof row === "object");
    }
    if (typeof payload !== "object") return [];
    if (Array.isArray(payload.loads)) {
      return payload.loads.filter((row) => row && typeof row === "object");
    }
    if (payload.num_reqs != null || payload.num_running_reqs != null) {
      return [payload];
    }
    return [];
  }

  /**
   * Map SGLang's sticky last_gen_throughput gauge to a live panel rate.
   * Returns 0 until the value changes between polls (avoids showing a stale
   * leftover after idle); stays live for a short window after each change.
   * When `inflight` is true (independent load signal), keep a positive rate
   * even if the gauge is not moving — a busy decode can report a constant value.
   * @param {number | null} raw
   * @param {boolean} [inflight]
   * @returns {number}
   */
  _sglangStickyThroughput(raw, inflight = false) {
    if (raw == null || !Number.isFinite(raw) || raw < 0) {
      this._sglangStickyTps = null;
      return 0;
    }
    const rounded = Math.round(raw * 100) / 100;
    const now = Date.now();
    const prev = this._sglangStickyTps;

    if (!prev) {
      // First sample after reset/start — seed only unless load says we are busy
      this._sglangStickyTps = {
        value: rounded,
        liveUntil: inflight && rounded > 0 ? now + SGLANG_STICKY_TPS_LIVE_MS : 0,
      };
      return inflight && rounded > 0 ? rounded : 0;
    }

    if (rounded !== prev.value) {
      this._sglangStickyTps = {
        value: rounded,
        liveUntil: now + SGLANG_STICKY_TPS_LIVE_MS,
      };
      return rounded;
    }

    if (prev.liveUntil > now) {
      return rounded;
    }
    if (inflight && rounded > 0) {
      return rounded;
    }
    return 0;
  }

  /**
   * @param {unknown} v
   * @returns {number | null}
   */
  static _positiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Max last_gen_throughput across internal_states (or top-level).
   * @param {Record<string, unknown>} sgData
   * @returns {number | null}
   */
  static _sglangLastGenThroughput(sgData) {
    if (!sgData || typeof sgData !== "object") return null;
    const top = Number(sgData.last_gen_throughput);
    if (Number.isFinite(top) && top >= 0) return top;

    const states = sgData.internal_states;
    if (!Array.isArray(states) || !states.length) return null;
    let best = null;
    for (const st of states) {
      if (!st || typeof st !== "object") continue;
      const v = Number(st.last_gen_throughput);
      if (!Number.isFinite(v) || v < 0) continue;
      if (best == null || v > best) best = v;
    }
    return best;
  }

  /**
   * Live decode tok/s. Current SGLang builds publish gen_throughput while a
   * request runs, and only then add the whole completion to
   * generation_tokens_total. Differencing that counter stays at 0 for the
   * whole decode and spikes once when the request ends.
   * Max, not sum: tensor-parallel ranks repeat the same gauge.
   * @param {string} txt
   * @returns {number | null}
   */
  _sglangGenGauge(txt) {
    const prom =
      this._getPromMetricMax(txt, "sglang:gen_throughput") ??
      this._getPromMetricMax(txt, "sglang_gen_throughput");
    if (prom != null) return prom;
    return this._sglangLoadGenTps;
  }

  /**
   * Cumulative prefill tokens that actually did compute (cache misses).
   * Prefers the per-mode counters; falls back to prompt − cached when only the
   * plain prompt counter exists. Kept separate from prompt_tokens_total, which
   * also counts cache-served tokens (the bulk of a warm session).
   * @param {string} txt
   * @returns {number | null}
   */
  _sglangPrefillComputeTokens(txt) {
    const direct =
      this._getPromMetricLabeled(txt, "sglang:realtime_tokens_total", "mode", "prefill_compute") ??
      this._getPromMetricLabeled(txt, "sglang_realtime_tokens_total", "mode", "prefill_compute") ??
      this._getPromMetricLabeled(txt, "sglang:prefill_effective_tokens_total", "mode", "input") ??
      this._getPromMetricLabeled(txt, "sglang_prefill_effective_tokens_total", "mode", "input");
    if (direct != null) return direct;
    const prompt =
      this._getPromMetric(txt, "sglang:prompt_tokens_total") ??
      this._getPromMetric(txt, "sglang_prompt_tokens_total");
    const cached = this._sglangCachedTokens(txt);
    if (prompt != null && cached != null) return Math.max(0, prompt - cached);
    return null;
  }

  /**
   * Apply SGLang Prometheus /metrics (--enable-metrics).
   * Supports both `sglang:` and `sglang_` prefixes.
   * @param {string} txt
   * @param {number} dtSec
   */
  _applySglangMetrics(txt, dtSec) {
    const gen =
      this._getPromMetric(txt, "sglang:generation_tokens_total") ??
      this._getPromMetric(txt, "sglang_generation_tokens_total");
    const prompt =
      this._getPromMetric(txt, "sglang:prompt_tokens_total") ??
      this._getPromMetric(txt, "sglang_prompt_tokens_total");

    const running =
      this._getPromMetric(txt, "sglang:num_running_reqs") ??
      this._getPromMetric(txt, "sglang_num_running_reqs");
    if (running != null) {
      this.requestsRunning = running;
      this.slotsActive = Math.round(running);
    }
    if (gen == null) {
      const gauge = this._sglangGenGauge(txt);
      if (gauge != null) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      }
      return;
    }

    // Prefill accounting: the tile counts every prompt token taken in this
    // window — cache-served + computed — and the split rows below break it
    // down. The per-mode counters are exact; prompt_tokens_total alone cannot
    // tell the two apart (it also folds in host/storage hits), so it is the
    // fallback for builds without the realtime series.
    const prefillCompute = this._sglangPrefillComputeTokens(txt);
    const cached = this._sglangCachedTokens(txt);

    // Difference only against our own baseline; after a server-info hand-off
    // the first sample seeds instead of reporting the gap between two series.
    const ownsBaseline = this._sglangTokenSource !== "server_info";
    const canDiff = ownsBaseline && dtSec > 0 && dtSec < 10;
    if (canDiff) {
      const deltaOut = gen - this.lastTokenCounts.output;
      const gauge = this._sglangGenGauge(txt);
      const busy = (running != null && running > 0) || this._sglangInflight();
      if (gauge != null && busy) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      } else if (gauge != null) {
        // Idle, or the completion just landed in the counter. The gauge already
        // carried the live rate; the counter jump is not another tok/s sample.
        this.generationTps = 0;
      } else {
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
      }
      if (prefillCompute == null && prompt != null) {
        // No per-mode counters: the prompt counter is the only total we have.
        const deltaIn = prompt - this.lastTokenCounts.input;
        this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
      } else if (prefillCompute == null && deltaOut <= 0) {
        this.prefillTps = 0;
      }
    }
    // Seed outside the rate window too: on the first poll after a restart the
    // window is unusable, and a stale 0 baseline would turn the engine's
    // lifetime prompt counter into a rate on the next poll (#99).
    this.lastTokenCounts.output = gen;
    if (prompt != null) this.lastTokenCounts.input = prompt;
    this._sglangTokenSource = "prometheus";
    this.totalOutputTokens = gen;
    this.totalPromptTokens = prompt ?? null;
    // Cached share from the same exposition (device layer preferred).
    const cachedNow = this._sglangCachedTokens(txt);
    if (cachedNow != null) this.totalCachedTokens = cachedNow;

    // The tile reads cache-served + computed; the split rows below show the
    // two parts. Poll-window rates, not latches: a window that prefilled
    // nothing reads 0 even while unrelated requests are still decoding
    // (holding the last value here kept a stale number on screen for hours).
    if (prefillCompute != null && cached != null) {
      this._setPrefillSplitRates(cached, prefillCompute, dtSec);
      if (
        canDiff &&
        this.uncachedPrefillTps != null &&
        this.cachedPrefillTps != null
      ) {
        const total = this.uncachedPrefillTps + this.cachedPrefillTps;
        this.prefillTps = Math.max(0, Math.round(total * 100) / 100);
      }
    }
  }

  /**
   * Cache split only — does not touch generation/prefill lastTokenCounts.
   * Prefers cache_source="device" so HiCache L1/L2/L3 labels are not summed.
   */
  _applySglangPrefillSplit(txt, dtSec) {
    const compute = this._sglangPrefillComputeTokens(txt);
    const cached = this._sglangCachedTokens(txt);
    if (cached != null) this.totalCachedTokens = cached;
    if (compute != null && cached != null) {
      this._setPrefillSplitRates(cached, compute, dtSec);
    }
  }

  _sglangCachedTokens(txt) {
    return (
      this._getPromMetricLabeled(txt, "sglang:realtime_tokens_total", "mode", "prefill_cache") ??
      this._getPromMetricLabeled(txt, "sglang_realtime_tokens_total", "mode", "prefill_cache") ??
      this._getPromMetricLabeled(txt, "sglang:cached_tokens_total", "cache_source", "device") ??
      this._getPromMetricLabeled(txt, "sglang_cached_tokens_total", "cache_source", "device") ??
      this._getPromMetricMax(txt, "sglang:cached_tokens_total") ??
      this._getPromMetricMax(txt, "sglang_cached_tokens_total")
    );
  }

  /** Prefer SGLang /model_info (or deprecated /get_model_info) over raw HF cache paths. */
  async _enrichSglangModelInfo() {
    for (const path of SGLANG_MODEL_INFO_PATHS) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json();
        const raw = data?.model_path || data?.tokenizer_path;
        if (!raw) continue;
        applyModelRef(this, raw);
        return;
      } catch {
        /* try next */
      }
    }
  }

  // ─── llama.cpp native path ────────────────────────────────
  async _probeLlamaCpp() {
    this._llamaCumulative = null;
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Slots
    let slotsOk = false;
    try {
      const slotsRes = await this._fetch(`${this.baseUrl}/slots`);
      const auth = this._noteAuthStatus(slotsRes.status);
      if (auth === "auth") {
        return this._getSnapshot();
      }
      if (auth === "ok") {
        const slots = await slotsRes.json();
        if (Array.isArray(slots)) {
          slotsOk = true;
          this.slotsTotal = slots.length;
          // Some llama.cpp builds use is_processing instead of state
          this.slotsActive = slots.filter((s) => s.is_processing || (s.state && s.state !== "idle")).length;

          let totalGen = 0;
          let totalPrefill = 0;
          let totalDecoded = 0;
          let promptedSum = 0;
          let cachedSum = 0;
          let sawCache = false;

          for (const slot of slots) {
            const slotId = slot.id ?? "default";
            const decoded = this._getSlotDecoded(slot);
            const prompted = this._getSlotPrefilled(slot);
            const cached = this._getSlotCached(slot);
            const taskId = slot.id_task ?? null;
            totalDecoded += decoded;
            promptedSum += prompted;
            if (cached != null) cachedSum += cached;
            if (cached != null) sawCache = true;
            const lastState = this.slotState.get(slotId);
            this.slotState.set(slotId, { decoded, prompted, cached: cached ?? 0, taskId });
            // Slot counters are per-task: a delta is only a rate while the
            // same task stays on the slot. First contact and task switches
            // contribute nothing this interval — otherwise a slot mid-task
            // counts its whole history (largely prompt-cache hits) inside one
            // poll and poisons the daily peaks with impossible tok/s spikes.
            if (lastState == null || lastState.taskId !== taskId) continue;
            if (!(dtSec > 0 && dtSec < 10)) continue;
            const dDecoded = decoded - lastState.decoded;
            const dPrompted = prompted - lastState.prompted;
            if (dDecoded > 0) totalGen += dDecoded / dtSec;
            if (dPrompted > 0) {
              totalPrefill += dPrompted / dtSec;
              this._llamaComputedCum += dPrompted;
            }
            if (cached != null) {
              const dCached = cached - (lastState.cached || 0);
              if (dCached > 0) this._llamaCachedCum += dCached;
            }
          }

          this.totalOutputTokens = totalDecoded;
          this.totalPromptTokens = promptedSum;
          if (sawCache) this.totalCachedTokens = cachedSum;
          this.generationTps = Math.max(0, Math.round(totalGen * 100) / 100);
          this._setPrefillTps(totalPrefill, totalGen > 0);
          if (sawCache) this._setPrefillSplitRates(this._llamaCachedCum, this._llamaComputedCum, dtSec);
        }
      }
    } catch {}

    if (!slotsOk) {
      throw new Error("llama.cpp /slots unreachable");
    }

    // Props (model info)
    try {
      const propsRes = await this._fetch(`${this.baseUrl}/props`);
      if (propsRes.ok) {
        const props = await propsRes.json();
        const raw = props.model_alias || props.model_path || this.modelId;
        if (props.model_path && !isHfHubCachePath(props.model_path)) {
          this.modelPath = props.model_path;
        } else if (isHfHubCachePath(props.model_path) || isHfHubCachePath(props.model_alias)) {
          this.modelPath = null;
        }
        if (raw) this.modelId = normalizeModelId(raw);
        this.contextLength = props.total_context_length || props.context_length || this.contextLength;
      }
    } catch {}

    // Monotonic token counter. The per-slot n_decoded sum resets whenever a
    // slot picks up a new task, so it cannot be diffed into token volume.
    if (this._llamaMetricsOk !== false) {
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          this._llamaMetricsOk = true;
          const txt = await metricsRes.text();
          const predicted = this._getPromMetric(txt, "llamacpp:tokens_predicted_total");
          if (predicted != null && Number.isFinite(predicted)) {
            this.totalOutputTokens = predicted;
            this._llamaCumulative = predicted;
          }
        } else if (metricsRes.status === 404 || metricsRes.status === 501) {
          // Server started without --metrics; stop asking every poll.
          this._llamaMetricsOk = false;
        }
      } catch {}
    }

    this.backendType = "llama.cpp";
    return this._getSnapshot();
  }

  // ─── Metrics helpers ─────────────────────────────────────
  /**
   * Sum all Prometheus series matching `name` (optional labels).
   * @param {string} body
   * @param {string} name Full metric name, e.g. "ds4_decode_tok_s" or "vllm:prompt_tokens_total"
   * @returns {number | null}
   */
  _getPromMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  /**
   * Max of Prometheus series matching `name` (avoids summing HiCache layers).
   * @param {string} body
   * @param {string} name
   * @returns {number | null}
   */
  _getPromMetricMax(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let best = null;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) best = best == null ? v : Math.max(best, v);
    }
    return best;
  }

  /**
   * Sum series of `name` whose label `labelKey` equals `labelValue`.
   * @param {string} body
   * @param {string} name
   * @param {string} labelKey
   * @param {string} labelValue
   * @returns {number | null}
   */
  _getPromMetricLabeled(body, name, labelKey, labelValue) {
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escKey = labelKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escVal = labelValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `^${escName}\\{[^}]*\\b${escKey}="${escVal}"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  _getVllmMetric(body, name) {
    return this._getPromMetric(body, `vllm:${name}`);
  }

  /**
   * Parse a Prometheus histogram from /metrics text.
   * Returns { buckets: [{upper, count}], total } with cumulative counts per
   * `le`, summed across label sets. `total` is the summed `_count` series
   * (or null). `countMetricName` is the full metric name (with prefix).
   */
  _parseHistogram(body, metricPrefix, countMetricName) {
    const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Bucket lines: <metricPrefix>_bucket{...le="X"...} VALUE
    const bucketRe = new RegExp(
      `^${esc}_bucket\\{[^}]*\\ble="([^"]+)"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    const byUpper = new Map();
    let infCount = 0;
    let m;
    while ((m = bucketRe.exec(body)) !== null) {
      const le = m[1];
      const count = parseFloat(m[2]);
      if (!Number.isFinite(count)) continue;
      const upper = le === "+Inf" ? Infinity : parseFloat(le);
      if (upper !== Infinity && !Number.isFinite(upper)) continue;
      if (upper === Infinity) infCount += count;
      byUpper.set(upper, (byUpper.get(upper) || 0) + count);
    }
    const total = this._getPromMetric(body, countMetricName);
    // Prometheus invariant: +Inf bucket count == _count. Mismatch → refuse quantile.
    if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
      return { buckets: [], total: null };
    }
    const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
    buckets.sort((a, b) => a.upper - b.upper);
    return { buckets, total };
  }

  /**
   * Parse a vLLM Prometheus histogram from /metrics text (vllm: prefix).
   */
  _parseVllmHistogram(body, metricPrefix) {
    const name = metricPrefix.replace(/^vllm:/, "");
    return this._parseHistogram(body, metricPrefix, `vllm:${name}_count`);
  }

  /**
   * Prometheus-style linear interpolation for a histogram quantile.
   * Returns null when empty / invalid or target is in the +Inf tail.
   */
  _histogramQuantile(buckets, total, quantile) {
    if (!buckets || !buckets.length || total == null || total <= 0) return null;
    const target = total * quantile;
    let prevUpper = 0.0;
    let prevCount = 0.0;
    for (const { upper, count } of buckets) {
      if (count >= target) {
        if (!Number.isFinite(upper)) return null;
        if (count === prevCount) return upper;
        return prevUpper + (upper - prevUpper) * ((target - prevCount) / (count - prevCount));
      }
      prevUpper = upper;
      prevCount = count;
    }
    return null;
  }

  _getSlotDecoded(slot) {
    // Some llama.cpp builds nest n_decoded inside next_token[0]
    if (slot.n_decoded != null) {
      if (Array.isArray(slot.n_decoded)) return slot.n_decoded[0] || 0;
      return slot.n_decoded || 0;
    }
    // Fallback: next_token[0].n_decoded (newer llama.cpp)
    if (Array.isArray(slot.next_token) && slot.next_token[0]?.n_decoded != null) {
      return slot.next_token[0].n_decoded;
    }
    return 0;
  }

  _getSlotPrefilled(slot) {
    if (slot?.n_prompt_tokens_processed != null) {
      const n = Number(slot.n_prompt_tokens_processed);
      if (Number.isFinite(n)) return n;
    }
    return slot?.n_prompt_tokens || 0;
  }

  /** Cached prompt tokens on a llama.cpp slot, or null when the field is absent. */
  _getSlotCached(slot) {
    if (slot == null || slot.n_prompt_tokens_cache == null) return null;
    const n = Number(slot.n_prompt_tokens_cache);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Observational exposure hint from probe target + unauthenticated reachability.
   * Does not claim process bind address (0.0.0.0 vs interface).
   */
  _buildPosture() {
    if (this.authOpen == null) return null;

    const host = llmProbeHost(this.spark);
    const scope = classifyHostScope(host);
    const keyed = Boolean(this._apiKey());
    /** @type {"open" | "protected" | "keyed"} */
    let auth;
    if (keyed) {
      // Key configured: success → keyed; 401/403 → protected (rejected)
      auth = this.authOpen === false ? "protected" : "keyed";
    } else {
      auth = this.authOpen ? "open" : "protected";
    }

    let level = "ok";
    if (auth === "open") {
      if (scope === "public") level = "danger";
      else if (scope === "local") level = "ok";
      else level = "warn"; // lan or unknown hostname
    } else if (keyed && auth === "protected") {
      level = "danger";
    }

    const scopeWords = {
      local: "loopback",
      lan: "LAN",
      public: "public",
      unknown: "unknown-host",
    };
    const shortScope = {
      local: "Local",
      lan: "LAN",
      public: "Public",
      unknown: "Host",
    };
    const label =
      auth === "protected"
        ? keyed
          ? "Bad API key"
          : "Auth required"
        : auth === "keyed"
          ? `API key · ${shortScope[scope]}`
          : `Open · ${shortScope[scope]}`;
    const detail =
      auth === "protected"
        ? keyed
          ? `Configured API key was rejected (401/403) · ${scopeWords[scope]} target (${host || "—"}).`
          : `API key required · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
        : auth === "keyed"
          ? `Using configured API key · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`
          : `Unauthenticated · ${scopeWords[scope]} target (${host || "—"}). Based on the configured probe host, not the process bind address.`;

    return { level, auth, scope, label, detail };
  }

  _getSnapshot() {
    // A router with nothing resident is idle, not broken: show the empty-state
    // panel instead of the last engine's numbers.
    const routerIdle = this.router != null && this.engineId == null;
    const metricsLive =
      this.serverIsOpenAI !== null && this.authOpen !== false && !routerIdle;
    return {
      available: metricsLive,
      backend: this.backendType,
      modelId: this.modelId || null,
      modelPath: this.modelPath || null,
      contextLength: this.contextLength,
      gpuMemoryUtilization: this.gpuMemoryUtilization,
      slotsActive: this.slotsActive,
      slotsTotal: this.slotsTotal,
      generationTps: this.generationTps,
      prefillTps: this.prefillTps,
      cachedPrefillTps: this.cachedPrefillTps,
      uncachedPrefillTps: this.uncachedPrefillTps,
      totalOutputTokens: this.totalOutputTokens,
      totalPromptTokens: this.totalPromptTokens ?? null,
      totalCachedTokens: this.totalCachedTokens ?? null,
      cumulativeOutputTokens:
        this.backendType === "llama.cpp" ? this._llamaCumulative : this.totalOutputTokens,
      kvCacheUsage: this.kvCacheUsage,
      requestsRunning: this.requestsRunning,
      requestsWaiting: this.requestsWaiting,
      ttftP95Seconds: this.ttftP95Seconds,
      ttftSeconds: this.ttftSeconds,
      preemptionsTotal: this.preemptionsTotal,
      prefixCacheHitRate: this.prefixCacheHitRate,
      e2eP95Seconds: this.e2eP95Seconds,
      itlP95Seconds: this.itlP95Seconds,
      mtpAcceptanceRate: this.mtpAcceptanceRate,
      router: this.router,
      routerModel: this.routerModel,
      routerModelName: this.routerModelName,
      routerLoading: this.routerLoading,
      studio: this.studio,
      engineId: this.engineId,
      routerResident: this.routerResident,
      routerEngines: this._routerEngines(),
      routerEvents: this.routerEvents,
      routerActivity: this.routerActivity,
      routerModels: this.routerModels,
      posture: this._buildPosture(),
      error: this.error,
    };
  }

  _defaultLlm() {
    return {
      available: false,
      backend: this.backendType,
      modelId: null,
      modelPath: null,
      contextLength: null,
      gpuMemoryUtilization: null,
      slotsActive: 0,
      slotsTotal: 0,
      generationTps: 0,
      prefillTps: 0,
      cachedPrefillTps: null,
      uncachedPrefillTps: null,
      totalOutputTokens: 0,
      totalCachedTokens: null,
      kvCacheUsage: null,
      requestsRunning: null,
      requestsWaiting: null,
      ttftP95Seconds: null,
      ttftSeconds: null,
      preemptionsTotal: null,
      prefixCacheHitRate: null,
      e2eP95Seconds: null,
      itlP95Seconds: null,
      mtpAcceptanceRate: null,
      router: this.router,
      routerModel: null,
      routerModelName: null,
      routerLoading: this.routerLoading,
      engineId: null,
      studio: null,
      routerResident: this.routerResident,
      routerEngines: this._routerEngines(),
      routerEvents: [],
      routerActivity: null,
      routerModels: [],
      posture: this._buildPosture(),
      error: this.error,
    };
  }

  // ─── HTTP helpers ────────────────────────────────────────
  _apiKey() {
    const keys = this.spark?.llmApiKeys;
    if (!keys || typeof keys !== "object") return null;
    const raw = keys[String(this.port)] ?? keys[this.port];
    const key = raw != null ? String(raw).trim() : "";
    return key || null;
  }

  /**
   * The configured key belongs to the probe target. A router may name an
   * upstream on another host; the key must not follow it there.
   * @param {string} url
   */
  _sameHostAsProbe(url) {
    try {
      return new URL(url).hostname === new URL(this.baseUrl).hostname;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} url
   * @param {{ authenticated?: boolean, method?: string, timeoutMs?: number, longLived?: boolean }} [opts]
   *   `authenticated: false` sends no credentials (probing an upstream origin the
   *   router merely names). `longLived` lifts undici's 300 s header/body idle cut
   *   for a request that is expected to block (a model load).
   */
  async _fetch(
    url,
    { authenticated = true, method = "GET", timeoutMs = LLM_PROBE_TIMEOUT_MS, longLived = false } = {}
  ) {
    const headers = {};
    const apiKey = authenticated ? this._apiKey() : null;
    if (apiKey && this._sameHostAsProbe(url)) headers.Authorization = `Bearer ${apiKey}`;
    // A 3xx is a failure, never followed: a redirect would carry the probe (and
    // its credentials) to a host the operator did not approve.
    const init = { method, signal: AbortSignal.timeout(timeoutMs), headers, redirect: "manual" };
    // undici's own fetch must be paired with its own Agent (see LLM_STREAM_AGENT).
    const res = longLived
      ? await undiciFetch(url, { ...init, dispatcher: LLM_STREAM_AGENT })
      : await fetch(url, init);
    // Release a redirect's socket now instead of at the timeout; callers see !ok.
    if (res.status >= 300 && res.status < 400) await res.body?.cancel().catch(() => {});
    return res;
  }
}
