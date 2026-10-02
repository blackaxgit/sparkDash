// ─── Spark config (matches server/sparks.json) ────────────
export interface SparkConfig {
  id: string;
  name: string;
  /**
   * Unit type:
   * - spark: NVIDIA DGX Spark (default) — DGX Spark specs shown in the header.
   * - host: any Linux box with an NVIDIA GPU (still monitored via nvidia-smi,
   *   just not a Spark). Real hardware is auto-detected once online.
   */
  kind?: "spark" | "host";
  lanIp: string;
  cx7Ip?: string | null;
  /**
   * Optional Wake-on-LAN MAC override. When empty, the server uses
   * `detectedMacAddress` from the enP7s7 interface.
   */
  macAddress?: string | null;
  /** Last MAC read from enP7s7 while the Spark was online (read-only). */
  detectedMacAddress?: string | null;
  isLocal: boolean;
  ssh: {
    host: string;
    user: string;
    auth: "key" | "pass";
    /** Request-only: never returned by GET/list */
    password?: string;
    /** Response-only: true when a password is held in server memory */
    hasPassword?: boolean;
  };
  disabledDevices?: string[];
  /** Interface names hidden from the Network panel main view */
  disabledInterfaces?: string[];
  /** HTTP port for the LLM server on this Spark (legacy single-port, prefer llmPorts) */
  llmPort?: number;
  /** HTTP ports for LLM servers on this Spark (default [8888]) */
  llmPorts?: number[];
  /**
   * Ports that have an encrypted LLM API key stored server-side.
   * The key itself is never returned by the API.
   */
  llmApiKeyPorts?: number[];
  /**
   * Cluster role for overview + worker behavior.
   * - head / standalone: local LLM API probed
   * - worker: no local API (LLM card hidden, ports not probed)
   */
  role?: SparkRole;
  /**
   * Legacy/derived: true when role is worker. Prefer `role`.
   * Kept so existing probe/card checks keep working.
   */
  workerNode?: boolean;
  /**
   * Optional label for a worker node (cluster / model name), shown on the overview card.
   * Only meaningful when role is worker.
   */
  workerLabel?: string | null;
  /**
   * Optional id of the head Spark this worker belongs to.
   * Only meaningful when role is worker.
   */
  workerHeadId?: string | null;
  /**
   * Standalone only: probe local LLM and show the LLM card (default true).
   * Forced true for head, forced false for worker.
   */
  llmMonitoring?: boolean;
  /**
   * Probe local ComfyUI and show the ComfyUI card (default false; all roles).
   */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188). */
  comfyPort?: number;
  /**
   * Opt-in: Hermes Agent CLI (nousresearch/hermes-agent) is installed on this
   * machine. When enabled, sparkDash checks for Hermes updates and can run
   * `hermes update` for you via SSH.
   */
  hermesMonitoring?: boolean;
  /**
   * Report tailnet presence via `tailscale status --json` (default false; all roles).
   */
  tailscaleMonitoring?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

export type SparkRole = "head" | "worker" | "standalone";

// ─── Hermes Agent status ───────────────────────────────
/** Opt-in Hermes Agent update monitoring state, pushed in every snapshot. */
export interface HermesStatus {
  /** Opt-in setting from Edit Spark (hermes installed on this machine). */
  monitoring: boolean;
  /** Whether the `hermes` binary was found on the target. null before first check. */
  installed: boolean | null;
  /** Installed version string when detected (e.g. "0.20.0"). */
  version: string | null;
  /** true when `hermes update --check` reports commits behind origin/main. */
  updateAvailable: boolean | null;
  /** Number of commits behind origin/main when reported. */
  behindCommits: number | null;
  /** Last check time (ms epoch). */
  checkedAt: number | null;
  /** One-shot update job state. */
  status: "idle" | "running" | "success" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  /** Short human-readable message when the last check/update failed. */
  error: string | null;
}

/** Latest public Hermes Agent release (changelog for the update dialog). */
export interface HermesRelease {
  /** GitHub release tag, e.g. "v2026.7.7.2". */
  tagName: string;
  /** Human release name, e.g. "Hermes Agent v0.18.1 (v2026.7.7.2)". */
  name: string;
  version: string;
  /** Semantic version of the release (e.g. "0.20.0") for bump detection. */
  semver: string | null;
  publishedAt: string | null;
  htmlUrl: string;
  /** Markdown release body. */
  body: string;
}

/** One pending commit an update would bring (from git HEAD..origin/main). */
export interface HermesPendingCommit {
  sha: string;
  title: string;
}

