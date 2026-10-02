/**
 * Server-side sparkline history: the ring buffer that lets a freshly opened
 * tab show the last hour instead of building up from empty.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

const { MetricsHistoryStore } = await import("../collectors/MetricsHistory.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-history-"));
let n = 0;
const tmpFile = () => path.join(dir, `history-${n++}.json`);

const TPS_KEY = "spark-1:llm:11434.tps";

/** One online DGX Spark with an LLM on :11434, shaped like a real snapshot. */
function snapshot({ id = "spark-1", online = true, tps = 20.81 } = {}) {
  return [
    {
      id,
      online,
      kind: "spark",
      llmPorts: [11434],
      metrics: {
        gpu: { usage: 42, temperature: 51 },
        ram: { percentage: 79.5 },
        llm: [{ generationTps: tps, prefillTps: 1844, cachedPrefillTps: 0, uncachedPrefillTps: 0 }],
      },
    },
  ];
}

test("records the LLM series under the port-keyed name the client reads", () => {
  const store = new MetricsHistoryStore(tmpFile());
  store.recordSnapshot(snapshot());

  const series = store.getAll();
  assert.deepEqual(series[TPS_KEY], [20.81]);
  assert.deepEqual(series["spark-1:llm:11434.prefill"], [1844]);
  assert.deepEqual(series["spark-1:gpu.usage"], [42]);
  assert.deepEqual(series["spark-1:ram.percentage"], [79.5]);
  // Sparks are not hosts, so CPU temperature is not part of the payload.
  assert.equal(series["spark-1:cpu.temp"], undefined);
});

test("an offline spark contributes no samples, so charts show a gap not zeros", () => {
  const store = new MetricsHistoryStore(tmpFile());
  store.recordSnapshot(snapshot({ tps: 33 }));
  store.recordSnapshot(snapshot({ online: false }));

  assert.deepEqual(store.getAll()[TPS_KEY], [33]);
});

test("the buffer keeps the newest samples and never grows past its cap", () => {
  const store = new MetricsHistoryStore(tmpFile(), 3);
  for (const tps of [1, 2, 3, 4, 5]) store.recordSnapshot(snapshot({ tps }));

  assert.deepEqual(store.getAll()[TPS_KEY], [3, 4, 5]);
});

test("a spark that leaves the registry loses its series", () => {
  const store = new MetricsHistoryStore(tmpFile());
  store.recordSnapshot(snapshot({ id: "spark-1" }));
  store.recordSnapshot(snapshot({ id: "spark-2" }));

  const keys = Object.keys(store.getAll());
  assert.ok(keys.every((k) => k.startsWith("spark-2:")), `stale keys survived: ${keys}`);
});

test("history written moments ago is restored across a restart", () => {
  const file = tmpFile();
  const first = new MetricsHistoryStore(file);
  first.recordSnapshot(snapshot({ tps: 27.5 }));
  first.flush();

  assert.deepEqual(new MetricsHistoryStore(file).getAll()[TPS_KEY], [27.5]);
});

test("stale history is discarded rather than drawn as if it were current", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      updatedAt: Date.now() - 60 * 60_000, // an hour of downtime
      series: { [TPS_KEY]: [99, 98, 97] },
    })
  );

  assert.deepEqual(new MetricsHistoryStore(file).getAll(), {});
});

test("a corrupt file leaves the store empty instead of throwing at boot", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");

  assert.deepEqual(new MetricsHistoryStore(file).getAll(), {});
});

// ─── timing contract: what the chart-age axis reads ───────────────

test("timestamps are trimmed in lockstep, so the reported start is the oldest kept sample", () => {
  const store = new MetricsHistoryStore(tmpFile(), 3);
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) store.push(TPS_KEY, i, t0 + i * 1000);

  // Values 2,3,4 survive the cap; the age axis must point at sample 2's time,
  // not at the long-evicted sample 0 — an off-by-one here silently ages the
  // chart by the whole buffer.
  assert.deepEqual(store.getAll()[TPS_KEY], [2, 3, 4]);
  assert.deepEqual(store.getMeta()[TPS_KEY], [t0 + 2000, t0 + 4000]);
});

