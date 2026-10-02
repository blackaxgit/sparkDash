/**
 * HostHealthProbe — one read-only host script covering the failure modes the
 * GPU/LLM collectors cannot see: kernel pressure (PSI), swap, NVMe SMART,
 * PCIe AER, GPU Xid, failed systemd units, container state and Wi-Fi link.
 *
 * Every section is independent: a missing tool (smartctl, docker, iw, ...)
 * yields null / empty for that section only, never a failed probe.
 */
import { HOST_PATHS } from "../config.js";
import { sshExec } from "./ssh.js";
import fs from "fs";
import path from "path";

const LOCAL_TIMEOUT_MS = 8000;
const REMOTE_TIMEOUT_MS = 15000;

/** Marker the xid section prints after journalctl itself succeeded. */
const JOURNAL_OK = "__JOURNAL_OK";

/**
 * One `;`-joined line (sshExec rejects on non-zero exit, so every command
 * ends in `|| true`). Sections are delimited by `---name` lines.
 */
export const HOST_HEALTH_SCRIPT = [
  "echo '---psicpu'; cat /proc/pressure/cpu 2>/dev/null || true",
  "echo '---psimem'; cat /proc/pressure/memory 2>/dev/null || true",
  "echo '---psiio'; cat /proc/pressure/io 2>/dev/null || true",
  "echo '---load'; cat /proc/loadavg 2>/dev/null || true",
  "echo '---swap'; grep -E '^Swap(Total|Free):' /proc/meminfo 2>/dev/null || true",
  "echo '---nvme'; smartctl -j -a /dev/nvme0 2>/dev/null || true",
  "echo '---aer'; ls /sys/bus/pci/devices/*/aer_dev_fatal >/dev/null 2>&1 && awk '/^TOTAL_ERR_COR/{c+=$2} /^TOTAL_ERR_NONFATAL/{n+=$2} /^TOTAL_ERR_FATAL/{f+=$2} END{print \"cor=\" c+0, \"nonfatal=\" n+0, \"fatal=\" f+0}' /sys/bus/pci/devices/*/aer_dev_correctable /sys/bus/pci/devices/*/aer_dev_nonfatal /sys/bus/pci/devices/*/aer_dev_fatal 2>/dev/null || true",
  `echo '---xid'; { journalctl -k --since -24h -q --no-pager 2>/dev/null && echo '${JOURNAL_OK}'; } | grep -E 'NVRM: Xid|^${JOURNAL_OK}$' || true`,
  "echo '---units'; systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' || true",
  "echo '---containers'; docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null || true",
  'echo \'---wifi\'; for p in /sys/class/net/*; do if [ -d "$p/wireless" ]; then n=${p##*/}; echo "IF $n"; iw dev "$n" link 2>/dev/null; fi; done; true',
].join("; ");

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Split script output into `{ name: text }` on `---name` marker lines.
 * @param {string} out
 * @returns {Record<string, string>}
 */
export function splitSections(out) {
  /** @type {Record<string, string[]>} */
  const acc = {};
  let cur = null;
  for (const line of String(out ?? "").split("\n")) {
    const m = /^---([a-z]+)\s*$/.exec(line);
    if (m) {
      cur = m[1];
      acc[cur] = [];
    } else if (cur) {
      acc[cur].push(line);
    }
  }
  /** @type {Record<string, string>} */
  const sections = {};
  for (const [k, v] of Object.entries(acc)) sections[k] = v.join("\n").trim();
  return sections;
}

/**
 * `/proc/pressure/*`: `some avg10=0.00 avg60=0.00 avg300=0.00 total=N`
 * (+ optional `full ...` line).
 * @param {string} text
 * @returns {{ someAvg10: number, someAvg60: number, fullAvg60: number | null } | null}
 */
export function parsePsi(text) {
  let some = null;
  let full = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)/.exec(line.trim());
    if (!m) continue;
    const entry = { avg10: parseFloat(m[2]), avg60: parseFloat(m[3]) };
    if (m[1] === "some") some = entry;
    else full = entry;
  }
  if (!some) return null;
  return { someAvg10: some.avg10, someAvg60: some.avg60, fullAvg60: full ? full.avg60 : null };
}

/**
 * @param {string} text `/proc/loadavg`
 * @returns {[number, number, number] | null}
 */
