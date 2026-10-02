import type { HostHealthMetrics, UnifiedMemoryMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { MemoryIcon } from "../ui/icons";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface MemoryPanelProps {
  sparkId: string;
  memory: UnifiedMemoryMetrics | null;
  hostHealth?: HostHealthMetrics | null;
  className?: string;
}

/** Unified-memory values are MB; render as GiB with one decimal. */
function gib(mb: number): string {
  return `${(Math.max(0, mb) / 1024).toFixed(1)} GiB`;
}

const RISK_CHIP: Record<UnifiedMemoryMetrics["oomRisk"], string> = {
  low: "border-success/40 bg-success/15 text-success",
  medium: "border-warning/40 bg-warning/15 text-warning",
  high: "border-danger/40 bg-danger/15 text-danger",
};

/**
 * DGX Spark unified memory: CPU and GPU share one pool, so "free" is what a
 * new model can still claim. Complements the host-health memory pressure
 * (PSI) and swap, which say whether the pool is already thrashing.
 */
export function MemoryPanel({ sparkId, memory, hostHealth, className }: MemoryPanelProps) {
  const history = useMetricsHistoryTail(sparkId, "ram.percentage");
  if (!memory) return null;

  const total = memory.total;
  const gpuUsed = Math.max(0, memory.gpuUsed);
  const cpuUsed = Math.max(0, memory.cpuUsed ?? memory.used - memory.gpuUsed);
  const available = Math.max(0, memory.available);
  const pct = (mb: number) => (total > 0 ? Math.min(100, (mb / total) * 100) : 0);

  const segments = [
    { key: "gpu", label: "GPU", mb: gpuUsed, color: "var(--color-accent)" },
    { key: "cpu", label: "CPU", mb: cpuUsed, color: "var(--color-muted-strong)" },
    { key: "free", label: "Available", mb: available, color: "var(--color-border)" },
  ];

  const swap = hostHealth?.swap ?? null;
  const mem = hostHealth?.psi?.memory ?? null;
  const full = mem?.fullAvg60 ?? null;

  return (
    <Panel
      title="Memory"
      icon={<MemoryIcon />}
      className={`panel-memory ${className ?? ""}`}
      bodyClassName="space-y-3"
      actions={
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${RISK_CHIP[memory.oomRisk]}`}
          title="Out-of-memory risk"
        >
          OOM {memory.oomRisk}
        </span>
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted">Free for a new model</span>
        <span className="font-tabular text-base font-semibold text-text-strong">≈ {gib(available)}</span>
      </div>

      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full border border-border bg-surface-elevated"
        role="img"
        aria-label={`GPU ${gib(gpuUsed)}, CPU ${gib(cpuUsed)}, available ${gib(available)} of ${gib(total)}`}
      >
        {segments.map((s) => (
          <div key={s.key} style={{ width: `${pct(s.mb)}%`, background: s.color }} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {segments.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            <span className="text-muted">{s.label}</span>
            <span className="font-tabular text-text">{gib(s.mb)}</span>
          </span>
        ))}
        <span className="ml-auto font-tabular text-muted">Total {gib(total)}</span>
      </div>

      {history.length > 0 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Used %</span>
          <div className="flex items-center gap-2">
            <Sparkline
              data={history}
              color="var(--color-accent)"
              width={180}
              height={16}
              unit="%"
              ariaLabel="Unified memory used percentage history"
            />
            <span className="font-tabular text-text">{memory.percentage}%</span>
          </div>
        </div>
      )}

      {swap && (
        <div className="flex justify-between text-xs">
          <span className="text-muted">Swap</span>
          <span className="font-tabular text-text">
            {gib(swap.usedMb)} / {gib(swap.totalMb)}
          </span>
        </div>
      )}

      {mem && (
        <div className="flex justify-between text-xs">
          <span className="text-muted">Memory pressure</span>
          <span className="font-tabular text-text">
            PSI some {mem.someAvg60.toFixed(1)}% · full {full == null ? "—" : `${full.toFixed(1)}%`} (60 s)
          </span>
        </div>
      )}
    </Panel>
  );
}