test("a frozen series keeps ageing, which sample count alone cannot express", () => {
  const store = new MetricsHistoryStore(tmpFile());
  const start = Date.now() - 120_000;
  for (let i = 0; i < 3; i++) store.push(TPS_KEY, i, start + i * 1000);
  // Host drops off the network: ticks keep firing, no samples land.
  for (let i = 0; i < 5; i++) store.recordSnapshot(snapshot({ online: false }));

  const [first, last] = store.getMeta()[TPS_KEY];
  assert.equal(store.getAll()[TPS_KEY].length, 3);
  assert.equal(first, start);
  // Three samples would read as "3s" from length alone; the truth is ~2 min.
  assert.ok(Date.now() - first > 110_000, `age collapsed to ${Date.now() - first}ms`);
  assert.equal(last, start + 2000);
});

test("the endpoints an age label reads survive a restart exactly", () => {
  const file = tmpFile();
  const first = new MetricsHistoryStore(file);
  const t0 = Date.now() - 30_000;
  for (let i = 0; i < 4; i++) first.push(TPS_KEY, i, t0 + i * 1000);
  first.flush();

  const restored = new MetricsHistoryStore(file);
  assert.deepEqual(restored.getMeta()[TPS_KEY], [t0, t0 + 3000]);
  // Interior timestamps are interpolated, but the array must stay aligned with
  // the values or the next trim would report the wrong start.
  assert.equal(restored.getAll()[TPS_KEY].length, 4);
  restored.push(TPS_KEY, 99, t0 + 4000);
  assert.deepEqual(restored.getMeta()[TPS_KEY], [t0, t0 + 4000]);
});

test("a history file predating the timing contract still yields a usable age", () => {
  const file = tmpFile();
  const before = Date.now();
  fs.writeFileSync(
    file,
    // No `times` key: written by the version shipped earlier today.
    JSON.stringify({ updatedAt: Date.now(), series: { [TPS_KEY]: [10, 11, 12] } })
  );

  const [first, last] = new MetricsHistoryStore(file).getMeta()[TPS_KEY];
  assert.ok(Number.isFinite(first) && Number.isFinite(last));
  assert.ok(first < last, "fallback produced a zero-length span");
  assert.ok(last <= Date.now(), "fallback dated a sample in the future");
  assert.ok(before - first < 10_000, "fallback aged a 3-sample series absurdly");
});

// ─── long tier: per-minute averages, 7-day retention, getRange ────

const MIN = 60_000;
/** Ten-minute aligned instant half an hour ago: safely inside retention, on every step grid. */
const T = Math.floor((Date.now() - 30 * MIN) / (10 * MIN)) * (10 * MIN);

function longSnap({ id = "spark-1", usage = 10, extra = {} } = {}) {
  return [
    {
      id,
      online: true,
      kind: "spark",
      llmPorts: [11434],
      metrics: { gpu: { usage, temperature: 50, power: { draw: 90 } }, ...extra },
    },
  ];
}

const valueAt = (res, key, ts) => res.series[key]?.find(([t]) => t === ts)?.[1];

test("long tier averages samples within a minute and starts a new point at the boundary", () => {
  const store = new MetricsHistoryStore(tmpFile());
  store.recordSnapshot(longSnap({ usage: 10 }), T + 5_000);
  store.recordSnapshot(longSnap({ usage: 20 }), T + 30_000);
  store.recordSnapshot(longSnap({ usage: 40 }), T + 65_000);

  const res = store.getRange("spark-1", "1h", T + 90_000);
  assert.equal(res.range, "1h");
  assert.equal(res.stepMs, 60_000);
  assert.equal(res.series["gpu.usage"].length, 60);
  assert.equal(valueAt(res, "gpu.usage", T), 15);
  assert.equal(valueAt(res, "gpu.usage", T + MIN), 40);
  assert.equal(valueAt(res, "gpu.power", T), 90);
  // oldest first, last point is the minute containing `now`
  assert.equal(res.series["gpu.usage"].at(-1)[0], T + MIN);
});

