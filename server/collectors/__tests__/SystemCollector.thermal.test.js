import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemCollector } from "../SystemCollector.js";
import { HOST_PATHS } from "../../config.js";

const GPU = { temperature: 61, usage: 12, throttle: { active: false } };
const ZONES = { zoneMaxC: 90, zoneCritC: 104 };

/**
 * A collector without the constructor (which resolves nvidia-smi on the host),
 * with the thermal state the constructor would set up.
 * @param {object} [spark]
 */
function collector(spark = { id: "t", isLocal: true }) {
  const c = Object.create(SystemCollector.prototype);
  c.spark = spark;
  c._thermalHistory = [];
  c._thermalCache = null;
  c._thermalSmiBackoffUntil = 0;
  c._readLocalThermalZones = () => ZONES;
  return c;
}

/** Local collector whose thermal nvidia-smi is `reply` and whose GPU query works. */
function localWith(reply) {
  const c = collector();
  const smiCalls = [];
  c._getGPUAll = async () => ({ ...GPU });
  c._nvidiaSmi = async (args) => {
    smiCalls.push(args);
    return typeof reply === "function" ? reply(smiCalls.length) : reply;
  };
  return { c, smiCalls };
}

/** Pretend `ms` of wall time passed since the cached thermal reading. */
function age(c, ms) {
  if (c._thermalCache) c._thermalCache.at -= ms;
}

test("a throwing thermal query leaves the GPU metrics intact", async () => {
  const { c } = localWith(() => {
    throw new Error("nvidia-smi: exit 2");
  });

  const gpu = await c.collectGpu();

  assert.equal(gpu.temperature, 61);
  assert.equal(gpu.usage, 12);
  assert.deepEqual(gpu.throttle, { active: false });
  assert.equal(gpu.thermal.tlimitC, null);
  assert.equal(gpu.thermal.zoneMaxC, 90, "zones still report when the smi query is down");
  assert.equal(gpu.thermal.level, "ok");
});

test("an 'invalid field' reply is treated as a failed query, not as data", async () => {
  const { c } = localWith('Field "clocks_event_reasons_counters.hw_thermal_slowdown" is not a valid field.');

  const gpu = await c.collectGpu();

  assert.equal(gpu.temperature, 61);
  assert.equal(gpu.thermal.hwSlowdownUs, null);
  assert.ok(c._thermalSmiBackoffUntil > Date.now(), "backoff armed");
});

test("a failed thermal query is not retried for 10 minutes", async () => {
  const { c, smiCalls } = localWith(() => {
    throw new Error("unsupported");
  });
  await c.collectGpu();
  assert.equal(smiCalls.length, 1);
  const wait = c._thermalSmiBackoffUntil - Date.now();
  assert.ok(wait > 9.9 * 60_000 && wait <= 10 * 60_000, `backoff ${wait} ms`);

  // Past the 10 s cache but well inside the 10 min backoff: no new spawn.
  age(c, 11_000);
  await c.collectGpu();
  age(c, 11_000);
  await c.collectGpu();
  assert.equal(smiCalls.length, 1);

  // Once the backoff has elapsed it is tried again.
  c._thermalSmiBackoffUntil = Date.now() - 1;
  age(c, 11_000);
  await c.collectGpu();
  assert.equal(smiCalls.length, 2);
});

test("the thermal query runs at most once per 10 s", async () => {
  const { c, smiCalls } = localWith("8, 0, 16257583, 22139756962");

  const first = (await c.collectGpu()).thermal;
  const second = (await c.collectGpu()).thermal;
  assert.equal(smiCalls.length, 1);
  assert.equal(second, first, "same reading served from cache");
  assert.equal(first.tlimitC, 8);
  assert.equal(first.swSlowdownUs, 16_257_583);
  assert.equal(first.powerCapUs, 22_139_756_962);

  age(c, 10_001);
  await c.collectGpu();
  assert.equal(smiCalls.length, 2);
});

test("the thermal smi query is separate from the main GPU query", async () => {
  const { c, smiCalls } = localWith("8, 0, 1, 2");
  await c.collectGpu();
  assert.equal(smiCalls.length, 1);
  assert.match(smiCalls[0], /temperature\.gpu\.tlimit/);
  assert.match(smiCalls[0], /clocks_event_reasons_counters\.hw_thermal_slowdown/);
});

