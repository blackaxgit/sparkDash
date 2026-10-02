import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isLlmMonitoringEnabled } from "../../api/sparkRole";
import { updateSpark, refreshSparkMetric, addLlmPort, removeLlmPort } from "../../api/client";
import { SparkHeader } from "./SparkHeader";
import { SparkActions } from "./SparkActions";
import { GpuPanel } from "./GpuPanel";
import { CpuPanel } from "./CpuPanel";
import { RamPanel } from "./RamPanel";
import { StoragePanel } from "./StoragePanel";
import { NetworkPanel } from "./NetworkPanel";
import { TailscalePanel } from "./TailscalePanel";
import { LlmPanel } from "./LlmPanel";
import { ComfyPanel } from "./ComfyPanel";
import { VideoPanel } from "./VideoPanel";
import { MemoryPanel } from "./MemoryPanel";
import { HostHealthPanel } from "./HostHealthPanel";
import { HistoryPanel } from "./HistoryPanel";
import { ChevronDownIcon, ColumnsIcon, RowsIcon } from "../ui/icons";

interface SparkPageProps {
  spark: SparkSnapshot;
  temperatureUnit: "celsius" | "fahrenheit";
  /** Show "Copy image" in the benchmark dialogs (Settings, off by default). */
  benchShareImage?: boolean;
  /** Persisted server-side, so the choice follows the user across browsers. */
  servicesLayout?: "grid" | "rows";
  onServicesLayoutChange?: (next: "grid" | "rows") => void;
  onEdit?: () => void;
}

const SECTION_OPEN_KEYS = {
  resources: "sparkdash.ui.section.resources",
  services: "sparkdash.ui.section.services",
} as const;

function readSectionOpen(key: string, fallback = true): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return true;
  } catch {
    /* private mode / blocked storage */
  }
  return fallback;
}

function writeSectionOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Clickable section title with chevron; collapses/expands the panels below. */
function SectionHeading({
  title,
  open,
  onToggle,
  style,
  actions,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  style?: CSSProperties;
  actions?: ReactNode;
}) {
  return (
    <div className="md:col-span-2 flex w-full items-center gap-2" style={style}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex flex-1 items-center gap-2 text-left font-normal leading-tight tracking-tight text-text-strong transition-colors hover:text-accent"
        style={{ fontSize: "var(--density-overview-title)" }}
      >
        <ChevronDownIcon
          className={`h-5 w-5 shrink-0 text-muted transition-transform duration-150 ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span>{title}</span>
      </button>
      {actions}
    </div>
  );
}

export function SparkPage({
  spark,
  temperatureUnit,
  benchShareImage = false,
  servicesLayout = "grid",
  onServicesLayoutChange,
  onEdit,
}: SparkPageProps) {
  const { metrics } = spark;
  const [disabledDevices, setDisabledDevices] = useState<string[]>(spark.disabledDevices || []);
  const [disabledInterfaces, setDisabledInterfaces] = useState<string[]>(
    spark.disabledInterfaces || []
  );
  const [llmPorts, setLlmPorts] = useState<number[]>(spark.llmPorts ?? [spark.llmPort ?? 8888]);
  const [storagePollDisabled, setStoragePollDisabled] = useState<boolean>(
    spark.storagePollDisabled ?? false
  );
  const [showAddPort, setShowAddPort] = useState(false);
  const [newPortDraft, setNewPortDraft] = useState("");
  const [resourcesOpen, setResourcesOpen] = useState(() =>
    readSectionOpen(SECTION_OPEN_KEYS.resources, true)
  );
  const [servicesOpen, setServicesOpen] = useState(() =>
    readSectionOpen(SECTION_OPEN_KEYS.services, true)
  );

  const toggleResources = useCallback(() => {
    setResourcesOpen((prev) => {
      const next = !prev;
      writeSectionOpen(SECTION_OPEN_KEYS.resources, next);
      return next;
    });
  }, []);

  const toggleServices = useCallback(() => {
    setServicesOpen((prev) => {
      const next = !prev;
      writeSectionOpen(SECTION_OPEN_KEYS.services, next);
      return next;
    });
  }, []);

  // Sync when spark data changes (WS push)
  useEffect(() => {
    setDisabledDevices(spark.disabledDevices || []);
  }, [spark.disabledDevices]);

  useEffect(() => {
    setDisabledInterfaces(spark.disabledInterfaces || []);
  }, [spark.disabledInterfaces]);

  useEffect(() => {
    if (spark.llmPorts) setLlmPorts(spark.llmPorts);
  }, [spark.llmPorts]);

  useEffect(() => {
    setStoragePollDisabled(spark.storagePollDisabled ?? false);
  }, [spark.storagePollDisabled]);

  const handleStoragePollModeChange = useCallback(
    async (disabled: boolean) => {
      setStoragePollDisabled(disabled);
      try {
        await updateSpark(spark.id, { storagePollDisabled: disabled });
        // When disabling auto-refresh, do one manual refresh immediately
        if (disabled) {
          refreshSparkMetric(spark.id, "storage").catch((err) =>
            console.error("Failed to refresh storage after disabling auto-refresh:", err)
          );
        }
      } catch (err) {
        console.error("Failed to update storage poll mode:", err);
        setStoragePollDisabled(!disabled); // revert
      }
    },
    [spark.id]
  );

  const handleAddPort = useCallback(async () => {
    const port = parseInt(newPortDraft, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (llmPorts.includes(port)) {
      setNewPortDraft("");
      setShowAddPort(false);
      return;
    }
    try {
      const result = await addLlmPort(spark.id, port);
      setLlmPorts(result.llmPorts);
      setNewPortDraft("");
      setShowAddPort(false);
    } catch (err) {
      console.error("Failed to add LLM port:", err);
    }
  }, [spark.id, newPortDraft, llmPorts]);

  const handleRemovePort = useCallback(async (port: number) => {
    try {
      const result = await removeLlmPort(spark.id, port);
      setLlmPorts(result.llmPorts);
    } catch (err) {
      console.error("Failed to remove LLM port:", err);
    }
  }, [spark.id]);

  const llmOn = isLlmMonitoringEnabled(spark);
  const comfyOn = Boolean(spark.comfyMonitoring);
  const tailscaleOn = Boolean(spark.tailscaleMonitoring);
  const videoOn = Boolean(metrics.video?.available);
  const showServices = llmOn || comfyOn || videoOn;
  const primaryPort = llmPorts[0];
  const extraPorts = llmPorts.slice(1);

  /**
   * Service cards flow through a 2-column grid in render order: every LLM port,
   * then ComfyUI. They pair up half-and-half; only a trailing odd card spans
   * both columns so it doesn't sit alone at half width.
   */
  const serviceCardCount = (llmOn ? llmPorts.length : 0) + (comfyOn ? 1 : 0) + (videoOn ? 1 : 0);
  const spansFullWidth = (index: number) =>
    servicesLayout === "rows" ||
    (serviceCardCount % 2 === 1 && index === serviceCardCount - 1);
  const comfyCardIndex = llmOn ? llmPorts.length : 0;
  const videoCardIndex = comfyCardIndex + (comfyOn ? 1 : 0);

  /** Both layouts look identical with a single card, so only offer the choice above one. */
  const servicesLayoutToggle =
    serviceCardCount > 1 && onServicesLayoutChange ? (
      <div className="flex items-center gap-0.5" role="group" aria-label="Services layout">
        {([
          ["grid", ColumnsIcon, "Side-by-side"],
          ["rows", RowsIcon, "Stacked rows"],
        ] as const).map(([mode, Icon, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => onServicesLayoutChange(mode)}
            aria-pressed={servicesLayout === mode}
            aria-label={label}
            title={label}
            className={`rounded p-1 transition-colors ${
              servicesLayout === mode
                ? "text-accent"
                : "text-muted hover:text-text-strong"
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    ) : null;

  const renderLlmPanel = (port: number, portIndex: number, className?: string) => {
    const llmMetrics = metrics.llm?.[portIndex] ?? null;
    const canRemove = portIndex > 0;
    return (
      <LlmPanel
        key={port}
        llm={llmMetrics}
        sparkId={spark.id}
        sparkName={spark.name}
        llmPort={port}
        llmPorts={llmPorts}
        hasApiKey={Boolean(spark.llmApiKeyPorts?.includes(port))}
        shareImage={benchShareImage}
        onRemovePort={canRemove ? handleRemovePort : undefined}
        className={className}
        llmWait={metrics.video?.llmWait ?? null}
      />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <SparkHeader spark={spark} onEdit={onEdit} />
      {/* Mobile-only action row (Update Hermes / Shutdown·Wake / Edit) — desktop keeps them in the header. */}
      <SparkActions
        spark={spark}
        onEdit={onEdit}
        className="flex flex-wrap items-center justify-end gap-2 px-1 py-1 sm:hidden"
      />
      <div className="spark-page grid grid-cols-1 md:grid-cols-2" style={{ gap: "var(--density-page-gap)" }}>
        <SectionHeading
          title="Resources"
          open={resourcesOpen}
          onToggle={toggleResources}
          style={{ marginTop: "var(--density-page-gap)" }}
        />
        {resourcesOpen && (
          /* Two independent columns so panels take natural heights (no row-stretch
             dead space). Left: GPU + CPU stacked (CPU sits directly under GPU).
             Right: the rest, stacked independently. */
          <div
            className="md:col-span-2 grid grid-cols-1 md:grid-cols-2"
            style={{ gap: "var(--density-page-gap)" }}
          >
            <div className="flex flex-col" style={{ gap: "var(--density-page-gap)" }}>
              <GpuPanel
                gpu={metrics.gpu}
                sparkId={spark.id}
                temperatureUnit={temperatureUnit}
              />
              {spark.kind !== "host" && (
                <MemoryPanel
                  sparkId={spark.id}
                  memory={metrics.unifiedMemory}
                  hostHealth={metrics.hostHealth}
                />
              )}
              {/* grow: fill the gap so the left column's bottom aligns with the right */}
              <CpuPanel
                cpu={metrics.cpu}
                hardware={spark.hardware}
                sparkId={spark.id}
                temperatureUnit={temperatureUnit}
                className="grow"
              />
            </div>
            <div className="flex flex-col" style={{ gap: "var(--density-page-gap)" }}>
              {spark.kind === "host" && <RamPanel ram={metrics.ram} sparkId={spark.id} />}
              <StoragePanel
                storage={metrics.storage}
                sparkId={spark.id}
                disabledDevices={disabledDevices}
                onDisabledChange={setDisabledDevices}
                storagePollDisabled={storagePollDisabled}
                onStoragePollModeChange={handleStoragePollModeChange}
              />
              <HostHealthPanel health={metrics.hostHealth} />
              {/* grow: the right column's bottom panel fills the gap (Network, or
                  Tailnet when it's the last one) so both columns end at the same height */}
              <NetworkPanel
                network={metrics.network}
                sparkId={spark.id}
                disabledInterfaces={disabledInterfaces}
                onDisabledChange={setDisabledInterfaces}
                wifi={metrics.hostHealth?.wifi}
                className={tailscaleOn ? undefined : "grow"}
              />
              {tailscaleOn && (
                <TailscalePanel tailscale={metrics.tailscale ?? null} className="grow" />
              )}
            </div>
          </div>
        )}
        {resourcesOpen && (
          <div className="md:col-span-2">
            <HistoryPanel
              sparkId={spark.id}
              llmPorts={llmOn ? llmPorts : []}
              temperatureUnit={temperatureUnit}
            />
          </div>
        )}
        {/*
          Services layout: LLM ports then ComfyUI, filling a 2-column grid
          50/50; a trailing odd card spans the full width.
        */}
        {showServices && (
          <SectionHeading
            title="Services"
            open={servicesOpen}
            onToggle={toggleServices}
            style={{ marginTop: "var(--density-page-gap)" }}
            actions={servicesLayoutToggle}
          />
        )}
        {showServices && servicesOpen && (
          <>
            {llmOn &&
              primaryPort != null &&
              renderLlmPanel(
                primaryPort,
                0,
                spansFullWidth(0) ? "md:col-span-2" : undefined
              )}
            {comfyOn && (
              <ComfyPanel
                comfy={metrics.comfy ?? null}
                comfyPort={spark.comfyPort ?? 8188}
                sparkId={spark.id}
                lanIp={spark.lanIp}
                className={spansFullWidth(comfyCardIndex) ? "md:col-span-2" : undefined}
              />
            )}
            {llmOn &&
              extraPorts.map((port, j) =>
                renderLlmPanel(
                  port,
                  j + 1,
                  spansFullWidth(j + 1) ? "md:col-span-2" : undefined
                )
              )}
            {videoOn && metrics.video && (
              <VideoPanel
                video={metrics.video}
                sparkId={spark.id}
                className={spansFullWidth(videoCardIndex) ? "md:col-span-2" : undefined}
              />
            )}
            {llmOn &&
              (showAddPort ? (
                <div className="md:col-span-2 rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      inputMode="numeric"
                      placeholder="Port number"
                      value={newPortDraft}
                      onChange={(e) => setNewPortDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleAddPort();
                        }
                      }}
                      className="w-32 rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddPort()}
                      disabled={!newPortDraft.trim()}
                      className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddPort(false);
                        setNewPortDraft("");
                      }}
                      className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAddPort(true)}
                  className="md:col-span-2 rounded-lg border border-dashed border-border bg-transparent p-3 text-xs text-muted hover:border-accent hover:text-accent transition-colors"
                >
                  + Add LLM port
                </button>
              ))}
          </>
        )}
      </div>
    </div>
  );
}