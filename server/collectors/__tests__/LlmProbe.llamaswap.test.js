/**
 * llama-swap router: a proxy port fronts N engines, so /v1/models is config
 * and /running is state. These pin the behaviour the migration to vLLM broke:
 * the panel showed the first *alias* ("embeddings", 8192 ctx) next to another
 * engine's metrics.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { LlmHourlyStore } from "../LlmHourly.js";
import { upstreamBase, parseRunning } from "../swapRouter.js";

const ROUTER_MODELS = {
  data: [
    { id: "embeddings", owned_by: "llama-swap", context_length: 8192 },
    { id: "ornith-35b", owned_by: "llama-swap", context_length: 262144 },
  ],
};

/** Prometheus body of a vLLM engine. */
function vllmMetrics({ start, prompt = 0, gen = 0, awake = 1 }) {
  return `process_start_time_seconds ${start}
vllm:num_requests_running{engine="0"} 0.0
vllm:num_requests_waiting{engine="0"} 0.0
vllm:engine_sleep_state{engine="0",sleep_state="awake"} ${awake}.0
vllm:engine_sleep_state{engine="0",sleep_state="weights_offloaded"} ${awake ? 0 : 1}.0
vllm:kv_cache_usage_perc{engine="0"} 0.25
vllm:prompt_tokens_total{engine="0"} ${prompt}.0
vllm:generation_tokens_total{engine="0"} ${gen}.0
`;
}

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function textRes(txt, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => txt };
}

/**
 * Router with an embedder resident since boot and an LLM swapped in later.
 * @param {{ llm?: object|null, embedStart?: number }} [opts]
 */
function routerFetch(opts = {}) {
  const {
    llmState = "ready",
    llmStart = 2000,
    llmPrompt = 527,
    llmGen = 190,
    llmAwake = 1,
    embedStart = 1000,
    includeLlm = true,
    llmMetricsDown = false,
  } = opts;
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/slots")) return jsonRes({}, 404);
      if (u.endsWith(":11434/v1/models")) return jsonRes(ROUTER_MODELS);
      if (u.endsWith("/running")) {
        const running = [];
        if (includeLlm) {
          running.push({
            model: "ornith-35b",
            state: llmState,
            proxy: "http://127.0.0.1:8000",
            name: "Ornith 1.5 35B NVFP4",
          });
        }
        running.push({
          model: "qwen3-embedding",
          state: "ready",
          proxy: "http://127.0.0.1:8001",
          name: "Qwen3-Embedding-4B",
        });
        return jsonRes({ running });
      }
      if (u.endsWith(":8000/metrics")) {
        if (llmMetricsDown) return textRes("", 503);
        return textRes(
          vllmMetrics({ start: llmStart, prompt: llmPrompt, gen: llmGen, awake: llmAwake })
        );
      }
      if (u.endsWith(":8001/metrics")) {
        return textRes(vllmMetrics({ start: embedStart, prompt: 289331, gen: 0 }));
      }
      if (u.endsWith(":8000/v1/models")) {
        return jsonRes({
          data: [
            {
              id: "ornith-35b",
              root: "ornith-ai/Ornith-1.5-35B-A3B-NVFP4",
              max_model_len: 262144,
            },
          ],
        });
      }
      if (u.endsWith(":8001/v1/models")) {
        return jsonRes({
          data: [{ id: "qwen3-embedding", root: "Qwen/Qwen3-Embedding-4B", max_model_len: 8192 }],
        });
      }
      return jsonRes({}, 404);
    },
  };
}

test("llama-swap: panel follows the running engine, not the first alias", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const { fetch, calls } = routerFetch();
  probe._fetch = fetch;

  const snap = await probe.probe();

  assert.equal(snap.router, "llama-swap");
  assert.equal(snap.backend, "vllm");
  assert.equal(snap.modelId, "ornith-35b", "must not report the 'embeddings' alias");
  assert.equal(snap.contextLength, 262144, "context must come from the engine");
  assert.equal(snap.modelPath, "ornith-ai/Ornith-1.5-35B-A3B-NVFP4");
  assert.equal(snap.routerModelName, "Ornith 1.5 35B NVFP4");
  assert.equal(snap.kvCacheUsage, 0.25);
  assert.equal(snap.available, true);
  assert.ok(
    calls.includes("http://127.0.0.1:8000/metrics"),
    `engine must be scraped at its own upstream; calls: ${calls.join(", ")}`
  );
});

