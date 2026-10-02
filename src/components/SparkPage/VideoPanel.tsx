import { useCallback, useState } from "react";
import type {
  VideoActiveJob,
  VideoHourBucket,
  VideoMetrics,
  VideoModels,
  VideoOutput,
  VideoRecentJob,
} from "../../api/types";
import { Panel } from "../ui/Panel";
import { cancelVideoJob } from "../../api/client";

interface VideoPanelProps {
  video: VideoMetrics;
  sparkId: string;
  className?: string;
}

/** Bar area height in px (matches LlmHourlyChart: root font-size is 121%, so no rem utility). */
const BAR_H = 36;
const BAR_W = "82%";
const HOUR_MS = 3_600_000;
const PENDING_ROWS = 3;
const RECENT_ROWS = 8;

function VideoIcon({ className }: { className?: string }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <rect x="2" y="5" width="14" height="14" rx="2" />
      <path d="m22 8-6 4 6 4z" />
    </svg>
  );
}

/** "45s", "12m 3s", "5h 59m". */
function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const CLOCK_FMT = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false });
const HOUR_FMT = new Intl.DateTimeFormat([], { hour: "numeric" });

/** Coarser than formatDuration, for "X ago" labels. */
function formatAgo(ts: number | null | undefined, now: number): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

function clock(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "--:--";
  return CLOCK_FMT.format(ts);
}

function localHour(ts: number): string {
  return HOUR_FMT.format(ts);
}

function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

function outputPath(o: VideoOutput | undefined): string | null {
  if (!o) return null;
  return o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename;
}

const MODEL_GROUPS: Array<[keyof VideoModels, string]> = [
  ["diffusion", "Diffusion"],
  ["textEncoders", "Text encoder"],
  ["vae", "VAE"],
  ["loras", "LoRA"],
];

