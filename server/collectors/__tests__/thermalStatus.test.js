import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_WINDOW_MS,
  evaluateThermal,
  parseThermalSmi,
  parseZoneDump,
  recordThermalSample,
  summarizeZones,
} from "../thermalStatus.js";

const NOW = 1_800_000_000_000;

/** Healthy baseline taken from the live Spark: 8°C headroom, zones 92/104. */
const base = {
  tlimitC: 8,
  zoneMaxC: 92,
  zoneCritC: 104,
  hwSlowdownUs: 0,
  swSlowdownUs: 16_257_583,
  powerCapUs: 22_139_756_962,
};

const flat = (hw, sw, ages = [60_000, 30_000]) =>
  ages.map((a) => ({ at: NOW - a, hw, sw }));

test("flat counters and cool zones are ok", () => {
  const t = evaluateThermal(base, flat(0, 16_257_583), NOW);
  assert.equal(t.level, "ok");
  assert.equal(t.hwSlowdownRecent, false);
  assert.equal(t.swSlowdownRecent, false);
  assert.deepEqual(t.reasons, []);
});

test("T.Limit headroom <= 2 is a warning, 3 is not", () => {
  const warn = evaluateThermal({ ...base, tlimitC: 2 }, flat(0, 16_257_583), NOW);
  assert.equal(warn.level, "warn");
  assert.deepEqual(warn.reasons, ["T.Limit headroom 2°C (≤ 2°C)"]);
  assert.equal(evaluateThermal({ ...base, tlimitC: 3 }, flat(0, 16_257_583), NOW).level, "ok");
});

test("zone max >= 98 warns; below does not", () => {
  assert.equal(evaluateThermal({ ...base, zoneMaxC: 97.9 }, [], NOW).level, "ok");
  const t = evaluateThermal({ ...base, zoneMaxC: 98 }, [], NOW);
  assert.equal(t.level, "warn");
  assert.match(t.reasons[0], /Thermal zone 98°C/);
});

test("zone max within 4°C of its critical trip is crit", () => {
  assert.equal(evaluateThermal({ ...base, zoneMaxC: 99.9 }, [], NOW).level, "warn");
  const t = evaluateThermal({ ...base, zoneMaxC: 100 }, [], NOW);
  assert.equal(t.level, "crit");
  assert.match(t.reasons[0], /100°C.*critical 104°C/);
  // A lower critical trip lowers the crit line with it.
  assert.equal(evaluateThermal({ ...base, zoneMaxC: 90, zoneCritC: 94 }, [], NOW).level, "crit");
});

test("missing critical trip defaults to 104°C", () => {
  assert.equal(evaluateThermal({ ...base, zoneCritC: null, zoneMaxC: 99 }, [], NOW).level, "warn");
  assert.equal(evaluateThermal({ ...base, zoneCritC: null, zoneMaxC: 100 }, [], NOW).level, "crit");
});

test("hardware slowdown growth within 10 min is crit", () => {
  const t = evaluateThermal({ ...base, hwSlowdownUs: 5_000_000 }, flat(0, 16_257_583), NOW);
  assert.equal(t.hwSlowdownRecent, true);
  assert.equal(t.level, "crit");
  assert.match(t.reasons[0], /Hardware thermal slowdown grew by 5 s/);
});

test("a sub-second-scale SW slowdown blip is recent but not a warning", () => {
  // Live: +0.2 s over 10 min of a sustained render — firmware nudging the clock.
  const blip = evaluateThermal({ ...base, swSlowdownUs: 18_000_000 }, flat(0, 16_257_583), NOW);
  assert.equal(blip.swSlowdownRecent, true);
  assert.equal(blip.level, "ok");
  assert.deepEqual(blip.reasons, []);
});

test("software slowdown of >= 1% of the window is warn, and crit still outranks it", () => {
  const sw = evaluateThermal({ ...base, swSlowdownUs: 22_257_583 }, flat(0, 16_257_583), NOW);
  assert.equal(sw.level, "warn");
  assert.match(sw.reasons[0], /Software thermal slowdown grew by 6 s/);
  const both = evaluateThermal(
    { ...base, swSlowdownUs: 22_257_583, hwSlowdownUs: 1 },
    flat(0, 16_257_583),
    NOW
  );
  assert.equal(both.level, "crit");
});

test("growth older than the 10 min window is not recent", () => {
  const old = [{ at: NOW - RECENT_WINDOW_MS - 1_000, hw: 0, sw: 0 }];
  const t = evaluateThermal({ ...base, hwSlowdownUs: 9, swSlowdownUs: 9 }, old, NOW);
  assert.equal(t.hwSlowdownRecent, false);
  assert.equal(t.swSlowdownRecent, false);
  assert.equal(t.level, "ok");
});

