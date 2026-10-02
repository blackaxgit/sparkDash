import { useEffect, useState } from "react";
import { fetchHistory } from "../../api/client";
import type { HistoryRange, HistoryResponse } from "../../api/types";
import { formatBytesPerSec } from "../../shared/formatBytes";
import { Panel } from "../ui/Panel";
import { TrendChart, type TrendSeries } from "../ui/TrendChart";

const RANGES: HistoryRange[] = ["1h", "24h", "7d"];
const REFRESH_MS = 60_000;
const LLM_COLORS = [
  "var(--color-accent)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-danger)",
];

function ChartBlock({
  title,
  series,
  ...chart
}: { title: string; series: TrendSeries[] } & Omit<Parameters<typeof TrendChart>[0], "series">) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-wide text-muted">
        <span>{title}</span>
        {series.length > 1 &&
          series.map((s) => (
            <span key={s.label} className="flex items-center gap-1 normal-case">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: s.color }}
              />
              {s.label}
            </span>
          ))}
      </div>
      <TrendChart series={series} {...chart} />
    </div>
  );
}

/** Long-term (1h / 24h / 7d) trend charts for one Spark, fed by GET /api/sparks/:id/history. */
export function HistoryPanel({ sparkId, llmPorts }: { sparkId: string; llmPorts: number[] }) {
  const [range, setRange] = useState<HistoryRange>("24h");
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    const load = () => {
      fetchHistory(sparkId, range)
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load history");
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sparkId, range]);

  const pts = (key: string) => data?.series[key] ?? [];
  const one = (key: string, color: string, label: string): TrendSeries[] => [
    { points: pts(key), color, label },
  ];
  const llmSeries: TrendSeries[] = llmPorts
    .filter((port) => data?.series[`llm:${port}.tps`])
    .map((port, i) => ({
      points: pts(`llm:${port}.tps`),
      color: LLM_COLORS[i % LLM_COLORS.length],
      label: `:${port}`,
    }));

  const tabs = (
    <div className="flex items-center gap-1" role="tablist" aria-label="History range">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={range === r}
          onClick={() => setRange(r)}
          className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
            range === r
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-surface-hover hover:text-text"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );

  return (
    <Panel title="History" actions={tabs}>
      {error && <p className="mb-2 text-[11px] text-muted">History unavailable: {error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <ChartBlock
          title="GPU usage"
          series={one("gpu.usage", "var(--color-accent)", "GPU")}
          unit="%"
          min={0}
          max={100}
        />
        <ChartBlock
          title="GPU temp"
          series={one("gpu.temp", "var(--color-warning)", "Temp")}
          unit="°C"
        />
        <ChartBlock
          title="GPU power"
          series={one("gpu.power", "var(--color-success)", "Power")}
          unit="W"
          min={0}
        />
        <ChartBlock
          title="Memory"
          series={one("mem.percentage", "var(--color-accent)", "Memory")}
          unit="%"
          min={0}
          max={100}
        />
        <ChartBlock
          title="CPU"
          series={one("cpu.usage", "var(--color-accent)", "CPU")}
          unit="%"
          min={0}
          max={100}
        />
        <ChartBlock
          title="Network"
          series={[
            { points: pts("net.rx"), color: "var(--color-success)", label: "rx" },
            { points: pts("net.tx"), color: "var(--color-accent)", label: "tx" },
          ]}
          format={(v) => formatBytesPerSec(Math.round(v))}
          min={0}
        />
        {llmPorts.length > 0 && (
          <ChartBlock title="LLM tok/s" series={llmSeries} unit=" tok/s" min={0} />
        )}
      </div>
    </Panel>
  );
}
