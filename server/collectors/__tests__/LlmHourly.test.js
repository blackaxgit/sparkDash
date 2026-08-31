/**
 * Hourly generated-token volume: bucketing, counter resets, retention.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { LlmHourlyStore } from "../LlmHourly.js";

function tmpStore() {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "llm-hourly-")),
    "llm-hourly.json"
  );
  return new LlmHourlyStore(file);
}

function at(iso) {
  return new Date(iso);
}

test("first sample only baselines; the second records its delta", () => {
  const s = tmpStore();
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 1000 }, at("2026-08-29T10:05:00Z"));
  assert.equal(s.getSeries("spark", 11434, { hours: 2, now: at("2026-08-29T10:59:00Z") }).hours.at(-1).tokens, 0);

  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 1150 }, at("2026-08-29T10:35:00Z"));
  const series = s.getSeries("spark", 11434, { hours: 2, now: at("2026-08-29T10:59:00Z") });
  assert.equal(series.hours.at(-1).tokens, 150);
  assert.equal(series.hours.at(-1).hour, "2026-08-29T10");
});

test("tokens land in the bucket of the sample that observed them", () => {
  const s = tmpStore();
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 100 }, at("2026-08-29T10:59:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 300 }, at("2026-08-29T11:01:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 350 }, at("2026-08-29T12:01:00Z"));
  const series = s.getSeries("spark", 11434, { hours: 3, now: at("2026-08-29T12:30:00Z") });
  assert.deepEqual(
    series.hours.map((h) => [h.hour, h.tokens]),
    [
      ["2026-08-29T10", 0],
      ["2026-08-29T11", 200],
      ["2026-08-29T12", 50],
    ]
  );
});

test("backend restart (counter reset) counts the new total, not a negative", () => {
  const s = tmpStore();
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 5000 }, at("2026-08-29T10:00:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 5200 }, at("2026-08-29T10:30:00Z"));
  // llama-server restarts: counter drops to a small value.
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 40 }, at("2026-08-29T10:45:00Z"));
  const h = s.getSeries("spark", 11434, { hours: 1, now: at("2026-08-29T10:59:00Z") }).hours.at(-1);
  assert.equal(h.tokens, 240); // 200 before the reset + 40 after
});

test("an unavailable probe re-baselines instead of attributing the gap to one hour", () => {
  const s = tmpStore();
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 1000 }, at("2026-08-29T10:00:00Z"));
  s.record("spark", 11434, { available: false }, at("2026-08-29T10:10:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 9000 }, at("2026-08-29T10:20:00Z"));
  const h = s.getSeries("spark", 11434, { hours: 1, now: at("2026-08-29T10:59:00Z") }).hours.at(-1);
  assert.equal(h.tokens, 0);
  // Counting resumes from the new baseline.
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 9100 }, at("2026-08-29T10:30:00Z"));
  assert.equal(
    s.getSeries("spark", 11434, { hours: 1, now: at("2026-08-29T10:59:00Z") }).hours.at(-1).tokens,
    100
  );
});

test("a poll without the monotonic counter is skipped, not diffed", () => {
  const s = tmpStore();
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 1000 }, at("2026-08-29T10:00:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 1200 }, at("2026-08-29T10:05:00Z"));
  // /metrics timed out under load: the probe has no counter this poll. Its
  // slot-sum fallback is a different series entirely and must never be diffed.
  s.record(
    "spark",
    11434,
    { available: true, cumulativeOutputTokens: null, totalOutputTokens: 59663 },
    at("2026-08-29T10:10:00Z")
  );
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 1300 }, at("2026-08-29T10:15:00Z"));
  const h = s.getSeries("spark", 11434, { hours: 1, now: at("2026-08-29T10:59:00Z") }).hours.at(-1);
  // 200 + 100 across the gap; the counter is monotonic so nothing is lost.
  assert.equal(h.tokens, 300);
});

test("series is hour-aligned with zeros for quiet hours", () => {
  const s = tmpStore();
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 0 }, at("2026-08-29T08:00:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 500 }, at("2026-08-29T08:30:00Z"));
  const series = s.getSeries("spark", 11434, { hours: 4, now: at("2026-08-29T11:10:00Z") });
  assert.equal(series.hours.length, 4);
  assert.deepEqual(
    series.hours.map((h) => h.hour),
    ["2026-08-29T08", "2026-08-29T09", "2026-08-29T10", "2026-08-29T11"]
  );
  assert.deepEqual(series.hours.map((h) => h.tokens), [500, 0, 0, 0]);
});

test("ports and sparks keep separate series", () => {
  const s = tmpStore();
  for (const port of [11434, 11436]) {
    s.record("spark", port, { available: true, cumulativeOutputTokens: 0 }, at("2026-08-29T10:00:00Z"));
  }
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 700 }, at("2026-08-29T10:30:00Z"));
  s.record("spark", 11436, { available: true, cumulativeOutputTokens: 20 }, at("2026-08-29T10:30:00Z"));
  const opts = { hours: 1, now: at("2026-08-29T10:59:00Z") };
  assert.equal(s.getSeries("spark", 11434, opts).hours.at(-1).tokens, 700);
  assert.equal(s.getSeries("spark", 11436, opts).hours.at(-1).tokens, 20);
});

test("buckets older than the retention window are pruned and survive a reload", () => {
  const s = tmpStore();
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 0 }, at("2026-08-01T00:00:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 10 }, at("2026-08-01T00:30:00Z"));
  s.record("spark", 11434, { available: true, cumulativeOutputTokens: 60 }, at("2026-08-29T10:30:00Z"));
  s.flush();

  const reloaded = new LlmHourlyStore(s.filePath);
  const series = reloaded.getSeries("spark", 11434, { hours: 24, now: at("2026-08-29T10:59:00Z") });
  assert.equal(series.hours.at(-1).tokens, 50);
  const stored = JSON.parse(fs.readFileSync(s.filePath, "utf8"));
  assert.ok(
    !Object.keys(stored["spark:11434"] || {}).some((k) => k.startsWith("2026-08-01")),
    "August 1 buckets should have been pruned"
  );
});
