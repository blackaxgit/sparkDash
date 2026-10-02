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
