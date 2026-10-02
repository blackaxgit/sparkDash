/**
 * Regression: llama.cpp slot counters are per-task, so rate deltas are valid
 * only while the same task occupies the slot. First contact with a busy slot
 * and task switches must contribute 0 — not count the task's whole history
 * (largely prompt-cache hits) inside one poll interval, which used to record
 * impossible daily peaks (e.g. 9550 decode tok/s on hardware that does ~65).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

function jsonRes(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function mkProbe(getSlots) {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 11434);
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes(getSlots());
    if (u.endsWith("/props")) return jsonRes({ model_alias: "ornith-35b" });
    return jsonRes({}, 404);
  };
  return probe;
}

function busySlot(over = {}) {
  return {
    id: 0,
    id_task: 100,
    is_processing: true,
    n_decoded: 19000,
    n_prompt_tokens_processed: 35000,
    n_prompt_tokens_cache: 49000,
    ...over,
  };
}

test("first contact with a busy slot contributes no rate", async () => {
  const probe = mkProbe(() => [busySlot()]);
  probe.lastProbeTime = Date.now() - 2000;
  await probe._probeLlamaCpp();
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.cachedPrefillTps || 0, 0);
  assert.equal(probe.uncachedPrefillTps || 0, 0);
});

test("same-task growth yields a sane rate", async () => {
  let slots = [busySlot()];
  const probe = mkProbe(() => slots);
  probe.lastProbeTime = Date.now() - 2000;
  await probe._probeLlamaCpp();
  slots = [busySlot({ n_decoded: 19100, n_prompt_tokens_processed: 35200, n_prompt_tokens_cache: 49000 })];
  probe.lastProbeTime = Date.now() - 2000;
  await probe._probeLlamaCpp();
  assert.ok(Math.abs(probe.generationTps - 50) < 5, `generationTps ${probe.generationTps}`);
  assert.ok(Math.abs(probe.prefillTps - 100) < 10, `prefillTps ${probe.prefillTps}`);
});

test("task switch on a slot contributes no spike", async () => {
  let slots = [busySlot({ id_task: 100, n_decoded: 500, n_prompt_tokens_processed: 800, n_prompt_tokens_cache: 100 })];
  const probe = mkProbe(() => slots);
  probe.lastProbeTime = Date.now() - 2000;
  await probe._probeLlamaCpp();
  probe.lastProbeTime = Date.now() - 2000;
  await probe._probeLlamaCpp(); // establish same-task baseline
  // New huge task lands on the slot: counters jump but must not become a rate.
  slots = [busySlot({ id_task: 101, n_decoded: 5, n_prompt_tokens_processed: 3000, n_prompt_tokens_cache: 50000 })];
  probe.lastProbeTime = Date.now() - 2000;
  await probe._probeLlamaCpp();
  assert.equal(probe.generationTps, 0);
  assert.equal(probe.prefillTps, 0);
  assert.equal(probe.cachedPrefillTps || 0, 0);
  assert.equal(probe.uncachedPrefillTps || 0, 0);
});