/** One Spark's outcome from a batch `update-all` call. */
export interface HermesBatchUpdateResult {
  id: string;
  name: string;
  ok: boolean;
  started: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface HermesBatchUpdateResponse {
  success: boolean;
  results: HermesBatchUpdateResult[];
}

/** Per-Spark update preview used by the confirmation dialog. */
export interface HermesUpdatesResponse {
  success: boolean;
  /** Which content the dialog should lead with. */
  view: "commits" | "release";
  /** Latest tagged release (may be null on GitHub API failure). */
  release: HermesRelease | null;
  releaseError: string | null;
  /** Installed hermes version on this Spark (e.g. "0.20.0"), when known. */
  installedVersion: string | null;
  /** Pending commits from git (may be null if the repo can't be read). */
  pending: { count: number; headSha: string | null; commits: HermesPendingCommit[] } | null;
}

// ─── Hardware info ───────────────────────────────────────
export interface HardwareInfo {
  device: string;
  cpuModel: string | null;
  cpuCores: number | null;
  totalMemoryGB: number | null;
  gpuChip: string | null;
  /** Number of physical GPUs behind `gpuChip` (absent on DGX Spark units). */
  gpuCount?: number;
  cudaDriver: string | null;
  storageModel: string | null;
}

// ─── GPU metrics ─────────────────────────────────────────
export interface GpuThrottle {
  /** HW or SW thermal slowdown engaged. */
  thermal: boolean;
  /** HW slowdown (may include thermal or power brake). */
  hwSlowdown: boolean;
  /** SW power-cap scaling limiting clocks. */
  powerCap: boolean;
  /** Any limiting reason above. */
  active: boolean;
  reason: "ok" | "thermal" | "power" | "hw" | "unknown";
  smClockMHz: number | null;
  smClockMaxMHz: number | null;
  /** Current SM clock as % of max (0–100). null when clocks unavailable. */
  smClockPct: number | null;
  /** Human-readable active reasons (tooltip). */
  detail: string;
}

/** GPU thermal headroom and slowdown state. */
export interface GpuThermal {
  /** nvidia-smi temperature.gpu.tlimit: degrees C of headroom to the slowdown limit. */
  tlimitC: number | null;
  /** Hottest /sys/class/thermal zone, degrees C. */
  zoneMaxC: number | null;
  /** Lowest 'critical' trip point among the zones, degrees C. */
  zoneCritC: number | null;
  /** clocks_event_reasons_counters.hw_thermal_slowdown (cumulative us since boot). */
  hwSlowdownUs: number | null;
  /** clocks_event_reasons_counters.sw_thermal_slowdown (cumulative us since boot). */
  swSlowdownUs: number | null;
  /** clocks_event_reasons_counters.sw_power_cap (cumulative us since boot). */
  powerCapUs: number | null;
  /** The hw counter grew within the last 10 min. */
  hwSlowdownRecent: boolean;
  /** The sw counter grew within the last 10 min. */
  swSlowdownRecent: boolean;
  level: "ok" | "warn" | "crit" | "unknown";
  /** Human-readable reasons, e.g. "T.Limit headroom 2°C (≤ 2°C)". */
  reasons: string[];
}

// ─── Video studio (ComfyUI behind llama-swap) ────────────
export interface VideoStudioInfo {
  model: string;
  name: string | null;
  description: string | null;
  port: number | null;
  comfyVersion: string | null;
  state: "ready" | "loading" | "unloaded";
}

export interface VideoModels {
  diffusion: string[];
  textEncoders: string[];
  vae: string[];
  loras: string[];
}

export interface VideoActiveJob {
  promptId: string;
  clientId: string | null;
  startedAt: number;
  elapsedMs: number;
  etaMs: number | null;
  /** Estimate: elapsed vs the median duration of recent successful jobs; capped at 99. */
  percent: number | null;
  models: VideoModels;
  width: number | null;
  height: number | null;
  frames: number | null;
  steps: number | null;
}

export interface VideoPendingJob {
  promptId: string;
  clientId: string | null;
  queuedAt: number | null;
}

export interface VideoOutput {
  filename: string;
  subfolder: string;
  kind: "video" | "audio" | "image" | "other";
}

export interface VideoRecentJob {
  promptId: string;
  status: "success" | "error" | "interrupted" | "unknown";
  clientId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  outputs: VideoOutput[];
}

/** 24 buckets, oldest first; the last one is the current hour. */
export interface VideoHourBucket {
  hourStart: number;
  renders: number;
  busyMs: number;
}

export interface VideoLlmWait {
  waiting: number;
  oldestMs: number | null;
  models: string[];
}

export interface VideoMetrics {
  /** false: llama-swap unreachable, or no studio ever seen. */
  available: boolean;
  error?: string;
  /** The resident studio; else the last one seen, with state 'unloaded'. */
  studio: VideoStudioInfo | null;
  queueRunning: number;
  queuePending: number;
  active: VideoActiveJob | null;
  /** Max 10. */
  pending: VideoPendingJob[];
  /** Max 12, newest first. */
  recent: VideoRecentJob[];
  /** 24 hourly buckets. */
  hourly: VideoHourBucket[];
  /** Requests waiting in llama-swap for a NON-studio model; null if /api/events is unavailable. */
  llmWait: VideoLlmWait | null;
  updatedAt: number;
}

export interface GpuMetrics {
  /** false when the GPU collection failed or has not run yet: the values below are placeholders. */
  collected?: boolean;
  temperature: number;
  usage: number;
  power: {
    draw: number;
    limit: number;
    /** Estimated total system power draw (GPU + CPU + CX7/peripherals). */
    systemDraw?: number;
  };
  vram: {
    used: number;
    total: number;
    percentage: number;
    /** MemAvailable in MB — the real free memory in the shared pool. */
    available: number;
  };
  /** Top GPU processes by VRAM usage (sorted descending, max 5). */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
  /** NVIDIA clock throttle / thermal slowdown state from nvidia-smi. */
  throttle?: GpuThrottle | null;
  /** Kernel NVRM NV_ERR_NO_MEMORY count since boot (cached ~60s). */
  nvErrNoMemory?: number;
  /** Thermal headroom / slowdown state (T.Limit, thermal zones, slowdown counters). */
  thermal?: GpuThermal;
  /**
   * Per-physical-GPU breakdown for multi-card hosts. The fields above stay the
   * fleet-wide aggregate (hottest / busiest card, summed power and VRAM), so a
   * one-GPU DGX Spark has exactly one entry here mirroring them.
   */
  gpus?: GpuDevice[];
}

/** One physical GPU as reported by nvidia-smi (`index,name,uuid`). */
export interface GpuDevice {
  index: number;
  name: string | null;
  uuid: string | null;
  temperature: number;
  usage: number;
  power: { draw: number; limit: number };
  vram: { used: number; total: number; percentage: number; available: number };
  throttle?: GpuThrottle | null;
  /** Processes holding memory on this card only. */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  temperature: number;
  draw: number;
  tdp: number;
}

// ─── RAM metrics ─────────────────────────────────────────
export interface RamMetrics {
  used: number;
  total: number;
  percentage: number;
}

// ─── Storage metrics ─────────────────────────────────────
export interface StorageMetrics {
  device: string;
  label: string;
  used: number;
  total: number;
  available: number;
  percentage: number;
  /** Bytes/s. null when the collector cannot measure it (remote sparks). */
  readSpeed: number | null;
  writeSpeed: number | null;
  /** Present when device is in disabledDevices; still returned for Settings UI */
  disabled?: boolean;
}

// ─── Network metrics ─────────────────────────────────────
export interface NetworkInterface {
  name: string;
  rxSpeed: number;
  txSpeed: number;
  /** IPv4 address, e.g. "192.168.1.143". null when unset. */
  ip: string | null;
  /** Interface operstate: "up" | "down" | "unknown" */
  operstate: string;
  /** Present when interface is in disabledInterfaces; still returned for Settings UI */
  disabled?: boolean;
}

export interface NetworkMetrics {
  primaryInterface: string | null;
  linkSpeedMbps: number | null;
  interfaces: NetworkInterface[];
  /** MAC of enP7s7 when present (same value persisted as detectedMacAddress). */
  wolMac?: string | null;
}

// ─── Unified memory metrics ──────────────────────────────
export interface UnifiedMemoryMetrics {
  total: number;
  gpuUsed: number;
  cpuUsed: number;
  used: number;
  available: number;
  percentage: number;
  oomRisk: "low" | "medium" | "high";
  bandwidth: {
    current: number;
    peak: number;
  };
}

/** One model resident behind a llama-swap router, with its own token counters. */
export interface LlmRouterEngine {
  /** Router key — what a client sends to reach this model. */
  model: string;
  /** Friendly name from the router config, when it has one. */
  name: string | null;
  /** Live decode rate of this engine (tok/s). */
  generationTps: number;
  /** Tokens this engine has generated since it started. */
  totalOutputTokens: number;
  /** True for the engine the rest of the card describes. */
  active: boolean;
  /** Live prompt (prefill) rate of this engine (tok/s); 0 when idle. Shows embedders' work. */
  promptTps?: number;
}

/** A llama-swap model state change seen between two `/running` polls. */
export interface LlmRouterEvent {
  at: number;
  model: string;
  state: "loading" | "ready" | "stopped";
  /** ready only: ms from the first `loading` sighting to `ready`; null when the load was not observed. */
  loadMs: number | null;
}

export interface LlmRouterRequestCounts {
  /** 1xx–3xx responses. */
  ok: number;
  /** HTTP 429 — shed by llama-swap's concurrency queue (e.g. while a studio holds the GPU). */
  rejected: number;
  /** Any other status ≥ 400. */
  failed: number;
}

/** Request outcomes from llama-swap's own activity log (`/api/metrics/activity`). */
export interface LlmRouterActivity {
  /** 24 hourly buckets, oldest first; the last one is the current hour. */
  hourly: (LlmRouterRequestCounts & { hourStart: number })[];
  /** Rolling last 60 minutes. */
  lastHour: LlmRouterRequestCounts;
  /** Newest first, at most 5. */
  recentErrors: { at: number; model: string; status: number; message: string | null; src: string | null }[];
  /** True when the activity page was full (999 rows): the hourly chart covers fewer than 24 h. */
  truncated: boolean;
  updatedAt: number;
}

/** A model configured in llama-swap (aliases excluded). */
export interface LlmRouterModel {
  id: string;
  name: string | null;
  loaded: boolean;
}

// ─── LLM metrics ─────────────────────────────────────────
export interface LlmMetrics {
  available: boolean;
  backend: "vllm" | "llama.cpp" | "sglang" | "ds4" | "exl3" | "q27" | "tensorfold" | null;
  modelId: string | null;
  modelPath: string | null;
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  slotsActive: number;
  slotsTotal: number;
  generationTps: number;
  prefillTps: number;
  /** Live cached-prefill tok/s when the backend splits kinds (ds4, llama.cpp, sglang). */
  cachedPrefillTps?: number | null;
  /** Live uncached/computed prefill tok/s when split is available. */
  uncachedPrefillTps?: number | null;
  /** Cumulative total output (generation) tokens as reported by the LLM server */
  totalOutputTokens: number;
  /** Cumulative cached (prefix-cache served) prompt tokens. null when the backend does not expose the split. */
  totalCachedTokens: number | null;
  /** Cumulative total prompt (prefill) tokens as reported by the LLM server. null when the backend does not expose it. */
  totalPromptTokens: number | null;
  /** vLLM KV cache usage fraction (0–1). null when backend !== vllm or unreachable. */
  kvCacheUsage?: number | null;
  /** vLLM running request count. null when unavailable. */
  requestsRunning?: number | null;
  /** vLLM waiting request count. null when unavailable. */
  requestsWaiting?: number | null;
  /** vLLM time-to-first-token p95 in seconds. null when unavailable. */
  ttftP95Seconds?: number | null;
  /** Live recent-window mean TTFT (seconds) from vLLM histogram sum/count deltas. null when unavailable. */
  ttftSeconds?: number | null;
  /** vLLM cumulative preemption count. null when unavailable. */
  preemptionsTotal?: number | null;
  /** vLLM prefix-cache hit rate (hits/queries, 0–1). null when unavailable. */
  prefixCacheHitRate?: number | null;
  /** vLLM end-to-end request latency p95 in seconds. null when unavailable. */
  e2eP95Seconds?: number | null;
  /** vLLM inter-token latency p95 in seconds. null when unavailable. */
  itlP95Seconds?: number | null;
  /** vLLM speculative/MTP acceptance rate (accepted/drafted, 0–1). null when unavailable. */
  mtpAcceptanceRate?: number | null;
  /** "llama-swap" when this port is a model router in front of N engines. */
  router?: "llama-swap" | null;
  /** Router key of the engine being shown — the id clients must send. */
  routerModel?: string | null;
  /** Human label for that model from the router config. */
  routerModelName?: string | null;
  /** Router key of a model that is mid-load (cold start). */
  routerLoading?: string | null;
  /** Models holding memory behind the router right now. */
  routerResident?: number | null;
  /**
   * One row per model holding memory behind the router, followed model first.
   * Each engine counts its own tokens from its own start.
   */
  routerEngines?: LlmRouterEngine[];
  /** Model state changes behind the router, newest first, at most 10. In memory only. */
  routerEvents?: LlmRouterEvent[];
  /** Request outcomes over the last 24 h; null until the first activity read succeeds. */
  routerActivity?: LlmRouterActivity | null;
  /** Configured models (aliases excluded), sorted by id. */
  routerModels?: LlmRouterModel[];
  /** Engine identity (`model@processStart`); changes on every swap/restart. */
  engineId?: string | null;
  /**
   * Observational exposure hint from unauthenticated probe reachability +
   * configured target host scope. null when auth status is unknown.
   * Does not claim process bind address.
   */
  posture?: LlmPosture | null;
  /** The resident ComfyUI video studio (it holds the GPU lease), when there is one. */
  studio?: { model: string; name: string | null } | null;
  error: string | null;
}

/** One UTC day of busy tok/s rollups (null avg = no busy samples). */
export interface LlmDailyDay {
  date: string;
  decodeMax: number;
  decodeAvg: number | null;
  prefillMax: number;
  prefillAvg: number | null;
  cachedPrefillMax: number | null;
  cachedPrefillAvg: number | null;
  uncachedPrefillMax: number | null;
  uncachedPrefillAvg: number | null;
}

export interface LlmDailyResponse {
  sparkId: string;
  port: number;
  days: LlmDailyDay[];
}

/** One UTC hour of generated-token volume. `hour` is "YYYY-MM-DDTHH". */
export interface LlmHourlyBucket {
  hour: string;
  tokens: number;
}

export interface LlmHourlyResponse {
  sparkId: string;
  port: number;
  hours: LlmHourlyBucket[];
}

/** Security posture badge payload from LlmProbe. */
export interface LlmPosture {
  /** ok = green, warn = amber, danger = red */
  level: "ok" | "warn" | "danger";
  auth: "open" | "protected" | "keyed";
  scope: "local" | "lan" | "public" | "unknown";
  /** Short badge text */
  label: string;
  /** Tooltip / title detail */
  detail: string;
}

// ─── ComfyUI metrics ─────────────────────────────────────
/** Active or queued ComfyUI job (parsed from /queue prompt graph). */
export interface ComfyJob {
  id: string;
  status: "running" | "pending";
  /** Workflow title when present in extra_pnginfo. */
  title: string | null;
  /** Model weight files referenced by loader nodes. */
  models: string[];
  nodeCount: number;
  steps: number | null;
  width: number | null;
  height: number | null;
  batchSize: number | null;
  sampler: string | null;
  /** Queue entry create time (ms epoch when available). */
  createTime: number | null;
}

/** Live or estimated progress for the active Comfy job. */
export interface ComfyProgress {
  promptId: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  value: number;
  max: number;
  percent: number | null;
  updatedAt: number;
  /** ws = Comfy WebSocket frames; estimate = elapsed/avg heuristic */
  source?: "ws" | "estimate";
}

export interface ComfyLastJob {
  id: string;
  status: "completed" | "failed" | "cancelled" | string;
  title: string | null;
  durationMs: number | null;
  endedAt: number | null;
}

export interface ComfyModelsInstalled {
  checkpoints: string[];
  loras: string[];
}

export interface ComfyMetrics {
  available: boolean;
  port: number;
  version: string | null;
  pytorchVersion: string | null;
  /** Primary device type from /system_stats (e.g. cpu, cuda) — not VRAM. */
  deviceType?: string | null;
  queueRunning: number;
  queuePending: number;
  /** Currently executing job, if any. */
  activeJob?: ComfyJob | null;
  /** Next pending jobs (capped server-side). */
  pendingJobs?: ComfyJob[];
  progress?: ComfyProgress | null;
  lastJob?: ComfyLastJob | null;
  modelsInstalled?: ComfyModelsInstalled | null;
  /** Estimated ms until queue idle (running remainder + pending × avg). */
  queueEtaMs?: number | null;
  /** Browser-openable ComfyUI base URL (probe host + port). */
  openUrl?: string | null;
  error: string | null;
}

export interface TailscaleMetrics {
  /** True when `tailscale status --json` was read and had a Self entry. */
  available: boolean;
  /**
   * The node's OWN view of whether it is talking to the coordination server.
   * null when tailscale did not report it.
   */
  online: boolean | null;
  /** tailscaled's own state: Running | Stopped | NeedsLogin | NoState. */
  backendState: string | null;
  hostName: string | null;
  dnsName: string | null;
  tailscaleIp: string | null;
  /** DERP relay region, or null when the node has a direct path. */
  relay: string | null;
  /** ISO timestamp; null when key expiry is disabled for this node. */
  keyExpiry: string | null;
  keyExpired: boolean;
  version: string | null;
  /** Tailscale's own health warnings — these explain a false `online`. */
  health: string[];
  error: string | null;
}

// ─── Full metrics snapshot ────────────────────────────────
export interface SparkMetrics {
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  storage: StorageMetrics[];
  network: NetworkMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  /** Array of LLM metrics, one per configured port. Empty array when no ports. */
  llm: LlmMetrics[];
  /** ComfyUI probe result when monitoring is enabled; null when off or not yet polled. */
  comfy?: ComfyMetrics | null;
  /** Tailnet probe result when monitoring is enabled; null when off or not yet polled. */
  tailscale?: TailscaleMetrics | null;
  /** Video-studio (ComfyUI behind llama-swap) state; absent when the LLM endpoint is not a llama-swap router. */
  video?: VideoMetrics;
  /** Host health (pressure, NVMe, PCIe, kernel GPU errors, units, containers, Wi-Fi); absent until first poll. */
  hostHealth?: HostHealthMetrics | null;
}

export interface PsiStat {
  someAvg10: number;
  someAvg60: number;
  /** null for /proc/pressure/cpu on kernels that do not report `full`. */
  fullAvg60: number | null;
}

export interface HostHealthMetrics {
  available: boolean;
  level: "ok" | "warn" | "crit";
  /** Human-readable causes of a warn/crit level, most severe first. */
  reasons: string[];
  psi: { cpu: PsiStat | null; memory: PsiStat | null; io: PsiStat | null };
  load: [number, number, number] | null;
  swap: { totalMb: number; usedMb: number } | null;
  nvme: {
    device: string;
    tempC: number | null;
    percentUsed: number | null;
    writtenTB: number | null;
    unsafeShutdowns: number | null;
    mediaErrors: number | null;
    criticalWarning: number | null;
    powerOnHours: number | null;
  } | null;
  /** PCIe AER error totals since boot, summed over devices. */
  pcieAer: { correctable: number; nonFatal: number; fatal: number } | null;
  /** `NVRM: Xid` kernel lines in the last 24 h. */
  xid24h: number | null;
  lastXid: string | null;
  failedUnits: string[];
  containers: { name: string; state: string; status: string }[];
  wifi: { iface: string; ssid: string | null; signalDbm: number | null; txMbps: number | null; rxMbps: number | null }[];
  updatedAt: number;
  error?: string;
}

/** GET /api/sparks/:id/history — long-term downsampled series. */
export type HistoryRange = "1h" | "24h" | "7d";
export interface HistoryResponse {
  range: HistoryRange;
  stepMs: number;
  /** key (e.g. "gpu.usage", "llm:11434.tps") → [timestampMs, value|null] oldest first. */
  series: Record<string, [number, number | null][]>;
}

// ─── Spark snapshot (server pushes this) ──────────────────
export interface SparkSnapshot {
  id: string;
  name: string;
  /** Unit type: spark (DGX Spark) or host (dedicated GPU Linux box). */
  kind?: "spark" | "host";
  online: boolean;
  /** Uptime in seconds, or null when offline */
  uptime: number | null;
  /** LAN IP for browser deep-links (e.g. Open ComfyUI). */
  lanIp?: string;
  isLocal?: boolean;
  disabledDevices: string[];
  disabledInterfaces: string[];
  storagePollDisabled?: boolean;
  /** Cluster role (head / worker / standalone) */
  role?: SparkRole;
  /** Distributed LLM worker — LLM card inactive / not shown (role === worker) */
  workerNode?: boolean;
  /** Optional cluster/model label when role is worker */
  workerLabel?: string | null;
  /**
   * Derived worker label: live mirror of the head's served model id.
   * Display-only (never written to config). A non-empty manual workerLabel
   * takes priority over this in the UI.
   */
  workerDerivedLabel?: string | null;
  /** Optional head Spark id when role is worker */
  workerHeadId?: string | null;
  /** Standalone: whether LLM is probed (head always true, worker always false) */
  llmMonitoring?: boolean;
  /** LLM server port (first port, for backward compat) */
  llmPort: number;
  /** All LLM server ports configured for this Spark */
  llmPorts: number[];
  /** Ports with a stored LLM API key (key itself never exposed) */
  llmApiKeyPorts?: number[];
  /** Whether ComfyUI is probed (opt-in; all roles) */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188) */
  comfyPort?: number;
  /** Whether tailnet presence is probed (opt-in; all roles) */
  tailscaleMonitoring?: boolean;
  /** Hermes Agent update monitoring state (present in every snapshot). */
  hermes?: HermesStatus;
  hardware: HardwareInfo;
  metrics: SparkMetrics;
}

