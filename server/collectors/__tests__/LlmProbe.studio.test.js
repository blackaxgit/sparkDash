/**
 * A ComfyUI video studio (ltx-studio, h3-studio) is a llama-swap member but not an
 * LLM engine. It must not be scraped, selected, counted as resident or reported as
 * "loading" — and the probe must name it so the panel can say the GPU is held.
 */
import { test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import { LlmProbe } from "../LlmProbe.js";
import { resetComfyDetectCache } from "../comfyDetect.js";

const ROUTER_MODELS = {
  data: [
    { id: "embeddings", owned_by: "llama-swap" },
    { id: "h3-studio", owned_by: "llama-swap" },
  ],
};

const EMBED_METRICS = `process_start_time_seconds 1000
vllm:num_requests_running{engine="0"} 0.0
vllm:num_requests_waiting{engine="0"} 0.0
vllm:engine_sleep_state{engine="0",sleep_state="awake"} 1.0
vllm:kv_cache_usage_perc{engine="0"} 0.1
vllm:prompt_tokens_total{engine="0"} 100.0
vllm:generation_tokens_total{engine="0"} 0.0
`;

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function textRes(txt, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => txt };
}

/**
 * @param {{ studioState?: string, studioPort?: number, comfy?: boolean, statsDown?: boolean }} [opts]
 */
function studioFetch({
  studioState = "ready",
  studioPort = 8189,
  comfy = true,
  statsDown = false,
} = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/slots")) return jsonRes({}, 404);
      if (u.endsWith(":11434/v1/models")) return jsonRes(ROUTER_MODELS);
      if (u.endsWith("/running")) {
        return jsonRes({
          running: [
            {
              model: "h3-studio",
              state: studioState,
              proxy: `http://127.0.0.1:${studioPort}`,
              name: "MiniMax H3 video studio (ComfyUI)",
            },
            {
              model: "qwen3-embedding",
              state: "ready",
              proxy: "http://127.0.0.1:8001",
              name: "Qwen3-Embedding-4B",
            },
          ],
        });
      }
      if (u === `http://127.0.0.1:${studioPort}/system_stats`) {
        if (statsDown) throw new Error("ECONNREFUSED");
        return comfy ? jsonRes({ system: { comfyui_version: "0.37.0" } }) : jsonRes({}, 404);
      }
      if (u.endsWith(":8001/system_stats")) return jsonRes({}, 404);
      if (u.endsWith(":8001/metrics")) return textRes(EMBED_METRICS);
      if (u.endsWith(":8001/v1/models")) {
        return jsonRes({
          data: [{ id: "qwen3-embedding", root: "Qwen/Qwen3-Embedding-4B", max_model_len: 8192 }],
        });
      }
      return jsonRes({}, 404);
    },
  };
}

beforeEach(() => resetComfyDetectCache());

test("a resident ComfyUI studio is reported as studio and kept out of the engine list", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const { fetch, calls } = studioFetch();
  probe._fetch = fetch;

  const snap = await probe.probe();

  assert.deepEqual(snap.studio, {
    model: "h3-studio",
    name: "MiniMax H3 video studio (ComfyUI)",
  });
  assert.equal(snap.router, "llama-swap");
  assert.equal(snap.modelId, "qwen3-embedding", "the followed engine is the embedder");
  assert.equal(snap.routerModel, "qwen3-embedding");
  assert.deepEqual(
    snap.routerEngines.map((e) => e.model),
    ["qwen3-embedding"]
  );
  assert.equal(snap.routerResident, 1, "the studio is not an LLM engine");
  assert.ok(
    !calls.some((c) => c.startsWith("http://127.0.0.1:8189/") && !c.endsWith("/system_stats")),
    `only the /system_stats probe may touch the studio; calls: ${calls.join(", ")}`
  );
  assert.ok(!calls.some((c) => c.includes("/upstream/")), "never through llama-swap /upstream/");
});

test("a studio row cannot hide an LLM row that reuses its name", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const inner = studioFetch().fetch;
  probe._fetch = async (url) => {
    if (!String(url).endsWith("/running")) return inner(url);
    return jsonRes({
      running: [
        { model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8189", name: "studio" },
        { model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8001", name: "LLM" },
      ],
    });
  };
  const snap = await probe.probe();

  assert.equal(snap.studio?.name, "studio");
  assert.equal(snap.routerResident, 1, "the non-studio row is still a resident engine");
  assert.equal(snap.modelId, "qwen3-embedding");
});

test("no /v1/models (or /metrics) request goes to the studio after the first poll", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const { fetch, calls } = studioFetch();
  probe._fetch = fetch;

  await probe.probe();
  const afterFirst = calls.length;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.equal(snap.studio?.model, "h3-studio");
  const studioCalls = calls.filter((c) => c.includes(":8189"));
  assert.deepEqual(studioCalls, ["http://127.0.0.1:8189/system_stats"], "detection is cached");
  assert.ok(calls.length > afterFirst, "the second poll did run");
  assert.ok(!calls.some((c) => c === "http://127.0.0.1:8189/v1/models"));
});