test("llama-swap: only the always-resident helper is loaded → that is what is shown", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch({ includeLlm: false }).fetch;

  const snap = await probe.probe();

  assert.equal(snap.modelId, "qwen3-embedding");
  assert.equal(snap.contextLength, 8192);
  assert.equal(snap.available, true);
});

test("llama-swap: cold start is reported as loading, not as a dead port", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch({ llmState: "starting", includeLlm: true }).fetch;

  const snap = await probe.probe();

  assert.equal(snap.routerLoading, "ornith-35b");
  // The embedder is still ready, so the panel stays live on it.
  assert.equal(snap.modelId, "qwen3-embedding");
});

test("llama-swap: nothing resident → idle panel, no stale tiles", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith("/v1/models")) return jsonRes(ROUTER_MODELS);
    if (u.endsWith("/running")) return jsonRes({ running: [] });
    return jsonRes({}, 404);
  };
  // Pretend a previous poll left a loaded engine behind.
  probe.engineId = "ornith-35b@2000";
  probe.kvCacheUsage = 0.9;
  probe.mtpAcceptanceRate = 0.66;
  probe.contextLength = 262144;

  const snap = await probe.probe();

  assert.equal(snap.available, false);
  assert.equal(snap.modelId, null);
  assert.equal(snap.kvCacheUsage, null);
  assert.equal(snap.mtpAcceptanceRate, null);
  assert.equal(snap.contextLength, null);
});

test("llama-swap: a model swap does not spike tok/s", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  // A short-lived model first: its counters are small.
  probe._fetch = routerFetch({ llmPrompt: 12, llmGen: 7 }).fetch;
  await probe.probe();
  const before = probe.engineId;

  // Now a different engine on the same port, already deep into its own
  // history. Diffing across that boundary is what produced the 94k spike.
  probe._fetch = routerFetch({ llmStart: 3000, llmPrompt: 40000, llmGen: 20000 }).fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.notEqual(snap.engineId, before, "engine identity must change with the restart");
  assert.equal(snap.generationTps, 0, "a new engine's history is not this interval's work");
  assert.equal(snap.prefillTps, 0);
  assert.equal(snap.totalOutputTokens, 20000, "the counter itself is still reported");

  // …and the interval after the swap measures the new engine normally.
  probe._fetch = routerFetch({ llmStart: 3000, llmPrompt: 40200, llmGen: 20100 }).fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const next = await probe.probe();
  assert.ok(Math.abs(next.generationTps - 50) < 2, `generationTps ${next.generationTps}`);
});

test("llama-swap: every resident model reports its own tokens", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch({ llmPrompt: 1000, llmGen: 500 }).fetch;
  await probe.probe();

  // The LLM decodes 400 tokens; the embedder generates nothing, as always.
  // Age the per-engine samples the way a 2 s poll interval would.
  for (const st of probe._engineStats.values()) st.at -= 2000;
  probe._fetch = routerFetch({ llmPrompt: 1400, llmGen: 900 }).fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  const rows = snap.routerEngines;
  assert.equal(rows.length, 2, "both resident engines must be listed");
  assert.equal(rows[0].model, "ornith-35b", "the followed engine leads");
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].totalOutputTokens, 900);
  assert.ok(Math.abs(rows[0].generationTps - 200) < 2, `llm tok/s ${rows[0].generationTps}`);

  const embed = rows.find((r) => r.model === "qwen3-embedding");
  assert.equal(embed.active, false);
  assert.equal(embed.totalOutputTokens, 0, "an embedder generates nothing");
  assert.equal(embed.generationTps, 0);
});

test("llama-swap: a swapped-in engine's history is not another model's rate", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch({ llmPrompt: 10, llmGen: 5 }).fetch;
  await probe.probe();

  // Same router key, new process (new start time) already deep into its run.
  probe._fetch = routerFetch({ llmStart: 9000, llmPrompt: 50000, llmGen: 30000 }).fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  const llm = snap.routerEngines.find((r) => r.model === "ornith-35b");
  assert.equal(llm.totalOutputTokens, 30000, "the new engine's own counter");
  assert.equal(llm.generationTps, 0, "its history is not this interval's work");
});

test("llama-swap: a model that leaves drops off the resident list", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch().fetch;
  assert.equal((await probe.probe()).routerEngines.length, 2);

  probe._fetch = routerFetch({ includeLlm: false }).fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.deepEqual(
    snap.routerEngines.map((r) => r.model),
    ["qwen3-embedding"]
  );
});