// ─── WebSocket envelope ───────────────────────────────────
export interface WsSnapshot {
  type: "snapshot";
  /** Server generation time; optional while clients and servers roll independently. */
  generatedAt?: number;
  sparks: SparkSnapshot[];
  refreshInterval: number;
}

export interface FleetEnergy {
  estimated: boolean;
  membershipChanged: boolean;
  restartRequired: boolean;
  trackedNodeIds: string[];
  currentNodeIds: string[];
  freshNodeCount: number;
  currentWatts30s: number | null;
  energy24hKwh: number | null;
  energy31dKwh: number | null;
  whPerOutputToken24h: number | null;
  outputTokens24h: number;
  coverage24hMs: number;
  /** Window coverage24hMs is measured over (server-owned; fleet-size independent). */
  coverage24hWindowMs?: number;
  coverage31dMs: number;
  coverage31dWindowMs?: number;
  nodeCoverage24hMs: Record<string, number>;
  nodeCoverage31dMs: Record<string, number>;
  hourlyWatts24h: Array<number | null>;
}

/**
 * Sparkline history, sent once per connection ahead of the first snapshot.
 *
 * `series` is keyed `${sparkId}:${metric}` exactly as metricsStore keys its
 * own Map — the server derives those keys in
 * server/collectors/MetricsHistory.js and the two MUST stay in step.
 * `max` is the server's cap, for reference; the client applies its own.
 */
