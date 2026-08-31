/**
 * Total generated tokens on the llama.cpp path must come from the monotonic
 * Prometheus counter. The per-slot n_decoded sum resets whenever a slot takes
 * a new task, so it cannot be diffed into hourly token volume.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const METRICS = `# HELP llamacpp:tokens_predicted_total Predicted tokens
# TYPE llamacpp:tokens_predicted_total counter
llamacpp:prompt_tokens_total 2311480
llamacpp:tokens_predicted_total 462911
llamacpp:requests_processing 0
`;

function res(body, status = 200, json = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (json ? JSON.stringify(body) : body),
    json: async () => body,
  };
}

function mkProbe(metricsHandler) {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 11434);
  probe.backendType = "llama.cpp";
  probe.authOpen = true;
  probe.lastProbeTime = Date.now() - 2000;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      return res([{ id: 0, id_task: 1, is_processing: true, n_decoded: 19000 }], 200, true);
    }
    if (u.endsWith("/props")) return res({ model_alias: "ornith-35b" }, 200, true);
    if (u.endsWith("/metrics")) return metricsHandler();
    return res({}, 404, true);
  };
  return probe;
}

test("llama.cpp: totalOutputTokens comes from llamacpp:tokens_predicted_total", async () => {
  const probe = mkProbe(() => res(METRICS));
  const snap = await probe._probeLlamaCpp();
  assert.equal(snap.totalOutputTokens, 462911);
});

test("llama.cpp: falls back to the slot sum when /metrics is absent, and stops re-probing it", async () => {
  let metricsCalls = 0;
  const probe = mkProbe(() => {
    metricsCalls += 1;
    return res({}, 404, true);
  });
  const first = await probe._probeLlamaCpp();
  assert.equal(first.totalOutputTokens, 19000);
  probe.lastProbeTime = Date.now() - 2000;
  const second = await probe._probeLlamaCpp();
  assert.equal(second.totalOutputTokens, 19000);
  assert.equal(metricsCalls, 1, "a 404 on /metrics must not be retried every poll");
});

test("llama.cpp: no cumulative counter is reported when /metrics is unavailable", async () => {
  // The slot-sum fallback keeps the TOTAL GENERATED tile alive, but it is a
  // different series and must not leak into hourly token volume.
  const probe = mkProbe(() => res({}, 404, true));
  const snap = await probe._probeLlamaCpp();
  assert.equal(snap.totalOutputTokens, 19000);
  assert.equal(snap.cumulativeOutputTokens, null);
});

test("llama.cpp: the cumulative counter is the Prometheus value, not the slot sum", async () => {
  const probe = mkProbe(() => res(METRICS));
  const snap = await probe._probeLlamaCpp();
  assert.equal(snap.cumulativeOutputTokens, 462911);
});
