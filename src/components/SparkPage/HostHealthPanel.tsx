import type { HostHealthMetrics, PsiStat } from "../../api/types";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";

interface HostHealthPanelProps {
  health: HostHealthMetrics | null | undefined;
  className?: string;
}

const LEVEL_STYLE: Record<HostHealthMetrics["level"], { label: string; cls: string }> = {
  ok: { label: "OK", cls: "border-success/40 text-success" },
  warn: { label: "WARN", cls: "border-warning/50 text-warning" },
  crit: { label: "CRIT", cls: "border-danger/50 text-danger" },
};

const pct = (v: number | null | undefined) => (v == null ? "–" : `${v.toFixed(1)}%`);
const dash = (v: number | null | undefined, suffix = "") => (v == null ? "–" : `${v}${suffix}`);

function psiText(label: string, s: PsiStat | null, withFull: boolean) {
  if (!s) return `${label} –`;
  return withFull && s.fullAvg60 != null
    ? `${label} ${pct(s.someAvg60)} (full ${pct(s.fullAvg60)})`
    : `${label} ${pct(s.someAvg60)}`;
}

/**
 * Host health for one unit: pressure, storage wear, PCIe/GPU kernel errors,
 * failed units and container state. Renders nothing until the first poll.
 */
export function HostHealthPanel({ health, className }: HostHealthPanelProps) {
  if (!health) return null;
  const level = LEVEL_STYLE[health.level];

  if (!health.available) {
    return (
      <Panel title="Host health" icon={<ActivityIcon />} className={className}>
        <p className="text-xs text-muted">{health.error ?? "Host health unavailable"}</p>
      </Panel>
    );
  }

  const { psi, nvme, pcieAer, swap, load } = health;
  const running = health.containers.filter((c) => c.state === "running");
  const stopped = health.containers.length - running.length;
  const restarting = health.containers.filter((c) => c.state === "restarting" || c.state === "dead");
  const swapPct = swap && swap.totalMb > 0 ? Math.round((swap.usedMb / swap.totalMb) * 100) : null;

  return (
    <Panel title="Host health" accent={health.level !== "ok"} icon={<ActivityIcon />} className={className}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded border px-2 py-0.5 font-medium ${level.cls}`}>{level.label}</span>
        {health.reasons.map((r) => (
          <span key={r} className="text-text">{r}</span>
        ))}
      </div>

      <div className="space-y-2">
        <Row label="Pressure (avg60)">
          <span className="font-tabular">
            {psiText("cpu", psi.cpu, false)} · {psiText("mem", psi.memory, true)} · {psiText("io", psi.io, true)}
          </span>
        </Row>
        <Row label="Load / swap">
          <span className="font-tabular">
            {load ? load.map((n) => n.toFixed(2)).join(" ") : "–"}
            {" · swap "}
            {swap ? `${swap.usedMb} / ${swap.totalMb} MB${swapPct != null ? ` (${swapPct}%)` : ""}` : "–"}
          </span>
        </Row>
        <Row label="NVMe">
          {nvme ? (
            <span className="font-tabular">
              {dash(nvme.tempC, "°C")} · wear {dash(nvme.percentUsed, "%")} · {dash(nvme.writtenTB, " TB")} written ·{" "}
              {dash(nvme.unsafeShutdowns)} unsafe shutdowns ·{" "}
              <span className={nvme.mediaErrors ? "text-danger" : undefined}>{dash(nvme.mediaErrors)} media errors</span>
            </span>
          ) : (
            <span className="text-muted">n/a</span>
          )}
        </Row>
        <Row label="PCIe AER">
          {pcieAer ? (
            <span className="font-tabular">
              corr {pcieAer.correctable} ·{" "}
              <span className={pcieAer.nonFatal ? "text-warning" : undefined}>non-fatal {pcieAer.nonFatal}</span> ·{" "}
              <span className={pcieAer.fatal ? "text-danger" : undefined}>fatal {pcieAer.fatal}</span>
            </span>
          ) : (
            <span className="text-muted">n/a</span>
          )}
        </Row>
        <Row label="GPU Xid 24h">
          {health.xid24h == null ? (
            <span className="text-muted">n/a</span>
          ) : (
            <span
              className={`font-tabular ${health.xid24h > 0 ? "text-warning" : ""}`}
              title={health.lastXid ?? undefined}
            >
              {health.xid24h}
            </span>
          )}
        </Row>
        <Row label="Failed units">
          {health.failedUnits.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <span className="truncate text-warning" title={health.failedUnits.join(", ")}>
              {health.failedUnits.join(", ")}
            </span>
          )}
        </Row>
        <Row label="Containers">
          {health.containers.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <span className="min-w-0 truncate font-tabular">
              {running.length}/{health.containers.length} running
              {running.length > 0 && <> · {running.map((c) => c.name).join(", ")}</>}
              {stopped > 0 && <span className="text-muted"> · {stopped} stopped</span>}
              {restarting.length > 0 && (
                <span className="text-warning"> · {restarting.map((c) => `${c.name} (${c.state})`).join(", ")}</span>
              )}
            </span>
          )}
        </Row>
      </div>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-text">{children}</span>
    </div>
  );
}