test("a studio that is still loading is neither 'loading' nor an engine", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = studioFetch({ studioState: "starting" }).fetch;

  const snap = await probe.probe();

  assert.equal(snap.studio, null, "only a ready studio holds the GPU");
  assert.equal(snap.routerResident, 1);
  assert.equal(snap.modelId, "qwen3-embedding");
});

test("a known studio that restarts (starting, /system_stats down) is not a loading LLM", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = studioFetch().fetch;
  assert.equal((await probe.probe()).studio?.model, "h3-studio");

  const restart = studioFetch({ studioState: "starting", statsDown: true });
  probe._fetch = restart.fetch;
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.equal(snap.routerLoading, null, "a starting studio is not a model arriving to chat");
  assert.equal(snap.studio, null, "not ready, so it does not hold the GPU yet");
  assert.deepEqual(
    snap.routerEngines.map((e) => e.model),
    ["qwen3-embedding"]
  );
  assert.ok(
    !restart.calls.some((c) => c.includes(":8189")),
    `a known starting studio is not scanned or probed; calls: ${restart.calls.join(", ")}`
  );
});

test("a non-ComfyUI upstream on the same shape is still an engine", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = studioFetch({ comfy: false, studioPort: 8189 }).fetch;

  const snap = await probe.probe();

  assert.equal(snap.studio, null);
  assert.equal(snap.routerResident, 2);
  assert.deepEqual(
    snap.routerEngines.map((e) => e.model).sort(),
    ["h3-studio", "qwen3-embedding"]
  );
});

test("studio clears once it is no longer resident", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = studioFetch().fetch;
  assert.equal((await probe.probe()).studio?.model, "h3-studio");

  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith("/v1/models")) return jsonRes(ROUTER_MODELS);
    if (u.endsWith("/running")) return jsonRes({ running: [] });
    return jsonRes({}, 404);
  };
  probe.lastProbeTime = Date.now() - 2000;
  assert.equal((await probe.probe()).studio, null);
});

test("studio is dropped from the snapshot when the router goes down", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe._fetch = studioFetch().fetch;
  assert.equal((await probe.probe()).studio?.model, "h3-studio");

  probe._fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.equal(snap.available, false);
  assert.equal(snap.studio, null, "a stale studio banner would claim the GPU is held");
});

test("an oversized /running body is refused at 256 KB, not parsed", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const ok = studioFetch().fetch;
  probe._fetch = ok;
  assert.equal((await probe.probe()).studio?.model, "h3-studio");

  // Valid JSON, just too big: an uncapped res.json() would accept it.
  probe._fetch = async (url, opts) => {
    if (!String(url).endsWith("/running")) return ok(url, opts);
    const body = await (await ok(url, opts)).json();
    return new Response(JSON.stringify({ ...body, pad: "x".repeat(400 * 1024) }));
  };
  probe.lastProbeTime = Date.now() - 2000;
  const snap = await probe.probe();

  assert.equal(snap.available, false);
  assert.equal(snap.studio, null);
});

test("the router API key never reaches the studio origin", async () => {
  const probe = new LlmProbe({ isLocal: true, llmApiKeys: { 11434: "sk-router-secret" } }, 11434);
  const inner = studioFetch().fetch;
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return inner(url);
  };
  try {
    await probe.probe();
  } finally {
    globalThis.fetch = realFetch;
  }

  const auth = (r) => new Headers(r.init?.headers).get("authorization");
  const studio = seen.filter((r) => r.url.startsWith("http://127.0.0.1:8189/"));
  assert.equal(studio.length, 1, "detection ran");
  assert.equal(auth(studio[0]), null, "no Authorization header to the studio");
  const router = seen.find((r) => r.url.endsWith(":11434/running"));
  assert.equal(auth(router), "Bearer sk-router-secret", "the router itself is still authenticated");
  assert.ok(
    seen.every((r) => r.init?.redirect === "manual"),
    "no probe request follows redirects"
  );
});

test("a 302 from /running is a failure, not a hop to another URL", async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(302, { Location: "/redirected-elsewhere" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const probe = new LlmProbe({ isLocal: true }, server.address().port);
    const snap = await probe.probe();

    assert.equal(snap.available, false);
    assert.ok(hits.length > 0, "the probe did talk to the server");
    assert.ok(
      !hits.includes("/redirected-elsewhere"),
      `redirect target must not be requested; hits: ${hits.join(", ")}`
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