test("llama-swap: steady engine still measures rates", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch({ llmPrompt: 1000, llmGen: 500 }).fetch;
  await probe.probe();

  probe._fetch = routerFetch({ llmPrompt: 1200, llmGen: 900 }).fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.ok(Math.abs(snap.generationTps - 200) < 2, `generationTps ${snap.generationTps}`);
  assert.equal(snap.totalOutputTokens, 900);
});

test("llama-swap: a busy engine's missed scrape does not hand the panel to a helper", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch().fetch;
  assert.equal((await probe.probe()).modelId, "ornith-35b", "newest engine wins first");
  const engineId = probe.engineId;

  // One missed scrape under decode — the embedder must not take the panel,
  // because that costs two engine changes and the tokens in between.
  probe._fetch = routerFetch({ llmMetricsDown: true }).fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const blip = await probe.probe();
  assert.equal(blip.modelId, "ornith-35b");
  assert.equal(blip.engineId, engineId, "a missed scrape is not a new engine");

  probe._fetch = routerFetch().fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const back = await probe.probe();
  assert.equal(back.modelId, "ornith-35b");
  assert.equal(back.engineId, engineId, "recovery must not re-baseline either");
});

test("llama-swap: an engine that stays dead hands the panel to the healthy one", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch().fetch;
  await probe.probe();

  probe._fetch = routerFetch({ llmMetricsDown: true }).fetch;
  let snap;
  for (let i = 0; i < 3; i++) {
    probe.lastProbeTime = Date.now() - 2000;
    snap = await probe.probe();
  }

  assert.equal(snap.modelId, "qwen3-embedding", "must fail over once the engine is really gone");
  assert.equal(snap.contextLength, 8192);
});

test("llama-swap: the outgoing model of a swap is not reported as loading", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith(":11434/v1/models")) return jsonRes(ROUTER_MODELS);
    if (u.endsWith("/running")) {
      return jsonRes({
        running: [
          { model: "lightning-30b", state: "stopping", proxy: "http://127.0.0.1:8000" },
          { model: "ornith-35b", state: "starting", proxy: "http://127.0.0.1:8000" },
          { model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8001" },
        ],
      });
    }
    if (u.endsWith(":8001/metrics")) return textRes(vllmMetrics({ start: 1000 }));
    if (u.endsWith(":8001/v1/models")) {
      return jsonRes({ data: [{ id: "qwen3-embedding", max_model_len: 8192 }] });
    }
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();
  assert.equal(snap.routerLoading, "ornith-35b", "the incoming model, not the one being evicted");
});

test("llama-swap: one unscrapable poll is not two swaps", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  // Only the LLM is resident, so there is nothing to fail over to.
  const only = (down) => async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith(":11434/v1/models")) return jsonRes(ROUTER_MODELS);
    if (u.endsWith("/running")) {
      return jsonRes({
        running: [{ model: "ornith-35b", state: "ready", proxy: "http://127.0.0.1:8000" }],
      });
    }
    if (u.endsWith(":8000/metrics")) {
      return down ? textRes("", 503) : textRes(vllmMetrics({ start: 2000, prompt: 500, gen: 400 }));
    }
    if (u.endsWith(":8000/v1/models")) {
      return jsonRes({ data: [{ id: "ornith-35b", max_model_len: 262144 }] });
    }
    return jsonRes({}, 404);
  };

  probe._fetch = only(false);
  const before = (await probe.probe()).engineId;

  probe._fetch = only(true);
  probe.lastProbeTime = Date.now() - 2000;
  const blip = await probe.probe();
  assert.equal(blip.engineId, before, "a scrape failure is not a new engine");

  probe._fetch = only(false);
  probe.lastProbeTime = Date.now() - 2000;
  const back = await probe.probe();
  assert.equal(back.engineId, before);
  assert.equal(back.contextLength, 262144, "context survives the blip");
});

test("llama-swap: a running row without a proxy is skipped, not fatal", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith(":11434/v1/models")) return jsonRes(ROUTER_MODELS);
    if (u.endsWith("/running")) {
      return jsonRes({
        running: [
          { model: "broken", state: "ready" },
          { model: "ornith-35b", state: "ready", proxy: "http://127.0.0.1:8000" },
        ],
      });
    }
    if (u.endsWith(":8000/metrics")) {
      return textRes(vllmMetrics({ start: 2000, prompt: 10, gen: 5 }));
    }
    if (u.endsWith(":8000/v1/models")) {
      return jsonRes({ data: [{ id: "ornith-35b", max_model_len: 262144 }] });
    }
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();
  assert.equal(snap.modelId, "ornith-35b");
  assert.equal(snap.routerResident, 1, "a row with no upstream is not resident capacity");
});