test("a minute with no samples is a null gap, not a zero", () => {
  const store = new MetricsHistoryStore(tmpFile());
  store.recordSnapshot(longSnap({ usage: 10 }), T);
  store.recordSnapshot(longSnap({ usage: 30 }), T + 3 * MIN);

  const res = store.getRange("spark-1", "24h", T + 3 * MIN + 1000);
  assert.equal(res.series["gpu.usage"].length, 1440);
  assert.equal(valueAt(res, "gpu.usage", T), 10);
  assert.equal(valueAt(res, "gpu.usage", T + MIN), null);
  assert.equal(valueAt(res, "gpu.usage", T + 2 * MIN), null);
  assert.equal(valueAt(res, "gpu.usage", T + 3 * MIN), 30);
});

test("7d range downsamples to 10-minute buckets averaging only the minutes that have data", () => {
  const store = new MetricsHistoryStore(tmpFile());
  store.recordSnapshot(longSnap({ usage: 10 }), T);
  store.recordSnapshot(longSnap({ usage: 20 }), T + 2 * MIN);
  store.recordSnapshot(longSnap({ usage: 100 }), T + 10 * MIN);

  const res = store.getRange("spark-1", "7d", T + 10 * MIN + 1000);
  assert.equal(res.stepMs, 600_000);
  assert.equal(res.series["gpu.usage"].length, 1008);
  assert.equal(valueAt(res, "gpu.usage", T), 15); // (10+20)/2, the 8 empty minutes don't dilute it
  assert.equal(valueAt(res, "gpu.usage", T + 10 * MIN), 100);
  assert.equal(valueAt(res, "gpu.usage", T - 10 * MIN), null);
});

test("points older than 7 days are dropped when the long file is loaded", () => {
  const file = tmpFile();
  const longFile = file.replace(/\.json$/, "-long.json");
  const now = Date.now();
  const aligned = Math.floor(now / MIN) * MIN;
  const sevenDays = 7 * 24 * 60 * MIN;
  fs.writeFileSync(
    longFile,
    JSON.stringify({
      updatedAt: now,
      series: {
        // first three minutes are past the retention cutoff, the rest are inside it
        "spark-1:gpu.usage": { start: aligned - sevenDays - 3 * MIN, values: [1, 2, 3, 7, 7, 7] },
        // wholly expired key must disappear
        "spark-1:gpu.temp": { start: aligned - sevenDays - 10 * MIN, values: [5, 5, 5] },
      },
    })
  );

  const store = new MetricsHistoryStore(file);
  const entry = store._long.get("spark-1:gpu.usage");
  assert.ok(entry.start >= now - sevenDays, "kept a point older than the cutoff");
  assert.ok(entry.values.length > 0 && entry.values.every((v) => v === 7), `kept ${entry.values}`);
  assert.equal(store._long.has("spark-1:gpu.temp"), false);
});

test("long tier survives a restart through its own file", () => {
  const file = tmpFile();
  const first = new MetricsHistoryStore(file);
  first.recordSnapshot(longSnap({ usage: 10 }), T);
  first.recordSnapshot(longSnap({ usage: 20 }), T + MIN); // commits minute T
  first.flushAll();
  assert.ok(fs.existsSync(file.replace(/\.json$/, "-long.json")));

  const restored = new MetricsHistoryStore(file);
  const res = restored.getRange("spark-1", "1h", T + MIN + 1000);
  assert.equal(valueAt(res, "gpu.usage", T), 10);
});