export interface WsHistory {
  type: "history";
  series: Record<string, number[]>;
  /** Per-series [firstSampleMs, lastSampleMs]. Optional: a server predating
   *  the timing contract sends none, and the client falls back to cadence. */
  meta?: Record<string, number[]>;
  max: number;
}

export type WsMessage = WsSnapshot | WsHistory;

// ─── API responses ────────────────────────────────────────
export interface Settings {
  pollIntervalMs: number;
  defaultLlmPort: number;
  autoHideOffline: boolean;
  /** Hide worker-role Sparks from Overview cards and the tab bar. */
  hideWorkers: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: boolean;
  /** Layout density — compact (default) or comfortable. */
  density: "comfortable" | "compact";
  /** Overview Fleet Energy card. Off by default. */
  showFleetEnergy: boolean;
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: boolean;
  /** Overview search field + status filter. Off by default. */
  showOverviewSearch: boolean;
  showLlmTokenTotals: boolean;
  /** Benchmark dialogs offer "Copy image" — a PNG share card of the results. */
  benchShareImage: boolean;
  /** Services cards — side-by-side grid (default) or full-width rows. */
  servicesLayout: "grid" | "rows";
}

export interface SparksListResponse {
  sparks: SparkConfig[];
}

export interface SparkTestResponse {
  id: string;
  capabilities: Array<{
    id: "host" | "llm" | "comfy" | "hermes" | "tailnet";
    label: string;
    status: "pass" | "fail" | "skipped";
    required: boolean;
    message: string;
    recovery: string | null;
  }>;
  ssh: { ok: boolean; message: string };
  llm: { ok: boolean; message: string; skipped?: boolean };
  comfy?: { ok: boolean; message: string; skipped?: boolean };
  ok: boolean;
}