test("sglang behind a router: the first sample after a swap seeds prefill", () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const body = `sglang:prompt_tokens_total 90000\nsglang:generation_tokens_total 4000\n`;
  // dt 0 = the sample taken the moment the engine was resolved.
  probe._applySglangMetrics(body, 0);
  assert.equal(probe.lastTokenCounts.input, 90000, "prompt baseline must be seeded at dt 0");

  probe._applySglangMetrics(
    `sglang:prompt_tokens_total 90100\nsglang:generation_tokens_total 4200\n`,
    2
  );
  assert.equal(probe.prefillTps, 50, "90100-90000 over 2 s, not the whole counter");
  assert.equal(probe.generationTps, 100);
});

test("vLLM labeled engine_sleep_state: offloaded weights read as Sleeping", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = routerFetch({ llmAwake: 0 }).fetch;

  const snap = await probe.probe();

  assert.equal(snap.gpuMemoryUtilization, 0, "awake=0 must not sum to Active");
});

test("upstreamBase: only the probe host, only http(s)", () => {
  // A remote probe must rewrite the Spark's loopback, never read its own.
  assert.equal(
    upstreamBase("http://127.0.0.1:8000", "http://10.0.0.7:11434"),
    "http://10.0.0.7:8000"
  );
  assert.equal(
    upstreamBase("http://127.0.0.1:8000", "http://127.0.0.1:11434"),
    "http://127.0.0.1:8000"
  );
  // /running is remote input: it may not aim the dashboard at a new host…
  assert.equal(upstreamBase("http://169.254.169.254/", "http://10.0.0.7:11434"), null);
  assert.equal(upstreamBase("http://evil.example:80", "http://10.0.0.7:11434"), null);
  // …nor at a non-HTTP scheme.
  assert.equal(upstreamBase("ftp://10.0.0.7:21", "http://10.0.0.7:11434"), null);
  assert.equal(upstreamBase("file:///etc/passwd", "http://10.0.0.7:11434"), null);
  assert.equal(upstreamBase(null, "http://127.0.0.1:11434"), null);
  // Same host, different port is the engine llama-swap spawned.
  assert.equal(
    upstreamBase("http://10.0.0.7:8000", "http://10.0.0.7:11434"),
    "http://10.0.0.7:8000"
  );
});

test("parseRunning: a hostile body cannot fan the probe out", () => {
  const rows = parseRunning({
    running: Array.from({ length: 500 }, (_, i) => ({
      model: `m${i}`,
      state: "ready",
      proxy: "http://127.0.0.1:8000",
    })),
  });
  assert.equal(rows.length, 32);

  const long = parseRunning({
    running: [{ model: "x".repeat(5000), state: "ready", proxy: "http://127.0.0.1:8000" }],
  });
  assert.deepEqual(long, []);
  assert.equal(parseRunning({ running: "nope" }), null);
});

test("llama-swap: a ready engine with no metrics still names the model", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith(":11434/v1/models")) return jsonRes(ROUTER_MODELS);
    if (u.endsWith("/running")) {
      return jsonRes({
        running: [
          { model: "ornith-35b", state: "ready", proxy: "http://127.0.0.1:8000", name: "Ornith" },
        ],
      });
    }
    // Engine started with --disable-log-stats: no Prometheus at all.
    if (u.endsWith(":8000/metrics")) return textRes("", 404);
    if (u.endsWith(":8000/v1/models")) {
      return jsonRes({ data: [{ id: "ornith-35b", max_model_len: 262144 }] });
    }
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();

  assert.equal(snap.modelId, "ornith-35b");
  assert.equal(snap.contextLength, 262144);
  assert.equal(snap.available, true);
  assert.equal(snap.kvCacheUsage, null);
});

test("hourly tokens: a swapped-in engine's backlog is not booked as new work", () => {
  const store = new LlmHourlyStore("/nonexistent/llm-hourly-test.json");
  store.flush = () => {};
  const at = new Date("2026-09-19T20:00:00Z");

  const sample = (engineId, tokens) =>
    store.record("spark", 11434, {
      available: true,
      engineId,
      cumulativeOutputTokens: tokens,
    }, at);

  sample("a@1", 0);
  sample("a@1", 500);
  sample("b@2", 12936); // swap: a fresh engine reporting its own history
  sample("b@2", 13036);

  const series = store.getSeries("spark", 11434, { hours: 1, now: at });
  assert.equal(series.hours[0].tokens, 600, "500 from engine a + 100 from engine b");
});