function ModelChips({ models }: { models: VideoModels }) {
  const groups = MODEL_GROUPS.filter(([key]) => (models[key] ?? []).length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="space-y-1">
      {groups.map(([key, label]) => (
        <div key={key} className="flex items-start gap-2">
          <span className="w-[5.5rem] shrink-0 pt-0.5 text-[10px] uppercase tracking-wide text-muted">
            {label}
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {models[key].map((m) => (
              <span
                key={m}
                className="max-w-full truncate rounded border border-border bg-surface px-1.5 py-0.5 font-tabular text-[11px] text-text"
                title={m}
              >
                {m}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EstimateBar({ percent }: { percent: number | null }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-muted">
          Progress<span className="ml-1 text-[10px] opacity-70">est.</span>
        </span>
        {percent != null ? (
          <span className="font-tabular text-text">{Math.round(percent)}%</span>
        ) : null}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label="Estimated render progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent != null ? Math.round(percent) : undefined}
      >
        {percent != null ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        ) : (
          <div
            className="h-full w-full animate-pulse rounded-full opacity-70"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, var(--color-accent) 0 6px, transparent 6px 12px)",
            }}
          />
        )}
      </div>
    </div>
  );
}

const JOB_BTN =
  "shrink-0 rounded border border-danger/40 px-1.5 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-50";

function ActiveBlock({
  job,
  onCancel,
  busy,
}: {
  job: VideoActiveJob;
  onCancel: () => void;
  busy: boolean;
}) {
  const footprint: string[] = [];
  if (job.width != null && job.height != null) footprint.push(`${job.width}×${job.height}`);
  if (job.frames != null) footprint.push(`${job.frames} frames`);
  if (job.steps != null) footprint.push(`${job.steps} steps`);
  const elapsed = formatDuration(job.elapsedMs);
  const eta =
    job.etaMs == null ? "—" : job.etaMs > 0 ? `~${formatDuration(job.etaMs)}` : "past typical";

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-elevated/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="llm-badge">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          Rendering
        </span>
        <span className="text-[11px] text-muted" title="Client id">
          {job.clientId ?? "unknown client"}
        </span>
        <span className="font-tabular text-[11px] text-muted" title={job.promptId}>
          {shortId(job.promptId)}
        </span>
        <button type="button" className={`${JOB_BTN} ml-auto`} disabled={busy} onClick={onCancel}>
          {busy ? "Cancelling…" : "Cancel"}
        </button>
      </div>
      <ModelChips models={job.models} />
      {footprint.length > 0 ? (
        <p className="font-tabular text-[11px] text-muted" title="Workflow footprint">
          {footprint.join(" · ")}
        </p>
      ) : null}
      <EstimateBar percent={job.percent} />
      <div className="flex items-baseline justify-between gap-2 font-tabular text-[11px] text-muted">
        <span>elapsed {elapsed ?? "—"}</span>
        <span title="Estimated from the median duration of recent successful renders">
          ETA {eta}
        </span>
      </div>
    </div>
  );
}

function HourlyChart({ hourly }: { hourly: VideoHourBucket[] }) {
  const renders = hourly.reduce((s, h) => s + (h.renders || 0), 0);
  const busyMs = hourly.reduce((s, h) => s + (h.busyMs || 0), 0);
  const pcts = hourly.map((h) => Math.min(100, Math.max(0, ((h.busyMs || 0) / HOUR_MS) * 100)));
  const peak = Math.max(0, ...pcts);

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">GPU busy</span>
        <span className="text-[10px] text-muted">
          {renders} {renders === 1 ? "render" : "renders"} · {(busyMs / HOUR_MS).toFixed(1)} h GPU
          busy · 24h
        </span>
      </div>
      {hourly.length === 0 || renders === 0 ? (
        <p className="text-[10px] text-muted">No renders in the last 24 hours.</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`GPU busy percent per hour over the last 24 hours. ${renders} renders, peak ${Math.round(peak)}% in one hour.`}
          >
            <div className="flex items-end">
              {hourly.map((h, i) => {
                const pct = pcts[i];
                /* a busy hour should carry a mark even when it rounds to sub-pixel */
                const barPx = pct > 0 ? Math.max(1, (pct / 100) * BAR_H) : 0;
                return (
                  <div
                    key={h.hourStart}
                    className="flex min-w-0 flex-1 basis-0 flex-col items-center justify-end"
                    style={{ height: BAR_H }}
                    title={`${localHour(h.hourStart)} · ${h.renders} ${
                      h.renders === 1 ? "render" : "renders"
                    } · ${Math.round(pct)}% GPU busy`}
                  >
                    <div
                      className="bg-accent opacity-75"
                      style={{ width: BAR_W, height: barPx }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-muted">
            <span>{localHour(hourly[0].hourStart)}</span>
            <span>peak {Math.round(peak)}%/h</span>
            <span>now</span>
          </div>
        </>
      )}
    </div>
  );
}

const STATUS_DOT: Record<VideoRecentJob["status"], string> = {
  success: "bg-success",
  error: "bg-danger",
  interrupted: "bg-muted",
  unknown: "bg-muted",
};

function RecentRow({ job, maxDuration }: { job: VideoRecentJob; maxDuration: number }) {
  const first = job.outputs[0];
  const path = outputPath(first);
  const barPct =
    job.durationMs != null && maxDuration > 0
      ? Math.max(2, Math.min(100, (job.durationMs / maxDuration) * 100))
      : 0;
  const dur = formatDuration(job.durationMs);

  return (
    <li className="space-y-0.5" title={job.promptId}>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-tabular text-muted">{clock(job.endedAt)}</span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[job.status]}`}
          title={job.status}
        />
        <span className="w-14 shrink-0 font-tabular text-text">{dur ?? "—"}</span>
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
          <div
            className={`h-full rounded-full ${job.status === "error" ? "bg-danger" : "bg-accent"} opacity-75`}
            style={{ width: `${barPct}%` }}
          />
        </div>
        {first ? (
          <span className="rounded border border-border px-1 text-[9px] uppercase tracking-wide text-muted">
            {first.kind}
          </span>
        ) : null}
      </div>
      {path ? (
        <p className="truncate pl-1 font-tabular text-[11px] text-muted" title={path}>
          {path}
        </p>
      ) : null}
    </li>
  );
}

function lastActivityTs(video: VideoMetrics): number | null {
  const ended = video.recent.find((j) => j.endedAt != null)?.endedAt;
  if (ended != null) return ended;
  for (let i = video.hourly.length - 1; i >= 0; i--) {
    if (video.hourly[i].busyMs > 0 || video.hourly[i].renders > 0) {
      return video.hourly[i].hourStart + HOUR_MS;
    }
  }
  return null;
}

export function VideoPanel({ video, sparkId, className = "" }: VideoPanelProps) {
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const handleStop = useCallback(
    async (promptId: string, question: string) => {
      if (!confirm(question)) return;
      setActionError(null);
      setCancellingId(promptId);
      try {
        await cancelVideoJob(sparkId, promptId);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setCancellingId(null);
      }
    },
    [sparkId]
  );
  const now = Date.now();
  const studio = video.studio;
  const unloaded = studio?.state === "unloaded";
  const studioLabel = studio ? (studio.name ?? studio.model) : null;
  const dotClass =
    studio?.state === "ready"
      ? "bg-success"
      : studio?.state === "loading"
        ? "bg-warning animate-pulse"
        : "bg-muted";
  const wait = video.llmWait && video.llmWait.waiting > 0 ? video.llmWait : null;
  const recent = video.recent.slice(0, RECENT_ROWS);
  const maxDuration = Math.max(0, ...recent.map((j) => j.durationMs ?? 0));
  const lastEnd = video.recent.find((j) => j.endedAt != null)?.endedAt ?? null;

  const headerActions = studio ? (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className="llm-badge max-w-[14rem]"
        title={`${studio.model} · ${studio.state}${studio.description ? ` — ${studio.description}` : ""}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
        <span className="truncate">{studioLabel}</span>
      </span>
      {studio.comfyVersion ? (
        <span className="font-tabular text-[11px] text-muted" title="ComfyUI version">
          v{studio.comfyVersion}
        </span>
      ) : null}
      {studio.port != null ? (
        <span className="font-tabular text-[11px] text-muted" title="Studio port">
          :{studio.port}
        </span>
      ) : null}
    </div>
  ) : null;

  return (
    <Panel
      title="Video"
      icon={<VideoIcon />}
      className={`panel-video ${className}`}
      bodyClassName="space-y-3"
      accent
      actions={headerActions}
    >
      {!video.available ? (
        <div className="space-y-1 text-sm">
          <p className="text-muted">Not available</p>
          {video.error ? <p className="break-all text-[11px] text-muted">{video.error}</p> : null}
        </div>
      ) : (
        <>
          {wait ? (
            <div
              className="rounded border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning"
              role="status"
            >
              <p className="font-medium">
                LLM blocked · {wait.waiting} chat {wait.waiting === 1 ? "request" : "requests"}{" "}
                waiting
                {wait.oldestMs != null ? ` · oldest ${formatDuration(wait.oldestMs)}` : ""}
              </p>
              {wait.models.length > 0 ? (
                <p className="mt-0.5 break-words font-tabular text-[11px] opacity-80">
                  {wait.models.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}
          {actionError ? (
            <p className="break-words text-[11px] text-danger" role="alert">
              {actionError}
            </p>
          ) : null}

          <div className={`space-y-3 ${unloaded ? "opacity-60" : ""}`}>
            {unloaded ? (
              <p className="text-sm text-muted">
                Studio unloaded
                {formatAgo(lastActivityTs(video), now)
                  ? ` · last activity ${formatAgo(lastActivityTs(video), now)}`
                  : ""}
              </p>
            ) : video.active ? (
              <ActiveBlock
                job={video.active}
                busy={cancellingId !== null}
                onCancel={() =>
                  void handleStop(
                    video.active!.promptId,
                    "Stop this render? The frames rendered so far are lost."
                  )
                }
              />
            ) : (
              <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted">
                Idle
                {lastEnd != null ? (
                  <span className="text-[11px]">
                    {" "}
                    · last render ended {clock(lastEnd)} ({formatAgo(lastEnd, now)})
                  </span>
                ) : null}
              </div>
            )}

            {video.queuePending > 0 ? (
              <div className="space-y-1">
                <div className="text-[11px] text-muted">
                  Queue: <span className="font-tabular text-text">{video.queuePending}</span>{" "}
                  pending
                </div>
                {video.pending.slice(0, PENDING_ROWS).map((p) => (
                  <div
                    key={p.promptId}
                    className="flex items-center justify-between gap-2 text-[11px]"
                    title={p.promptId}
                  >
                    <span className="truncate text-text">{p.clientId ?? shortId(p.promptId)}</span>
                    <span className="shrink-0 font-tabular text-muted">
                      {p.queuedAt != null ? `queued ${formatAgo(p.queuedAt, now)}` : "queued"}
                    </span>
                    <button
                      type="button"
                      className={JOB_BTN}
                      disabled={cancellingId !== null}
                      onClick={() =>
                        void handleStop(p.promptId, "Remove this job from the studio queue?")
                      }
                    >
                      {cancellingId === p.promptId ? "Removing…" : "Remove"}
                    </button>
                  </div>
                ))}
                {video.queuePending > Math.min(PENDING_ROWS, video.pending.length) ? (
                  <p className="text-[11px] text-muted">
                    +{video.queuePending - Math.min(PENDING_ROWS, video.pending.length)} more
                    waiting
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="text-[11px] text-muted">Queue: empty</div>
            )}

            <HourlyChart hourly={video.hourly} />

            {recent.length > 0 ? (
              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  Recent renders
                </div>
                <ul className="space-y-1.5">
                  {recent.map((job) => (
                    <RecentRow key={job.promptId} job={job} maxDuration={maxDuration} />
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </>
      )}
    </Panel>
  );
}