export interface ApiError {
  error: string;
}

// ─── LLM decode benchmark ────────────────────────────────
/** Output-shape label for decode bench prompts (not guided decoding). */
export type DecodeBenchPromptType = "structured" | "prose" | "code" | "json";

/** On-demand remote LLM endpoint for decode/prefill benches. */
export interface LlmBenchTarget {
  host: string;
  port: number;
  tls: boolean;
}

export interface DecodeBenchConfig {
  port: number;
  modelId: string | null;
  concurrencies: number[];
  maxTokens: number;
  /** Output-shape label only — not guided decoding / JSON schema. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote host (Tailscale HTTPS, etc.). */
  host?: string;
  tls?: boolean;
}

export interface DecodeBenchStreamResult {
  index: number;
  ttftMs: number;
  /** First answer token (post-reasoning) in ms from request start; null when the reply never leaves the reasoning phase. */
  ttftContentMs: number | null;
  /** Number of streamed chunks that carried reasoning (not answer) text. */
  reasoningChunks: number;
  decodeTps: number;
  decodeTokens: number;
  completionTokens: number;
  prefillTps: number;
  prefillTokens: number;
  totalMs: number;
  error: string | null;
  /** Exact prompt used for this stream (debug). */
  prompt?: string | null;
  /** Compact HTTP/SSE trace (no full completion body). */
  http?: {
    url: string | null;
    status: number | null;
    headers: Record<string, string>;
    completionId: string | null;
    finishReason: string | null;
    sseEventCount: number;
    firstSseDataPreview: string | null;
    request: {
      model: string | null;
      maxTokens: number | null;
      temperature: number;
      stream: boolean;
      promptChars: number;
    };
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contentPreview?: {
    first: string;
    last: string;
    chars: number;
  } | null;
  decodeMs?: number | null;
}

/** One concurrency wave (all streams at that concurrency). */
export interface DecodeBenchLevelResult {
  concurrency: number;
  streamsOk: number;
  streamsFailed: number;
  /** Mean per-stream decode tok/s after first token */
  meanDecodeTps: number;
  medianDecodeTps: number;
  minDecodeTps: number;
  maxDecodeTps: number;
  meanTtftMs: number;
  medianTtftMs: number;
  /** Client: total post-first-token tokens / concurrent decode window */
  aggregateDecodeTps: number;
  meanPrefillTps: number;
  medianPrefillTps: number;
  /** Sum prompt tokens / concurrent TTFT window (min start → max first token) */
  aggregatePrefillTps: number;
  totalPrefillTokens: number;
  totalDecodeTokens: number;
  totalCompletionTokens: number;
  durationMs: number;
  error: string | null;
  streams: DecodeBenchStreamResult[];
  model: string | null;
  /** ~1 Hz GPU/VRAM/power samples during the wave (debug). */
  hardwareSamples?: Array<{
    t: number;
    gpuUsage: number | null;
    temperature: number | null;
    powerDraw: number | null;
    powerLimit?: number | null;
    vramUsed: number | null;
    vramTotal: number | null;
    vramAvailable?: number | null;
    memAvailable?: number | null;
  }>;
}

export interface DecodeBenchProgress {
  currentConcurrency: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface DecodeBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: DecodeBenchConfig & { debug?: boolean };
  progress: DecodeBenchProgress;
  results: DecodeBenchLevelResult[];
  error: string | null;
  durationMs: number;
}

export interface DecodeBenchDefaults {
  allowedConcurrencies: number[];
  defaultMaxTokens: number;
  minMaxTokens: number;
  maxMaxTokens: number;
  promptTypes: DecodeBenchPromptType[];
  defaultPromptType: DecodeBenchPromptType;
}

export interface DecodeBenchListResponse {
  active: DecodeBenchJob | null;
  /** Most recent finished job (optionally for a given port) */
  last: DecodeBenchJob | null;
  history: DecodeBenchJob[];
  defaults: DecodeBenchDefaults;
}

export interface StartDecodeBenchRequest {
  port?: number;
  concurrencies: number[];
  maxTokens?: number;
  modelId?: string | null;
  /** Output type: structured (default), prose, code, json. Prompt only. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote LLM host (hostname or URL). Skips this Spark's LAN/SSH path. */
  host?: string;
  tls?: boolean;
}

// ─── LLM prefill benchmark ───────────────────────────────
export interface PrefillBenchConfig {
  port: number;
  modelId: string | null;
  contextSizes: number[];
  host?: string;
  tls?: boolean;
}

export interface PrefillBenchSizeResult {
  targetTokens: number;
  promptTokens: number;
  promptChars: number;
  prefillTps: number;
  ttftMs: number;
  ttftContentMs: number | null;
  completionTokens: number;
  durationMs: number;
  model: string | null;
  error: string | null;
}

export interface PrefillBenchProgress {
  currentContext: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface PrefillBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: PrefillBenchConfig;
  progress: PrefillBenchProgress;
  results: PrefillBenchSizeResult[];
  error: string | null;
  durationMs: number;
}

export interface PrefillBenchDefaults {
  allowedContextSizes: number[];
  defaultContextSizes: number[];
  minContextSize?: number;
  maxContextSize?: number;
}

export interface PrefillBenchListResponse {
  active: PrefillBenchJob | null;
  last: PrefillBenchJob | null;
  history: PrefillBenchJob[];
  defaults: PrefillBenchDefaults;
}

export interface StartPrefillBenchRequest {
  port?: number;
  contextSizes: number[];
  modelId?: string | null;
  host?: string;
  tls?: boolean;
}

// ─── LLM Prompt Showcase ─────────────────────────────────
export type ShowcasePromptType = "structural" | "text" | "mixed";

export interface ShowcaseStartRequest {
  port: number;
  modelId?: string | null;
  maxTokens?: number;
  /** Sampling temperature (0–2). Defaults to 0.7 on the server. */
  temperature?: number;
  /** When true, enable model thinking/reasoning flags (UI defaults to off). */
  thinking?: boolean;
  /** Catalog mode used to seed prompts (structural / text / mixed). */
  promptType?: ShowcasePromptType | null;
  prompts: string[];
}

export interface ShowcaseStreamState {
  streamId: string;
  label: string;
  prompt: string;
  status: "pending" | "streaming" | "completed" | "error" | "cancelled";
  contentAppend?: string;
  content?: string;
  contentLength: number;
  reasoningAppend?: string;
  reasoning?: string;
  reasoningLength?: number;
  resetContent?: boolean;
  tokenCount: number;
  ttftMs: number | null;
  decodeTps: number;
  liveTokPerSec: number;
  peakTokPerSec?: number;
  model: string | null;
  error: string | null;
}

export interface ShowcaseSessionState {
  sessionId: string;
  sparkId: string;
  status: "running" | "completed" | "cancelled" | "error";
  rev: number;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number;
  completedAt?: number | null;
  /** Median server generation tok/s from /metrics during the run (null if unavailable). */
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  serverGenerationSamples?: number;
  totalTokens?: number;
  meanDecodeTps?: number;
  peakStreamTps?: number;
  streamCount?: number;
  streams: ShowcaseStreamState[];
  error?: string | null;
  /** True when loaded from disk history (not a live poll session). */
  fromHistory?: boolean;
}

/** List-row for finished showcase runs (no stream bodies). */
export interface ShowcaseHistorySummary {
  sessionId: string;
  sparkId: string;
  status: "completed" | "cancelled" | "error" | string;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number | null;
  completedAt?: number | null;
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  totalTokens: number;
  meanDecodeTps: number;
  peakStreamTps: number;
  streamCount: number;
  error?: string | null;
}

export interface ShowcaseListResponse {
  active: { sessionId: string; status: string } | null;
  history: ShowcaseHistorySummary[];
}

export interface ShowcaseStartResponse {
  sessionId: string;
  status: "running";
}