export function parseLoadavg(text) {
  const p = String(text ?? "").trim().split(/\s+/).slice(0, 3).map(parseFloat);
  return p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

/**
 * @param {string} text `SwapTotal:`/`SwapFree:` lines from /proc/meminfo (kB)
 * @returns {{ totalMb: number, usedMb: number } | null}
 */
export function parseSwap(text) {
  const t = /^SwapTotal:\s+(\d+)/m.exec(text ?? "");
  const f = /^SwapFree:\s+(\d+)/m.exec(text ?? "");
  if (!t || !f) return null;
  const totalKb = parseInt(t[1], 10);
  const usedKb = Math.max(0, totalKb - parseInt(f[1], 10));
  return { totalMb: Math.round(totalKb / 1024), usedMb: Math.round(usedKb / 1024) };
}

/**
 * `smartctl -j -a /dev/nvme0` JSON → NVMe health. null on empty / unparseable
 * output or JSON without an NVMe health log (smartctl absent, SATA, no perms).
 * @param {string} text
 */
export function parseSmartctl(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const log = j?.nvme_smart_health_information_log;
  if (!log || typeof log !== "object") return null;
  const units = num(log.data_units_written);
  return {
    device: "nvme0",
    tempC: num(log.temperature),
    percentUsed: num(log.percentage_used),
    writtenTB: units == null ? null : Math.round(((units * 512000) / 1e12) * 100) / 100,
    unsafeShutdowns: num(log.unsafe_shutdowns),
    mediaErrors: num(log.media_errors),
    criticalWarning: num(log.critical_warning),
    powerOnHours: num(log.power_on_hours),
  };
}

/**
 * @param {string} text `cor=N nonfatal=N fatal=N` (empty when no AER files)
 * @returns {{ correctable: number, nonFatal: number, fatal: number } | null}
 */
export function parseAer(text) {
  const m = /cor=(\d+)\s+nonfatal=(\d+)\s+fatal=(\d+)/.exec(text ?? "");
  if (!m) return null;
  return { correctable: parseInt(m[1], 10), nonFatal: parseInt(m[2], 10), fatal: parseInt(m[3], 10) };
}

/**
 * @param {string} text Xid lines plus the journalctl-succeeded marker
 * @returns {{ count: number, last: string | null } | null} null when journalctl failed
 */
export function parseXid(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim());
  if (!lines.includes(JOURNAL_OK)) return null;
  const xid = lines.filter((l) => l.includes("NVRM: Xid"));
  return { count: xid.length, last: xid.length ? xid[xid.length - 1].slice(0, 200) : null };
}

/**
 * @param {string} text one unit name per line
 * @returns {string[]}
 */
export function parseFailedUnits(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/^[●*×\s]+/, "").trim())
    .filter((l) => /^\S+\.[a-z]+$/.test(l));
}

/**
 * @param {string} text `Name|State|Status` per line
 * @returns {{ name: string, state: string, status: string }[]}
 */
export function parseContainers(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length < 2 || !parts[0]) continue;
    out.push({ name: parts[0], state: parts[1].toLowerCase(), status: parts.slice(2).join("|") });
  }
  return out;
}

/**
 * @param {string} text `IF <name>` header followed by `iw dev <name> link` output
 * @returns {{ iface: string, ssid: string | null, signalDbm: number | null, txMbps: number | null, rxMbps: number | null }[]}
 */
export function parseWifi(text) {
  const out = [];
  /** @type {{ iface: string, body: string[] } | null} */
  let cur = null;
  const blocks = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^IF\s+(\S+)/.exec(line);
    if (m) {
      cur = { iface: m[1], body: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.body.push(line);
    }
  }
  for (const { iface, body } of blocks) {
    const b = body.join("\n");
    const ssid = /^\s*SSID:\s*(.+?)\s*$/m.exec(b)?.[1] ?? null;
    const sig = /^\s*signal:\s*(-?\d+)/m.exec(b)?.[1];
    const tx = /^\s*tx bitrate:\s*([\d.]+)/m.exec(b)?.[1];
    const rx = /^\s*rx bitrate:\s*([\d.]+)/m.exec(b)?.[1];
    out.push({
      iface,
      ssid,
      signalDbm: sig != null ? parseInt(sig, 10) : null,
      txMbps: tx != null ? parseFloat(tx) : null,
      rxMbps: rx != null ? parseFloat(rx) : null,
    });
  }
  return out;
}

/**
 * Derive level + reasons (most severe first). Pure — exported for tests.
 * Exited containers are NORMAL (llama-swap stops idle model containers); only
 * `restarting` / `dead` warn. Correctable AER and unsafe shutdowns are informational.
 *
 * @param {object} h
 * @returns {{ level: "ok" | "warn" | "crit", reasons: string[] }}
 */