test("slowdown growth between polls shows up as a recent warning", async () => {
  let sw = 1_000;
  const { c } = localWith(() => `8, 0, ${sw}, 5`);

  assert.equal((await c.collectGpu()).thermal.level, "ok");
  sw = 7_000_000; // +7 s: over the 1%-of-10-min warning threshold
  age(c, 11_000);
  const t = (await c.collectGpu()).thermal;
  assert.equal(t.swSlowdownRecent, true);
  assert.equal(t.level, "warn");
});

test("a thrown thermal collection does not take the GPU metrics with it", async () => {
  const { c } = localWith("8, 0, 1, 2");
  c._collectThermal = async () => {
    throw new Error("boom");
  };
  const gpu = await c.collectGpu();
  assert.equal(gpu.temperature, 61);
  assert.equal("thermal" in gpu, false);
});

test("local thermal zones come from sysfs: hottest zone, lowest critical trip", async () => {
  const sys = fs.mkdtempSync(path.join(os.tmpdir(), "spark-sys-"));
  const prev = HOST_PATHS.SYS;
  try {
    const write = (zone, name, value) => {
      const dir = path.join(sys, "class/thermal", zone);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), `${value}\n`);
    };
    write("thermal_zone0", "temp", 91000);
    write("thermal_zone0", "trip_point_0_type", "passive");
    write("thermal_zone0", "trip_point_0_temp", 80000);
    write("thermal_zone0", "trip_point_1_type", "critical");
    write("thermal_zone0", "trip_point_1_temp", 104000);
    write("thermal_zone1", "temp", 92000);
    write("thermal_zone1", "trip_point_0_type", "critical");
    write("thermal_zone1", "trip_point_0_temp", 100000);
    write("thermal_zone2", "temp", "garbage");
    HOST_PATHS.SYS = sys;

    const c = collector();
    delete c._readLocalThermalZones; // use the real reader
    assert.deepEqual(c._readLocalThermalZones(), { zoneMaxC: 92, zoneCritC: 100 });
  } finally {
    HOST_PATHS.SYS = prev;
    fs.rmSync(sys, { recursive: true, force: true });
  }
});

test("remote: one ssh call carries both sections and both parse", async () => {
  const c = collector({ id: "r", isLocal: false });
  const cmds = [];
  c._getRemoteGpu = async () => ({ ...GPU });
  c._remoteExec = async (cmd) => {
    cmds.push(cmd);
    return "8, 0, 16257583, 22139756962\n---\nT 91000\nC 104000\nT 92000\nC 104000";
  };

  const gpu = await c.collectGpu();

  assert.equal(cmds.length, 1);
  assert.match(cmds[0], /nvidia-smi --query-gpu=temperature\.gpu\.tlimit/);
  assert.match(cmds[0], /thermal_zone/);
  assert.equal(gpu.temperature, 61);
  assert.equal(gpu.thermal.tlimitC, 8);
  assert.equal(gpu.thermal.swSlowdownUs, 16_257_583);
  assert.equal(gpu.thermal.zoneMaxC, 92);
  assert.equal(gpu.thermal.zoneCritC, 104);
  assert.equal(gpu.thermal.level, "ok");
});

test("remote: an unsupported smi query backs off but zones keep reporting", async () => {
  const c = collector({ id: "r", isLocal: false });
  const cmds = [];
  c._getRemoteGpu = async () => ({ ...GPU });
  c._remoteExec = async (cmd) => {
    cmds.push(cmd);
    return cmds.length === 1 ? "\n---\nT 95000\nC 104000" : "true-section\n---\nT 95000\nC 104000";
  };

  const first = await c.collectGpu();
  assert.equal(first.thermal.tlimitC, null);
  assert.equal(first.thermal.zoneMaxC, 95);
  assert.ok(c._thermalSmiBackoffUntil > Date.now());

  age(c, 11_000);
  await c.collectGpu();
  assert.equal(cmds.length, 2, "zones are still polled");
  assert.doesNotMatch(cmds[1], /nvidia-smi/, "but nvidia-smi is not respawned during backoff");
});

test("remote: an unreachable spark yields no thermal and does not throw", async () => {
  const c = collector({ id: "r", isLocal: false });
  c._getRemoteGpu = async () => ({ ...GPU });
  c._remoteExec = async () => {
    throw new Error("SSH to 10.0.0.9 failed: timeout");
  };

  const gpu = await c.collectGpu();

  assert.equal(gpu.temperature, 61);
  assert.equal("thermal" in gpu, false);
  assert.equal(await c._collectThermal(), null);
});
