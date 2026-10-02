import type { GpuDevice, GpuMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { formatMb } from "../../shared/formatBytes";

interface GpuPanelProps {
  gpu: GpuMetrics | null;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
  className?: string;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

/** "NVIDIA GeForce RTX 5080" → "RTX 5080" for the per-card rows. */
function shortGpuName(name: string | null): string {
  if (!name) return "";
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "");
}

function throttleChip(reason: string | undefined): { label: string; className: string } {
  const r = reason ?? "ok";
  const label = r === "thermal" ? "Thermal" : r === "power" ? "Power" : r === "hw" ? "HW" : "OK";
  const className =
    r === "thermal"
      ? "border-danger/40 bg-danger/15 text-danger"
      : r === "power" || r === "hw"
        ? "border-warning/40 bg-warning/15 text-warning"
        : "border-border bg-surface-elevated text-muted";
  return { label, className };
}

/** Temperature DIFFERENCE: scale by 9/5 only, no +32 offset. */
function formatHeadroom(c: number, unit: "celsius" | "fahrenheit"): string {
  return unit === "fahrenheit" ? `${Math.round((c * 9) / 5)}°F` : `${Math.round(c)}°C`;
}

function formatZone(maxC: number, critC: number | null, unit: "celsius" | "fahrenheit"): string {
  const conv = (c: number) => (unit === "fahrenheit" ? celsiusToFahrenheit(c) : Math.round(c));
  const suffix = unit === "fahrenheit" ? "°F" : "°C";
  return critC != null ? `${conv(maxC)} / ${conv(critC)}${suffix}` : `${conv(maxC)}${suffix}`;
}

/** Cumulative clock-event counter (microseconds) as s / min / h. */
function formatMicros(us: number): string {
  const s = us / 1_000_000;
  if (s < 60) return `${Math.round(s)} s`;
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (s < 3600) return `${trim(s / 60)} min`;
  return `${trim(s / 3600)} h`;
}

function MetricRow({
  label,
  spark,
  value,
  color = "var(--color-accent)",
}: {
  label: string;
  spark: React.ReactNode;
  value: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <div className="flex items-center gap-3">
        <span style={{ color }}>{spark}</span>
        <span className="font-tabular text-sm font-semibold text-text">{value}</span>
      </div>
    </div>
  );
}

function tempColorFor(celsius: number, idle = "var(--color-text)"): string {
  return celsius > 85 ? "var(--color-danger)" : celsius > 65 ? "var(--color-warning)" : idle;
}

/** One physical GPU on a multi-card host: name, throttle chip, usage/temp sparklines, VRAM. */
function GpuDeviceRow({
  device: d,
  sparkId,
  temperatureUnit,
}: {
  device: GpuDevice;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
}) {
  const usageHistory = useMetricsHistoryTail(sparkId, `gpu.${d.index}.usage`);
  const tempHistory = useMetricsHistoryTail(sparkId, `gpu.${d.index}.temp`);
  const temp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(d.temperature) : d.temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${temp}°F` : `${temp}°C`;
  const tempColor = tempColorFor(d.temperature, "var(--color-accent)");
  const chip = throttleChip(d.throttle?.reason);
  const short = shortGpuName(d.name);
  return (
    <div className="space-y-1.5" title={d.throttle?.detail ?? undefined}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-text" title={d.name ?? undefined}>
          GPU {d.index}
          {short ? ` · ${short}` : ""}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip.className}`}
        >
          {chip.label}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">Usage</span>
        <div className="flex items-center gap-2">
          <Sparkline data={usageHistory} color="var(--color-accent)" width={84} height={16} unit="%" />
          <span className="font-tabular text-text">{d.usage}%</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">Temperature</span>
        <div className="flex items-center gap-2">
          <Sparkline data={tempHistory} color={tempColor} width={84} height={16} unit="°C" />
          <span className="font-tabular" style={{ color: tempColor }}>{tempLabel}</span>
        </div>
      </div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted">Power</span>
        <span className="font-tabular text-text">
          {d.power.draw}W / {d.power.limit}W
        </span>
      </div>
      {d.vram.total > 0 ? (
        <MetricBar
          label="VRAM"
          value={d.vram.used}
          max={d.vram.total}
          caption={`${formatMb(d.vram.used).replace(/ (GB|MB)$/, "")} / ${formatMb(d.vram.total)}`}
        />
      ) : (
        <div className="flex justify-between text-xs">
          <span className="text-muted">VRAM</span>
          <span className="font-tabular text-text">
            {d.vram.used > 0 ? `${formatMb(d.vram.used)} used` : "—"}
          </span>
        </div>
      )}
    </div>
  );
}

