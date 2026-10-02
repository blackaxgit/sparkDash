import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HostHealthProbe,
  HOST_HEALTH_SCRIPT,
  evaluateHostHealth,
  parseAer,
  parseContainers,
  parseFailedUnits,
  parseHostHealth,
  parseLoadavg,
  parsePsi,
  parseSmartctl,
  parseSwap,
  parseWifi,
  parseXid,
  splitSections,
} from "../HostHealthProbe.js";

const SMART = JSON.stringify({
  nvme_smart_health_information_log: {
    critical_warning: 0,
    temperature: 63,
    percentage_used: 0,
    data_units_written: 6128700,
    power_on_hours: 312,
    unsafe_shutdowns: 12,
    media_errors: 0,
  },
});

const WIFI_OK = `IF wlP9s9
Connected to aa:bb:cc:dd:ee:ff (on wlP9s9)
\tSSID: Home5G
\tfreq: 5180
\tsignal: -61 dBm
\trx bitrate: 866.7 MBit/s 80MHz HE-MCS 9
\ttx bitrate: 648.5 MBit/s 80MHz HE-MCS 7`;

const FULL_OUTPUT = [
  "---psicpu",
  "some avg10=0.00 avg60=0.00 avg300=0.00 total=1363379783",
  "full avg10=0.00 avg60=0.00 avg300=0.00 total=0",
  "---psimem",
  "some avg10=0.50 avg60=1.25 avg300=0.10 total=1234",
  "full avg10=0.00 avg60=0.40 avg300=0.00 total=99",
  "---psiio",
  "some avg10=0.00 avg60=2.00 avg300=0.00 total=5",
  "full avg10=0.00 avg60=1.00 avg300=0.00 total=4",
  "---load",
  "0.52 0.48 0.40 2/1500 123456",
  "---swap",
  "SwapTotal:       16777212 kB",
  "SwapFree:        16777212 kB",
  "---nvme",
  SMART,
  "---aer",
  "cor=7 nonfatal=0 fatal=0",
  "---xid",
  "__JOURNAL_OK",
  "---units",
  "---containers",
  "llama-swap|running|Up 3 days",
  "vllm-qwen|exited|Exited (0) 2 hours ago",
  "---wifi",
  WIFI_OK,
].join("\n");

test("parsePsi reads some/full avg values", () => {
  const p = parsePsi(
    "some avg10=0.00 avg60=3.50 avg300=0.00 total=1363379783\nfull avg10=1.00 avg60=12.25 avg300=0.00 total=9"
  );
  assert.deepEqual(p, { someAvg10: 0, someAvg60: 3.5, fullAvg60: 12.25 });
});