test("a counter reset (decrease) is not growth", () => {
  const history = [
    { at: NOW - 120_000, hw: 1000, sw: 1000 },
    { at: NOW - 60_000, hw: 1000, sw: 1000 },
  ];
  const t = evaluateThermal({ ...base, hwSlowdownUs: 5, swSlowdownUs: 5 }, history, NOW);
  assert.equal(t.hwSlowdownRecent, false);
  assert.equal(t.swSlowdownRecent, false);
  assert.equal(t.level, "ok");
});

test("growth after a reset is detected; a reset is only ever a decrease", () => {
  // Counter reset to 5 (after being flat at 200), then real growth 5 -> 8.
  const history = [
    { at: NOW - 180_000, hw: 200, sw: 0 },
    { at: NOW - 120_000, hw: 200, sw: 0 },
    { at: NOW - 60_000, hw: 5, sw: 0 },
  ];
  assert.equal(evaluateThermal({ ...base, hwSlowdownUs: 8 }, history, NOW).hwSlowdownRecent, true);
  // Reset to 150 after sitting at 1000: below the old value, so no growth.
  const reset = [
    { at: NOW - 120_000, hw: 1_000, sw: 0 },
    { at: NOW - 60_000, hw: 1_000, sw: 0 },
  ];
  assert.equal(
    evaluateThermal({ ...base, hwSlowdownUs: 150 }, reset, NOW).hwSlowdownRecent,
    false
  );
});

test("null counters never count as growth and do not break a series", () => {
  const history = [
    { at: NOW - 60_000, hw: null, sw: null },
    { at: NOW - 30_000, hw: 10, sw: 10 },
  ];
  const t = evaluateThermal({ ...base, hwSlowdownUs: null, swSlowdownUs: 10 }, history, NOW);
  assert.equal(t.hwSlowdownRecent, false);
  assert.equal(t.swSlowdownRecent, false);
});

test("every input null is unknown; one known input is not", () => {
  const nulls = {
    tlimitC: null,
    zoneMaxC: null,
    zoneCritC: null,
    hwSlowdownUs: null,
    swSlowdownUs: null,
    powerCapUs: null,
  };
  const t = evaluateThermal(nulls, [], NOW);
  assert.equal(t.level, "unknown");
  assert.deepEqual(t.reasons, []);
  assert.equal(evaluateThermal({ ...nulls, powerCapUs: 0 }, [], NOW).level, "ok");
});

test("recordThermalSample drops samples outside the window", () => {
  const h = [];
  recordThermalSample(h, { at: NOW - RECENT_WINDOW_MS - 5_000, hw: 1, sw: 1 });
  recordThermalSample(h, { at: NOW - 10_000, hw: 2, sw: 2 });
  recordThermalSample(h, { at: NOW, hw: 3, sw: 3 });
  assert.deepEqual(
    h.map((s) => s.hw),
    [2, 3]
  );
});

test("parseThermalSmi reads the live Spark line", () => {
  assert.deepEqual(parseThermalSmi("8, 0, 16257583, 22139756962\n"), {
    tlimitC: 8,
    hwSlowdownUs: 0,
    swSlowdownUs: 16_257_583,
    powerCapUs: 22_139_756_962,
  });
});

test("parseThermalSmi maps [N/A] and Not Supported to null", () => {
  assert.deepEqual(parseThermalSmi("[N/A], 0, Not Supported, [N/A]"), {
    tlimitC: null,
    hwSlowdownUs: 0,
    swSlowdownUs: null,
    powerCapUs: null,
  });
});

test("parseThermalSmi returns null for failures so the caller can back off", () => {
  assert.equal(parseThermalSmi(""), null);
  assert.equal(parseThermalSmi(undefined), null);
  assert.equal(parseThermalSmi('Field "clocks_event_reasons_counters.x" is not a valid field'), null);
  assert.equal(parseThermalSmi("8, 0, 5"), null);
});

test("summarizeZones takes the hottest zone and the lowest critical trip", () => {
  const z = summarizeZones([
    { tempMilliC: 88_000, critMilliC: [104_000] },
    { tempMilliC: 92_000, critMilliC: [104_000, 100_000] },
    { tempMilliC: 60_500, critMilliC: [] },
  ]);
  assert.deepEqual(z, { zoneMaxC: 92, zoneCritC: 100 });
});

test("summarizeZones ignores unreadable and implausible readings", () => {
  assert.deepEqual(
    summarizeZones([
      { tempMilliC: null, critMilliC: [] },
      { tempMilliC: 0, critMilliC: [0] },
      { tempMilliC: 999_999, critMilliC: [] },
    ]),
    { zoneMaxC: null, zoneCritC: null }
  );
  assert.deepEqual(summarizeZones([]), { zoneMaxC: null, zoneCritC: null });
});

test("parseZoneDump reads the remote script output", () => {
  const dump = ["T 91000", "C 104000", "T 92000", "C 104000", "T ", "junk", "T 88500"].join("\n");
  assert.deepEqual(parseZoneDump(dump), { zoneMaxC: 92, zoneCritC: 104 });
  assert.deepEqual(parseZoneDump(""), { zoneMaxC: null, zoneCritC: null });
});