export function evaluateHostHealth(h) {
  const crit = [];
  const warn = [];
  const pct = (v) => `${Math.round(v * 10) / 10}%`;

  if ((h.pcieAer?.fatal ?? 0) > 0) crit.push(`PCIe AER fatal errors: ${h.pcieAer.fatal}`);
  if ((h.nvme?.mediaErrors ?? 0) > 0) crit.push(`NVMe media errors: ${h.nvme.mediaErrors}`);
  const cw = h.nvme?.criticalWarning;
  if (cw != null && cw !== 0) crit.push(`NVMe critical warning flags: 0x${cw.toString(16)}`);
  const memFull = h.psi?.memory?.fullAvg60;
  const memCrit = memFull != null && memFull >= 30;
  if (memCrit) crit.push(`Memory pressure (full) ${pct(memFull)} over 60s`);

  if ((h.xid24h ?? 0) > 0) warn.push(`GPU Xid errors in last 24h: ${h.xid24h}`);
  if (h.failedUnits?.length) warn.push(`Failed systemd units (${h.failedUnits.length}): ${h.failedUnits.join(", ")}`);
  const bad = (h.containers ?? []).filter((c) => c.state === "restarting" || c.state === "dead");
  if (bad.length) warn.push(`Containers restarting/dead: ${bad.map((c) => c.name).join(", ")}`);
  if (!memCrit && memFull != null && memFull >= 10) warn.push(`Memory pressure (full) ${pct(memFull)} over 60s`);
  const ioFull = h.psi?.io?.fullAvg60;
  if (ioFull != null && ioFull >= 30) warn.push(`I/O pressure (full) ${pct(ioFull)} over 60s`);
  if (h.swap && h.swap.totalMb > 0 && h.swap.usedMb / h.swap.totalMb > 0.5) {
    warn.push(`Swap ${Math.round((h.swap.usedMb / h.swap.totalMb) * 100)}% used`);
  }
  if (h.nvme?.tempC != null && h.nvme.tempC >= 70) warn.push(`NVMe temperature ${h.nvme.tempC}°C`);
  if (h.nvme?.percentUsed != null && h.nvme.percentUsed >= 80) warn.push(`NVMe wear ${h.nvme.percentUsed}% used`);
  if ((h.pcieAer?.nonFatal ?? 0) > 0) warn.push(`PCIe AER non-fatal errors: ${h.pcieAer.nonFatal}`);

  const reasons = [...crit, ...warn];
  return { level: crit.length ? "crit" : warn.length ? "warn" : "ok", reasons };
}

/**
 * Parse a whole script output into the HostHealthMetrics shape.
 * @param {string} out
 * @param {number} [now]
 */
export function parseHostHealth(out, now = Date.now()) {
  const s = splitSections(out);
  const xid = parseXid(s.xid);
  const fields = {
    psi: { cpu: parsePsi(s.psicpu), memory: parsePsi(s.psimem), io: parsePsi(s.psiio) },
    load: parseLoadavg(s.load),
    swap: parseSwap(s.swap),
    nvme: parseSmartctl(s.nvme),
    pcieAer: parseAer(s.aer),
    xid24h: xid ? xid.count : null,
    lastXid: xid ? xid.last : null,
    failedUnits: parseFailedUnits(s.units),
    containers: parseContainers(s.containers),
    wifi: parseWifi(s.wifi),
  };
  return { available: true, ...evaluateHostHealth(fields), ...fields, updatedAt: now };
}

export class HostHealthProbe {
  /**
   * @param {object} spark
   * @param {{ exec?: (cmd: string) => Promise<string> }} [opts] `exec` is a test seam
   */
  constructor(spark, { exec } = {}) {
    this.spark = spark;
    this._exec = exec ?? ((cmd) => this._defaultExec(cmd));
  }

  /** @param {object} spark */
  setTarget(spark) {
    this.spark = spark ?? this.spark;
  }

  dispose() {}

  _hasHostProc() {
    return fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"));
  }

  /**
   * Local Docker: enter the host mount namespace (same approach as TailscaleProbe);
   * otherwise SSH.
   * @param {string} cmd
   * @returns {Promise<string>}
   */
  async _defaultExec(cmd) {
    if (!this.spark?.isLocal) {
      return sshExec(this.spark, cmd, { timeoutMs: REMOTE_TIMEOUT_MS });
    }
    const { execFile } = await import("child_process");
    const useHostNs = this._hasHostProc();
    const file = useHostNs ? "nsenter" : "sh";
    const args = useHostNs
      ? ["--mount=" + path.join(HOST_PATHS.PROC, "1", "ns", "mnt"), "--", "sh", "-c", cmd]
      : ["-c", cmd];
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: LOCAL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || "").trim() || err.message));
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * Never throws — an exec failure yields `available: false` with `error`.
   * @returns {Promise<object>}
   */
  async probe() {
    let out;
    try {
      out = await this._exec(HOST_HEALTH_SCRIPT);
    } catch (err) {
      return {
        available: false,
        level: "ok",
        reasons: [],
        psi: { cpu: null, memory: null, io: null },
        load: null,
        swap: null,
        nvme: null,
        pcieAer: null,
        xid24h: null,
        lastXid: null,
        failedUnits: [],
        containers: [],
        wifi: [],
        updatedAt: Date.now(),
        error: err?.message || "host health probe failed",
      };
    }
    return parseHostHealth(out);
  }
}