export function GpuPanel({ gpu, sparkId, temperatureUnit, className }: GpuPanelProps) {
  const tempHistory = useMetricsHistoryTail(sparkId, "gpu.temp");
  const usageHistory = useMetricsHistoryTail(sparkId, "gpu.usage");

  const temperature = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(temperature) : temperature;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  const usage = gpu?.usage ?? 0;
  const powerDraw = gpu?.power?.draw ?? 0;
  const powerLimit = gpu?.power?.limit ?? 0;

  const vramUsed = gpu?.vram?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? 0;
  const vramPct = gpu?.vram?.percentage ?? 0;
  const devices = gpu?.gpus ?? [];
  const multiGpu = devices.length > 1;
  /** No data yet, or the server marked the collection failed: the numbers are placeholder zeros. */
  const unavailable = !gpu || gpu.collected === false;

  const tempColor =
    temperature > 85
      ? "var(--color-danger)"
      : temperature > 65
        ? "var(--color-warning)"
        : "var(--color-accent)";

  const thermal = gpu?.thermal;
  const tlimitC = thermal?.tlimitC ?? null;
  const headroomClass =
    thermal?.level === "crit"
      ? "text-danger"
      : (tlimitC != null && tlimitC <= 2) || thermal?.level === "warn"
        ? "text-warning"
        : "text-muted";
  const slowdownParts: { label: string; us: number; recent: boolean }[] = [];
  if (thermal?.hwSlowdownUs != null) {
    slowdownParts.push({ label: "HW", us: thermal.hwSlowdownUs, recent: thermal.hwSlowdownRecent });
  }
  if (thermal?.swSlowdownUs != null) {
    slowdownParts.push({ label: "SW", us: thermal.swSlowdownUs, recent: thermal.swSlowdownRecent });
  }
  if (thermal?.powerCapUs != null) {
    slowdownParts.push({ label: "power-cap", us: thermal.powerCapUs, recent: false });
  }

  return (
    <Panel
      title="GPU"
      accent
      icon={<ActivityIcon />}
      className={`panel-gpu ${className ?? ""}`}
      bodyClassName="space-y-3"
    >
      {thermal && (thermal.level === "warn" || thermal.level === "crit") && (
        <div
          role="alert"
          className={`rounded border px-3 py-2 text-xs font-medium ${
            thermal.level === "crit"
              ? "border-danger/40 bg-danger/15 text-danger"
              : "border-warning/40 bg-warning/15 text-warning"
          }`}
        >
          <div className="uppercase tracking-wide">
            {thermal.level === "crit" ? "Thermal critical" : "Thermal warning"}
          </div>
          {(thermal.reasons?.length ?? 0) > 0 && (
            <ul className="mt-0.5 list-disc pl-4 font-normal">
              {thermal.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <MetricRow
        label="Usage"
        color="var(--color-accent)"
        spark={<Sparkline data={usageHistory} color="var(--color-accent)" width={180} unit="%" />}
        value={<span className="text-text-strong">{unavailable ? "—" : `${usage}%`}</span>}
      />
      <MetricRow
        label="Temperature"
        color={tempColor}
        spark={<Sparkline data={tempHistory} color={tempColor} width={180} unit="°C" />}
        value={<span className="text-text-strong">{unavailable ? "—" : tempLabel}</span>}
      />
      {thermal && thermal.level !== "unknown" && (
        <div className="space-y-1 border-t border-border pt-3">
          {tlimitC != null && (
            <div className="flex justify-between text-sm">
              <span className="text-muted">T.Limit headroom</span>
              <span className={`font-tabular text-sm font-semibold ${headroomClass}`}>
                {formatHeadroom(tlimitC, temperatureUnit)}
              </span>
            </div>
          )}
          {thermal.zoneMaxC != null && (
            <div className="flex justify-between text-sm">
              <span className="text-muted">Hottest zone</span>
              <span className="font-tabular text-sm text-text">
                {formatZone(thermal.zoneMaxC, thermal.zoneCritC, temperatureUnit)}
              </span>
            </div>
          )}
          {slowdownParts.length > 0 && (
            <div className="text-xs text-muted">
              Slowdown since boot:{" "}
              {slowdownParts.map((part, i) => (
                <span key={part.label}>
                  {i > 0 && " · "}
                  <span className={`font-tabular ${part.recent ? "font-semibold text-warning" : "text-text"}`}>
                    {part.label} {formatMicros(part.us)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex justify-between text-sm">
        <span className="text-muted">{multiGpu ? "GPU Power (all cards)" : "GPU Power"}</span>
        <span className="font-tabular text-sm text-text">
          {unavailable ? "—" : `${powerDraw}W / ${powerLimit}W`}
        </span>
      </div>

      {/* NVIDIA throttle / thermal slowdown + SM clock headroom */}
      {(() => {
        const t = gpu?.throttle;
        const reason = t?.reason ?? "ok";
        const chipLabel =
          reason === "thermal"
            ? "Thermal"
            : reason === "power"
              ? "Power"
              : reason === "hw"
                ? "HW"
                : "OK";
        const chipClass =
          reason === "thermal"
            ? "border-danger/40 bg-danger/15 text-danger"
            : reason === "power" || reason === "hw"
              ? "border-warning/40 bg-warning/15 text-warning"
              : "border-border bg-surface-elevated text-muted";
        const barColor =
          reason === "thermal"
            ? "bg-danger"
            : reason === "power" || reason === "hw"
              ? "bg-warning"
              : "bg-accent";
        const pct = t?.smClockPct;
        const clockCaption =
          t?.smClockMHz != null && t?.smClockMaxMHz != null
            ? `${t.smClockMHz} / ${t.smClockMaxMHz} MHz`
            : pct != null
              ? `${pct}%`
              : "—";
        return (
          <div className="space-y-1.5" title={t?.detail ?? undefined}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted">Throttle</span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chipClass}`}
              >
                {chipLabel}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted">SM clock</span>
              <span className="font-tabular text-xs text-text">{clockCaption}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ease-out ${barColor}`}
                style={{
                  width: `${pct != null ? Math.min(100, Math.max(0, pct)) : 0}%`,
                }}
              />
            </div>
          </div>
        );
      })()}

      {/* Per-card breakdown — only when the host has more than one GPU */}
      {multiGpu && (
        <div className="space-y-3 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">
            {devices.length} GPUs
          </div>
          {devices.map((d) => (
            <GpuDeviceRow
              key={d.uuid ?? d.index}
              device={d}
              sparkId={sparkId}
              temperatureUnit={temperatureUnit}
            />
          ))}
        </div>
      )}

      {/* GPU-allocated memory (portion of the unified pool held by GPU compute apps) */}
      {gpu && (
        <div className="space-y-2 border-t border-border pt-3">
          {!unavailable && vramTotal > 0 ? (
            <>
              <MetricBar
                label={multiGpu ? "VRAM (all cards)" : "VRAM"}
                value={vramUsed}
                max={vramTotal}
                caption={vramTotal > 0 ? `${formatMb(vramUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(vramTotal)}` : "—"}
              />
              {gpu.vram.available > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted">Available</span>
                  <span className="font-tabular text-text">{formatMb(gpu.vram.available)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex justify-between text-xs">
              <span className="text-muted">VRAM</span>
              <span className="font-tabular text-text">
                {!unavailable && vramUsed > 0 ? `${formatMb(vramUsed)} used` : "—"}
              </span>
            </div>
          )}
        </div>
      )}

      {(gpu?.nvErrNoMemory ?? 0) > 0 && (
        <div
          className="flex items-center justify-between text-sm"
          title="NVRM kernel NV_ERR_NO_MEMORY lines since boot (journal). GPU memory allocation failures under pressure."
        >
          <span className="text-muted">NV_ERR_NO_MEMORY</span>
          <span className="font-tabular text-sm font-semibold text-danger">
            {gpu?.nvErrNoMemory}
          </span>
        </div>
      )}

      {/* Top GPU processes by VRAM usage */}
      {gpu && gpu.processes && gpu.processes.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Processes</div>
          {gpu.processes.map((proc) => (
            <div key={proc.pid} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="min-w-0 truncate text-text" title={`${proc.name} (PID ${proc.pid})`}>
                  {proc.name}
                </span>
                <span className="shrink-0 font-tabular text-[10px] text-muted">
                  {proc.pid}
                </span>
              </div>
              <span className="shrink-0 font-tabular text-text">
                {formatMb(proc.vramMB)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}