test("parsePsi: cpu without a full line has fullAvg60 null; empty is null", () => {
  assert.equal(parsePsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=1").fullAvg60, null);
  assert.equal(parsePsi(""), null);
});

test("parseLoadavg / parseSwap", () => {
  assert.deepEqual(parseLoadavg("0.52 0.48 0.40 2/1500 123456"), [0.52, 0.48, 0.4]);
  assert.equal(parseLoadavg(""), null);
  assert.deepEqual(parseSwap("SwapTotal:  16777216 kB\nSwapFree:  8388608 kB"), { totalMb: 16384, usedMb: 8192 });
  assert.deepEqual(parseSwap("SwapTotal: 0 kB\nSwapFree: 0 kB"), { totalMb: 0, usedMb: 0 });
  assert.equal(parseSwap(""), null);
});

test("parseSmartctl maps NVMe health log; written TB from data units", () => {
  const n = parseSmartctl(SMART);
  assert.deepEqual(n, {
    device: "nvme0",
    tempC: 63,
    percentUsed: 0,
    writtenTB: 3.14,
    unsafeShutdowns: 12,
    mediaErrors: 0,
    criticalWarning: 0,
    powerOnHours: 312,
  });
});

test("parseSmartctl returns null for empty, garbage, or non-NVMe JSON", () => {
  assert.equal(parseSmartctl(""), null);
  assert.equal(parseSmartctl("smartctl: command not found"), null);
  assert.equal(parseSmartctl('{"ata_smart_attributes":{}}'), null);
});

test("parseAer / parseXid / parseFailedUnits / parseContainers", () => {
  assert.deepEqual(parseAer("cor=7 nonfatal=2 fatal=1"), { correctable: 7, nonFatal: 2, fatal: 1 });
  assert.equal(parseAer(""), null);

  const x = parseXid(
    "[Mon] NVRM: Xid (PCI:000f:01:00): 79, GPU has fallen off the bus.\n" +
      "[Tue] NVRM: Xid (PCI:000f:01:00): 13, pid=1, Graphics Exception\n__JOURNAL_OK"
  );
  assert.equal(x.count, 2);
  assert.match(x.last, /Xid .*: 13/);
  assert.deepEqual(parseXid("__JOURNAL_OK"), { count: 0, last: null });
  assert.equal(parseXid(""), null, "journalctl failure (no marker) is null, not zero");
  assert.equal(parseXid("x".repeat(50) + " NVRM: Xid " + "y".repeat(400) + "\n__JOURNAL_OK").last.length, 200);

  assert.deepEqual(parseFailedUnits("● foo.service\nbar.mount\n"), ["foo.service", "bar.mount"]);
  assert.deepEqual(parseFailedUnits(""), []);

  assert.deepEqual(parseContainers("a|running|Up 1 hour\nb|exited|Exited (0) 2h ago\ngarbage"), [
    { name: "a", state: "running", status: "Up 1 hour" },
    { name: "b", state: "exited", status: "Exited (0) 2h ago" },
  ]);
});

test("parseWifi reads link details and treats Not connected as nulls", () => {
  assert.deepEqual(parseWifi(WIFI_OK), [
    { iface: "wlP9s9", ssid: "Home5G", signalDbm: -61, txMbps: 648.5, rxMbps: 866.7 },
  ]);
  assert.deepEqual(parseWifi("IF wlan0\nNot connected."), [
    { iface: "wlan0", ssid: null, signalDbm: null, txMbps: null, rxMbps: null },
  ]);
  assert.deepEqual(parseWifi(""), []);
});

test("splitSections splits on ---name markers", () => {
  const s = splitSections("---a\none\ntwo\n---b\n---c\nthree");
  assert.deepEqual(s, { a: "one\ntwo", b: "", c: "three" });
});

test("parseHostHealth on a full healthy sample", () => {
  const h = parseHostHealth(FULL_OUTPUT, 1234);
  assert.equal(h.available, true);
  assert.equal(h.level, "ok");
  assert.deepEqual(h.reasons, []);
  assert.equal(h.psi.memory.fullAvg60, 0.4);
  assert.deepEqual(h.load, [0.52, 0.48, 0.4]);
  assert.equal(h.nvme.writtenTB, 3.14);
  assert.equal(h.nvme.unsafeShutdowns, 12, "unsafe shutdowns are informational");
  assert.deepEqual(h.pcieAer, { correctable: 7, nonFatal: 0, fatal: 0 });
  assert.equal(h.xid24h, 0);
  assert.equal(h.containers.length, 2);
  assert.equal(h.wifi[0].ssid, "Home5G");
  assert.equal(h.updatedAt, 1234);
});

const base = () => ({
  psi: { cpu: null, memory: null, io: null },
  swap: null,
  nvme: null,
  pcieAer: null,
  xid24h: 0,
  failedUnits: [],
  containers: [],
});
const lvl = (patch) => evaluateHostHealth({ ...base(), ...patch });

test("evaluateHostHealth: exited containers do not warn; restarting/dead do", () => {
  const exited = lvl({ containers: [{ name: "m", state: "exited", status: "Exited (0)" }] });
  assert.equal(exited.level, "ok");
  const restarting = lvl({ containers: [{ name: "m", state: "restarting", status: "Restarting" }] });
  assert.equal(restarting.level, "warn");
  assert.match(restarting.reasons[0], /m/);
  assert.equal(lvl({ containers: [{ name: "d", state: "dead", status: "" }] }).level, "warn");
});

test("evaluateHostHealth: memory PSI full thresholds (10 warn, 30 crit)", () => {
  const mem = (v) => lvl({ psi: { cpu: null, memory: { someAvg10: 0, someAvg60: 0, fullAvg60: v }, io: null } });
  assert.equal(mem(9.99).level, "ok");
  assert.equal(mem(10).level, "warn");
  assert.equal(mem(29.99).level, "warn");
  const crit = mem(30);
  assert.equal(crit.level, "crit");
  assert.equal(crit.reasons.length, 1, "crit memory pressure is not repeated as a warn");
});

test("evaluateHostHealth: io PSI full threshold 30 warns", () => {
  const io = (v) => lvl({ psi: { cpu: null, memory: null, io: { someAvg10: 0, someAvg60: 0, fullAvg60: v } } });
  assert.equal(io(29.9).level, "ok");
  assert.equal(io(30).level, "warn");
});

test("evaluateHostHealth: swap warns only above 50% of a non-zero total", () => {
  assert.equal(lvl({ swap: { totalMb: 1000, usedMb: 500 } }).level, "ok");
  assert.equal(lvl({ swap: { totalMb: 1000, usedMb: 501 } }).level, "warn");
  assert.equal(lvl({ swap: { totalMb: 0, usedMb: 0 } }).level, "ok");
});

test("evaluateHostHealth: NVMe thresholds", () => {
  const nvme = (p) => ({ device: "nvme0", tempC: 40, percentUsed: 0, mediaErrors: 0, criticalWarning: 0, ...p });
  assert.equal(lvl({ nvme: nvme({ tempC: 69 }) }).level, "ok");
  assert.equal(lvl({ nvme: nvme({ tempC: 70 }) }).level, "warn");
  assert.equal(lvl({ nvme: nvme({ percentUsed: 79 }) }).level, "ok");
  assert.equal(lvl({ nvme: nvme({ percentUsed: 80 }) }).level, "warn");
  assert.equal(lvl({ nvme: nvme({ mediaErrors: 1 }) }).level, "crit");
  assert.equal(lvl({ nvme: nvme({ criticalWarning: 4 }) }).level, "crit");
  assert.equal(lvl({ nvme: nvme({ criticalWarning: null, mediaErrors: null }) }).level, "ok");
});

test("evaluateHostHealth: AER, Xid and failed units", () => {
  assert.equal(lvl({ pcieAer: { correctable: 999, nonFatal: 0, fatal: 0 } }).level, "ok");
  assert.equal(lvl({ pcieAer: { correctable: 0, nonFatal: 1, fatal: 0 } }).level, "warn");
  assert.equal(lvl({ pcieAer: { correctable: 0, nonFatal: 1, fatal: 1 } }).level, "crit");
  assert.equal(lvl({ xid24h: 1 }).level, "warn");
  assert.equal(lvl({ xid24h: null }).level, "ok");
  assert.equal(lvl({ failedUnits: ["a.service"] }).level, "warn");
});

test("evaluateHostHealth: reasons list crit before warn", () => {
  const r = lvl({ xid24h: 2, pcieAer: { correctable: 0, nonFatal: 0, fatal: 3 } });
  assert.equal(r.level, "crit");
  assert.match(r.reasons[0], /AER fatal/);
  assert.match(r.reasons[1], /Xid/);
});

test("probe: a missing tool nulls only its section; probe stays available", async () => {
  const out = [
    "---psicpu",
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=1",
    "---nvme",
    "---aer",
    "---xid",
    "---containers",
    "---wifi",
  ].join("\n");
  const seen = [];
  const probe = new HostHealthProbe({ id: "s" }, { exec: async (cmd) => (seen.push(cmd), out) });
  const h = await probe.probe();
  assert.equal(seen[0], HOST_HEALTH_SCRIPT);
  assert.equal(h.available, true);
  assert.equal(h.level, "ok");
  assert.equal(h.nvme, null);
  assert.equal(h.pcieAer, null);
  assert.equal(h.xid24h, null);
  assert.equal(h.lastXid, null);
  assert.deepEqual(h.containers, []);
  assert.deepEqual(h.wifi, []);
  assert.equal(h.psi.cpu.someAvg60, 0);
  assert.equal(h.psi.memory, null);
});

test("probe: exec failure yields available:false with error, never throws", async () => {
  const probe = new HostHealthProbe({ id: "s" }, { exec: async () => { throw new Error("ssh down"); } });
  const h = await probe.probe();
  assert.equal(h.available, false);
  assert.equal(h.error, "ssh down");
  assert.equal(h.level, "ok");
  assert.deepEqual(h.failedUnits, []);
});

test("script: a hung journalctl nulls only the xid section", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hhp-bin-"));
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Stand-in for coreutils `timeout`: journalctl "times out" (124), everything else runs.
  stub("timeout", 'shift\nif [ "$1" = journalctl ]; then exit 124; fi\nexec "$@"');
  stub("smartctl", `echo '${SMART}'`);
  stub("journalctl", "echo '[Mon] NVRM: Xid (PCI:0000:01:00): 79, fallen off the bus'");
  try {
    const out = execFileSync("sh", ["-c", HOST_HEALTH_SCRIPT], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    const h = parseHostHealth(out);
    assert.equal(h.xid24h, null, "timed-out journalctl must not look like zero Xids");
    assert.equal(h.lastXid, null);
    assert.equal(h.nvme?.tempC, 63, "other sections are unaffected");
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