test("long tier keys follow the spec: memory fallback, primary NIC, per-port tok/s, non-finite skipped", () => {
  const store = new MetricsHistoryStore(tmpFile());
  store.recordSnapshot(
    longSnap({
      extra: {
        ram: { percentage: 61 },
        cpu: { usage: 12 },
        network: {
          primaryInterface: "enP7s7",
          interfaces: [
            { name: "lo", rxSpeed: 1, txSpeed: 1 },
            { name: "enP7s7", rxSpeed: 1000, txSpeed: 500 },
          ],
        },
        llm: [{ generationTps: 25.5 }, { generationTps: Number.NaN }],
      },
    }).map((s) => ({ ...s, llmPorts: [11434, 11435] })),
    T
  );
  store.recordSnapshot(
    longSnap({ extra: { unifiedMemory: { percentage: 70 }, ram: { percentage: 61 } } }),
    T
  );

  const series = store.getRange("spark-1", "1h", T + 1000).series;
  assert.equal(valueAt({ series }, "mem.percentage", T), 65.5); // (61 + 70) / 2: unified wins when present
  assert.equal(valueAt({ series }, "cpu.usage", T), 12);
  assert.equal(valueAt({ series }, "net.rx", T), 1000);
  assert.equal(valueAt({ series }, "net.tx", T), 500);
  assert.equal(valueAt({ series }, "llm:11434.tps", T), 25.5);
  assert.equal(series["llm:11435.tps"], undefined);
});

test("long tier drops a removed spark's series from memory and disk", () => {
  const file = tmpFile();
  const store = new MetricsHistoryStore(file);
  store.recordSnapshot([...longSnap({ id: "spark-1" }), ...longSnap({ id: "spark-2" })], T);
  store.recordSnapshot(longSnap({ id: "spark-2" }), T + MIN);
  store.flushAll();

  assert.deepEqual(store.getRange("spark-1", "1h", T + MIN).series, {});
  assert.ok(store.getRange("spark-2", "1h", T + MIN).series["gpu.usage"]);
  assert.deepEqual(new MetricsHistoryStore(file).getRange("spark-1", "1h", T + MIN).series, {});
});

test("a failed GPU collection leaves the long-tier gpu keys as gaps, not zeros", () => {
  const store = new MetricsHistoryStore(tmpFile());
  const snap = longSnap({ extra: { ram: { percentage: 40 } } });
  snap[0].metrics.gpu = { collected: false, usage: 0, temperature: 0, power: { draw: 0 } };
  store.recordSnapshot(snap, T);

  const series = store.getRange("spark-1", "1h", T + 1000).series;
  assert.equal(series["gpu.usage"], undefined);
  assert.equal(series["gpu.temp"], undefined);
  assert.equal(series["gpu.power"], undefined);
  assert.equal(valueAt({ series }, "mem.percentage", T), 40);
});

test("a corrupt long file is moved aside with a warning and the store starts empty", (t) => {
  const file = tmpFile();
  const longFile = file.replace(/\.json$/, "-long.json");
  fs.writeFileSync(longFile, "{not json");
  const warn = t.mock.method(console, "warn", () => {});

  const store = new MetricsHistoryStore(file);

  assert.equal(store._long.size, 0);
  assert.equal(fs.existsSync(longFile), false);
  const moved = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${path.basename(longFile)}.corrupt-`));
  assert.equal(moved.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, moved[0]), "utf8"), "{not json");
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(String(warn.mock.calls[0].arguments[0]).includes(longFile));
});

test("five minutes of 1s ticks rewrite the long file at most once; the short flush never does", (t) => {
  const start = Math.floor(Date.now() / MIN) * MIN;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const file = tmpFile();
  const store = new MetricsHistoryStore(file);
  let longWrites = 0;
  const realFlushLong = store.flushLong.bind(store);
  store.flushLong = () => {
    if (store._longDirty) longWrites++;
    realFlushLong();
  };

  for (let s = 0; s < 300; s++) {
    store.recordSnapshot(longSnap({ usage: s % 100 }), Date.now());
    t.mock.timers.tick(1000);
  }
  assert.ok(longWrites <= 1, `long file rewritten ${longWrites} times in 5 minutes`);
  assert.ok(fs.existsSync(file), "short tier was not flushed on its 30s timer");

  // The 5-minute long timer armed at the first minute boundary fires at 6:00.
  for (let s = 300; s < 390; s++) {
    store.recordSnapshot(longSnap({ usage: s % 100 }), Date.now());
    t.mock.timers.tick(1000);
  }
  assert.equal(longWrites, 1);
  assert.ok(fs.existsSync(file.replace(/\.json$/, "-long.json")));
});
