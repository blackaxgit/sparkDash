import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  VideoStudioProbe,
  summarizeVideoGraph,
  jobsFromHistory,
  hourlyBuckets,
  estimateProgress,
  recentSuccessDurations,
  inferStartedAt,
  parseInflightSnapshot,
} from "../VideoStudioProbe.js";
import { resetComfyDetectCache, isKnownComfyModel } from "../comfyDetect.js";

beforeEach(() => resetComfyDetectCache());

// ─── fixtures ───────────────────────────────────────────────

const H3_GRAPH = {
  unet: { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va_pruned_bf16.safetensors", weight_dtype: "default" } },
  clip: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax" } },
  vvae: { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
  avae: { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
  lora: {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["unet", 0], lora_name: "loras/sub/minimax_h3_turbo.safetensors", strength_model: 1.0 },
  },
  lora2: {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["lora", 0], lora_name: "minimax_h3_turbo.safetensors", strength_model: 0.5 },
  },
  r2v: {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: { clip: ["clip", 0], prompt: "x", width: 1344, height: 768, length: 141 },
  },
  sampler: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  sched: { class_type: "BasicScheduler", inputs: { scheduler: "simple", steps: 8, denoise: 1.0 } },
  ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "dir\\base.ckpt" } },
  te: { class_type: "FooTextEncoder", inputs: { clip_name: "te.safetensors" } },
};

const T = Date.UTC(2026, 9, 2, 5, 30, 0); // 05:30 UTC
const MIN = 60_000;

/** @param {string} id @param {number} start @param {number} end */
function successEntry(id, start, end, extraOutputs = {}) {
  return {
    prompt: [1, id, {}, { client_id: "igk-runner" }, []],
    outputs: extraOutputs,
    status: {
      status_str: "success",
      completed: true,
      messages: [
        ["execution_start", { prompt_id: id, timestamp: start }],
        ["execution_cached", { nodes: [], prompt_id: id, timestamp: start + 4 }],
        ["execution_success", { prompt_id: id, timestamp: end }],
      ],
    },
  };
}

const FRAMES = Array.from({ length: 30 }, (_, i) => ({
  filename: `f_${i}_.png`,
  subfolder: "igk/a",
  type: "output",
}));

const HISTORY = {
  // oldest first, the way ComfyUI returns it
  oldOk: successEntry("oldOk", T - 100 * MIN, T - 80 * MIN, {
    save_mp4: { images: [{ filename: "v_00001.mp4", subfolder: "igk/a", type: "output" }], animated: [true] },
    save_flac: { audio: [{ filename: "a_00001.flac", subfolder: "igk/a", type: "output" }] },
    save_png: { images: FRAMES },
  }),
  failed: {
    prompt: [2, "failed", {}, { client_id: "other" }, []],
    outputs: {},
    status: {
      status_str: "error",
      completed: false,
      messages: [
        ["execution_start", { timestamp: T - 70 * MIN }],
        ["execution_error", { timestamp: T - 68 * MIN }],
      ],
    },
  },
  stopped: {
    prompt: [3, "stopped", {}, {}, []],
    outputs: {},
    status: {
      status_str: "error",
      completed: false,
      messages: [
        ["execution_start", { timestamp: T - 60 * MIN }],
        ["execution_interrupted", { timestamp: T - 59 * MIN }],
      ],
    },
  },
  newOk: successEntry("newOk", T - 50 * MIN, T - 30 * MIN),
};

// ─── summarizeVideoGraph ────────────────────────────────────

test("summarizeVideoGraph buckets models by loader class and reads the footprint", () => {
  const s = summarizeVideoGraph(H3_GRAPH);
  assert.deepEqual(s.models.diffusion, [
    "minimax_h3_ref2va_pruned_bf16.safetensors",
    "base.ckpt",
  ]);
  assert.deepEqual(s.models.textEncoders, [
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "te.safetensors",
  ]);
  assert.deepEqual(s.models.vae, [
    "minimax_h3_video_vae_fp16.safetensors",
    "minimax_h3_audio_vae_fp32.safetensors",
  ]);
  // path stripped to basename, and the duplicate collapsed
  assert.deepEqual(s.models.loras, ["minimax_h3_turbo.safetensors"]);
  assert.equal(s.frames, 141);
  assert.equal(s.width, 1344);
  assert.equal(s.height, 768);
  assert.equal(s.steps, 8);
});

test("summarizeVideoGraph tolerates junk and finds frame counts under other names", () => {
  const empty = summarizeVideoGraph(null);
  assert.deepEqual(empty.models, { diffusion: [], textEncoders: [], vae: [], loras: [] });
  assert.equal(empty.frames, null);
  assert.equal(
    summarizeVideoGraph({ a: { class_type: "X", inputs: { num_frames: "97" } } }).frames,
    97
  );
});

// ─── jobsFromHistory ────────────────────────────────────────

test("jobsFromHistory derives durations, statuses and output kinds, newest first", () => {
  const jobs = jobsFromHistory(HISTORY);
  assert.deepEqual(
    jobs.map((j) => j.promptId),
    ["newOk", "stopped", "failed", "oldOk"]
  );

  const newOk = jobs[0];
  assert.equal(newOk.status, "success");
  assert.equal(newOk.startedAt, T - 50 * MIN);
  assert.equal(newOk.endedAt, T - 30 * MIN);
  assert.equal(newOk.durationMs, 20 * MIN);
  assert.equal(newOk.clientId, "igk-runner");

  assert.equal(jobs[1].status, "interrupted");
  assert.equal(jobs[1].durationMs, 1 * MIN);
  assert.equal(jobs[2].status, "error");
  assert.equal(jobs[2].durationMs, 2 * MIN);
  assert.equal(jobs[2].clientId, "other");
  assert.equal(jobs[1].clientId, null);

  const outputs = jobs[3].outputs;
  // 1 mp4 + 1 flac + 30 PNG frames, capped, videos first then audio then images
  assert.equal(outputs.length, 8);
  assert.deepEqual(
    outputs.slice(0, 3).map((o) => [o.filename, o.kind]),
    [
      ["v_00001.mp4", "video"],
      ["a_00001.flac", "audio"],
      ["f_0_.png", "image"],
    ]
  );
  assert.equal(outputs[0].subfolder, "igk/a");
});

test("jobsFromHistory: unfinished or malformed entries do not crash", () => {
  assert.deepEqual(jobsFromHistory(null), []);
  assert.deepEqual(jobsFromHistory([]), []);
  const [j] = jobsFromHistory({ p: { prompt: [], outputs: null, status: {} }, q: 5 });
  assert.equal(j.status, "unknown");
  assert.equal(j.durationMs, null);
  assert.deepEqual(j.outputs, []);
  const long = "x".repeat(500);
  const [k] = jobsFromHistory({
    p: { outputs: { n: { images: [{ filename: long + ".png", subfolder: "" }] } }, status: {} },
  });
  assert.equal(k.outputs[0].filename.length, 200);
});

// ─── hourlyBuckets ──────────────────────────────────────────

test("hourlyBuckets: 24 buckets, current hour last, busy time split, renders in END hour", () => {
  const jobs = [
    // 03:50 -> 04:10 straddles the 04:00 boundary: 10 min in 03:00, 10 min in 04:00,
    // and the render itself is counted in the END hour (04:00)
    {
      status: "success",
      startedAt: Date.UTC(2026, 9, 2, 3, 50),
      endedAt: Date.UTC(2026, 9, 2, 4, 10),
      durationMs: 20 * MIN,
    },
    // failed job without startedAt: start derived from durationMs (04:45 -> 04:50)
    { status: "error", endedAt: Date.UTC(2026, 9, 2, 4, 50), durationMs: 5 * MIN },
    { status: "success", endedAt: Date.UTC(2026, 9, 2, 5, 10), durationMs: 10 * MIN },
    // older than 24 h and a future job: both outside the window
    { status: "success", endedAt: T - 30 * 3_600_000, durationMs: 99 * MIN },
    { status: "success", endedAt: T + 2 * 3_600_000, durationMs: 99 * MIN },
    { status: "unknown", endedAt: null, durationMs: null },
  ];
  const b = hourlyBuckets(jobs, T);
  assert.equal(b.length, 24);
  assert.equal(b[23].hourStart, Date.UTC(2026, 9, 2, 5));
  assert.equal(b[0].hourStart, Date.UTC(2026, 9, 1, 6));
  for (let i = 1; i < 24; i++) assert.equal(b[i].hourStart - b[i - 1].hourStart, 3_600_000);
  assert.deepEqual(b[23], { hourStart: Date.UTC(2026, 9, 2, 5), renders: 1, busyMs: 10 * MIN });
  assert.deepEqual(b[22], { hourStart: Date.UTC(2026, 9, 2, 4), renders: 1, busyMs: 15 * MIN });
  assert.deepEqual(b[21], { hourStart: Date.UTC(2026, 9, 2, 3), renders: 0, busyMs: 10 * MIN });
  assert.equal(b.reduce((n, x) => n + x.renders, 0), 2);
  assert.equal(b[3].renders + b[3].busyMs, 0);
});

test("hourlyBuckets: a render spanning several hours never exceeds an hour per bucket", () => {
  // 02:30 -> 04:30 = 120 min: 30 + 60 + 30
  const b = hourlyBuckets(
    [
      {
        status: "success",
        startedAt: Date.UTC(2026, 9, 2, 2, 30),
        endedAt: Date.UTC(2026, 9, 2, 4, 30),
        durationMs: 120 * MIN,
      },
    ],
    T
  );
  assert.deepEqual(
    b.slice(20, 23).map((x) => [x.renders, x.busyMs]),
    [
      [0, 30 * MIN],
      [0, 60 * MIN],
      [1, 30 * MIN],
    ]
  );
  assert.ok(b.every((x) => x.busyMs <= 3_600_000));
  assert.equal(b.reduce((n, x) => n + x.busyMs, 0), 120 * MIN);
  // a job that began before the window still contributes its in-window part
  const edge = hourlyBuckets(
    [{ status: "success", startedAt: b[0].hourStart - 20 * MIN, endedAt: b[0].hourStart + 10 * MIN, durationMs: 30 * MIN }],
    T
  );
  assert.deepEqual(edge[0], { hourStart: b[0].hourStart, renders: 1, busyMs: 10 * MIN });
});

// ─── estimateProgress ───────────────────────────────────────

test("estimateProgress: null without history, median-based, capped at 99", () => {
  assert.deepEqual(estimateProgress(1000, 61_000, []), {
    elapsedMs: 60_000,
    etaMs: null,
    percent: null,
  });
  // median of [100s, 300s, 200s] = 200s; 50 s elapsed -> 25 %
  assert.deepEqual(estimateProgress(0, 50_000, [100_000, 300_000, 200_000]), {
    elapsedMs: 50_000,
    etaMs: 150_000,
    percent: 25,
  });
  // even count averages the middle pair
  assert.equal(estimateProgress(0, 0, [100_000, 200_000]).etaMs, 150_000);
  // overrunning job: never 100 %, no negative ETA
  assert.deepEqual(estimateProgress(0, 900_000, [100_000]), {
    elapsedMs: 900_000,
    etaMs: 0,
    percent: 99,
  });
  // clock skew: a start in the future clamps to zero elapsed
  assert.equal(estimateProgress(5000, 1000, [100_000]).elapsedMs, 0);
});

test("recentSuccessDurations: newest 8 successful jobs with a duration", () => {
  const jobs = [
    { status: "error", durationMs: 5 },
    ...Array.from({ length: 10 }, (_, i) => ({ status: "success", durationMs: 100 + i })),
  ];
  jobs.splice(3, 0, { status: "success", durationMs: null });
  const d = recentSuccessDurations(jobs);
  assert.equal(d.length, 8);
  assert.deepEqual(d.slice(0, 3), [100, 101, 102]);
});

test("inferStartedAt: later of queue time and previous job end, never in the future", () => {
  assert.equal(inferStartedAt({ firstSeen: 1000, createTime: 400, lastEndedAt: 700 }), 700);
  assert.equal(inferStartedAt({ firstSeen: 1000, createTime: 900, lastEndedAt: 700 }), 900);
  assert.equal(inferStartedAt({ firstSeen: 1000, createTime: null, lastEndedAt: null }), 1000);
  assert.equal(inferStartedAt({ firstSeen: 1000, createTime: 5000, lastEndedAt: null }), 1000);
});

// ─── parseInflightSnapshot ──────────────────────────────────

/** @param {object} outer */
const dataLine = (outer) => `event:message\ndata:${JSON.stringify(outer)}\n\n`;
/** @param {object[]} requests */
const snapshotEvent = (requests) =>
  dataLine({ type: "inflight", data: JSON.stringify({ operation: "snapshot", requests }) });

test("parseInflightSnapshot counts requests for models that are not being served", () => {
  const sse =
    dataLine({ type: "logData", data: '{"data":"noise"}' }) +
    dataLine({ type: "inflight", data: JSON.stringify({ operation: "upsert", request: { model: "x", req_path: "/v1/a", elapsed_ms: 1 } }) }) +
    snapshotEvent([
      {
        id: "1",
        model: "qwen38-flash-next",
        req_path: "/v1/chat/completions",
        method: "POST",
        req_headers: { Authorization: "Bearer SECRET", "User-Agent": "omp/18" },
        remote_ip: "192.168.0.204",
        elapsed_ms: 21_536_000,
      },
      { id: "2", model: "qwen38-flash-next", req_path: "/v1/chat/completions", elapsed_ms: 900 },
      { id: "3", model: "ornith-35b", req_path: "/v1/completions", elapsed_ms: 50 },
      // the studio itself and a resident, serving embedder are not blocked
      { id: "4", model: "h3-studio", req_path: "/v1/anything", elapsed_ms: 99_999_999 },
      { id: "5", model: "qwen3-embedding", req_path: "/v1/embeddings", elapsed_ms: 99_999_999 },
      // the path does not matter: a non-/v1 route for an unloaded model still waits
      { id: "6", model: "ornith-35b", req_path: "/completion", elapsed_ms: 70 },
    ]);
  const r = parseInflightSnapshot(sse, new Set(["h3-studio", "qwen3-embedding"]));
  assert.deepEqual(r, {
    waiting: 4,
    oldestMs: 21_536_000,
    models: ["qwen38-flash-next", "ornith-35b"],
  });
  const dump = JSON.stringify(r);
  assert.ok(!/SECRET|Authorization|192\.168|User-Agent|remote_ip|req_headers/.test(dump));
});

test("parseInflightSnapshot: empty snapshot, no snapshot, and malformed lines", () => {
  assert.deepEqual(parseInflightSnapshot(snapshotEvent([])), {
    waiting: 0,
    oldestMs: null,
    models: [],
  });
  assert.equal(parseInflightSnapshot(dataLine({ type: "logData", data: "x" })), null);
  assert.equal(parseInflightSnapshot('data:{"type":"inflight","data":"not json'), null);
  assert.equal(parseInflightSnapshot(""), null);
  // object-valued data is accepted too
  const sse = dataLine({
    type: "inflight",
    data: { operation: "snapshot", requests: [{ model: "m", req_path: "/v1/x", elapsed_ms: "7" }] },
  });
  assert.deepEqual(parseInflightSnapshot(sse), { waiting: 1, oldestMs: 7, models: ["m"] });
});

// ─── probe with a fake fetch ────────────────────────────────

const SWAP = "http://127.0.0.1:11434";
const COMFY = "http://127.0.0.1:8189";

const RUNNING_WITH_STUDIO = {
  running: [
    {
      model: "h3-studio",
      state: "ready",
      proxy: COMFY,
      name: "MiniMax H3 video studio (ComfyUI)",
      description: "ComfyUI 0.37 native MiniMax H3 nodes",
    },
    { model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8001", name: "Qwen3-Embedding-4B" },
  ],
};
const RUNNING_WITHOUT_STUDIO = {
  running: [{ model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8001" }],
};

const QUEUE = {
  queue_running: [[25, "run-1", H3_GRAPH, { client_id: "igk-runner", create_time: T - 1 * MIN }, ["save_mp4"]]],
  queue_pending: [
    [27, "pend-2", {}, { client_id: "igk-runner", create_time: T - 20_000 }, []],
    [26, "pend-1", {}, { client_id: "igk-runner", create_time: T - 40_000 }, []],
  ],
};

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Fake llama-swap + ComfyUI. `state.running` is swapped between polls.
 * The SSE body never closes, so only the probe aborting it ends the read.
 */
function makeFetch(state) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      redirect: init.redirect,
    });
    if (u === `${SWAP}/running`) return state.runningResponse ? state.runningResponse() : jsonRes(state.running);
    if (u === `${COMFY}/system_stats`) {
      if (state.comfyStatsDown) throw new Error("connect ECONNREFUSED");
      return jsonRes({ system: { comfyui_version: "0.37.2" } });
    }
    if (u.endsWith(":8001/system_stats")) return new Response("nope", { status: 404 });
    if (u === `${COMFY}/queue`) {
      return state.queueResponse ? state.queueResponse() : jsonRes(state.queue ?? QUEUE);
    }
    if (u === `${COMFY}/history?max_items=200`) return jsonRes(HISTORY);
    if (u === `${SWAP}/api/events`) {
      const enc = new TextEncoder();
      const text =
        dataLine({ type: "logData", data: "noise" }) +
        snapshotEvent(
          state.requests ?? [
            {
              id: "9",
              model: "qwen38-flash-next",
              req_path: "/v1/chat/completions",
              req_headers: { Authorization: "Bearer SECRET" },
              remote_ip: "10.1.2.3",
              elapsed_ms: 4321,
            },
            { id: "10", model: "h3-studio", req_path: "/v1/x", elapsed_ms: 1 },
          ]
        );
      state.eventsCancelled = false;
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(text.slice(0, 40)));
          c.enqueue(enc.encode(text.slice(40)));
        },
        cancel() {
          state.eventsCancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, calls };
}

test("probe: resident ready studio populates metrics.video", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  const { fetchImpl, calls } = makeFetch(state);
  const probe = new VideoStudioProbe(
    { isLocal: true, llmApiKeys: { 11434: "tok" } },
    { routerPorts: () => [11434], fetchImpl, now: () => T }
  );
  const v = await probe.probe();

  assert.equal(v.available, true);
  assert.equal(v.error, undefined);
  assert.deepEqual(v.studio, {
    model: "h3-studio",
    name: "MiniMax H3 video studio (ComfyUI)",
    description: "ComfyUI 0.37 native MiniMax H3 nodes",
    port: 8189,
    comfyVersion: "0.37.2",
    state: "ready",
  });
  assert.equal(v.queueRunning, 1);
  assert.equal(v.queuePending, 2);

  // active: started at max(create_time, previous end) = T - 1 min; median success = 20 min
  assert.equal(v.active.promptId, "run-1");
  assert.equal(v.active.clientId, "igk-runner");
  assert.equal(v.active.startedAt, T - 1 * MIN);
  assert.equal(v.active.elapsedMs, 1 * MIN);
  assert.equal(v.active.percent, 5);
  assert.equal(v.active.etaMs, 19 * MIN);
  assert.equal(v.active.frames, 141);
  assert.equal(v.active.width, 1344);
  assert.equal(v.active.steps, 8);
  assert.deepEqual(v.active.models.diffusion, [
    "minimax_h3_ref2va_pruned_bf16.safetensors",
    "base.ckpt",
  ]);

  // pending ordered by queue number
  assert.deepEqual(
    v.pending.map((p) => p.promptId),
    ["pend-1", "pend-2"]
  );
  assert.equal(v.pending[0].queuedAt, T - 40_000);

  assert.deepEqual(
    v.recent.map((r) => r.promptId),
    ["newOk", "stopped", "failed", "oldOk"]
  );
  assert.equal(v.hourly.length, 24);
  assert.equal(v.hourly[23].hourStart, Date.UTC(2026, 9, 2, 5));
  assert.equal(v.updatedAt, T);

  // llmWait excludes the studio's own request and exposes only a count/age/model names
  assert.deepEqual(v.llmWait, { waiting: 1, oldestMs: 4321, models: ["qwen38-flash-next"] });
  assert.ok(!/SECRET|10\.1\.2\.3/.test(JSON.stringify(v)));
  assert.equal(state.eventsCancelled, true, "the SSE connection was cancelled");

  // safety: GET only, never an /upstream/ path, the key only goes to llama-swap
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.ok(calls.every((c) => !c.url.includes("/upstream/")));
  for (const c of calls) {
    const auth = c.headers.Authorization;
    assert.equal(auth != null, c.url.startsWith(SWAP), `auth header scope for ${c.url}`);
  }
  probe.dispose();
});

test("probe: studio gone -> state 'unloaded', last jobs kept, no more ComfyUI traffic", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  const { fetchImpl, calls } = makeFetch(state);
  let now = T;
  const probe = new VideoStudioProbe(
    { isLocal: true },
    { routerPorts: () => [11434], fetchImpl, now: () => now }
  );
  await probe.probe();

  state.running = RUNNING_WITHOUT_STUDIO;
  now = T + 3000;
  const comfyCallsBefore = calls.filter((c) => c.url.startsWith(COMFY)).length;
  const v = await probe.probe();

  assert.equal(v.available, true);
  assert.equal(v.studio.model, "h3-studio");
  assert.equal(v.studio.state, "unloaded");
  assert.equal(v.active, null);
  assert.equal(v.queueRunning, 0);
  assert.equal(v.queuePending, 0);
  assert.deepEqual(v.pending, []);
  assert.equal(v.recent.length, 4);
  assert.equal(v.hourly.length, 24);
  assert.equal(v.hourly[23].hourStart, Date.UTC(2026, 9, 2, 5));
  assert.equal(calls.filter((c) => c.url.startsWith(COMFY)).length, comfyCallsBefore);
  probe.dispose();
});

test("probe: before any studio is seen it is unavailable; no router means null", async () => {
  const state = { running: RUNNING_WITHOUT_STUDIO };
  const { fetchImpl } = makeFetch(state);
  const probe = new VideoStudioProbe(
    { isLocal: true },
    { routerPorts: () => [11434], fetchImpl, now: () => T }
  );
  const v = await probe.probe();
  assert.equal(v.available, false);
  assert.equal(v.studio, null);
  assert.equal(v.llmWait, null);
  assert.equal(v.hourly.length, 24);

  const none = new VideoStudioProbe({ isLocal: true }, { routerPorts: () => [], fetchImpl });
  assert.equal(await none.probe(), null);
});

test("probe: an unreachable router never throws, keeps the last studio, and reports an error", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  const { fetchImpl } = makeFetch(state);
  let down = false;
  const flaky = (url, init) => {
    if (down) return Promise.reject(new Error("connect ECONNREFUSED"));
    return fetchImpl(url, init);
  };
  const probe = new VideoStudioProbe(
    { isLocal: true },
    { routerPorts: () => [11434], fetchImpl: flaky, now: () => T }
  );
  await probe.probe();
  down = true;
  const v = await probe.probe();
  assert.equal(v.available, false);
  assert.match(v.error, /ECONNREFUSED/);
  assert.equal(v.studio.state, "unloaded");
  assert.equal(v.recent.length, 4);
  probe.dispose();
});

test("probe: /api/events failure gives llmWait null while the rest still works", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  const { fetchImpl } = makeFetch(state);
  const noEvents = (url, init) =>
    String(url).endsWith("/api/events")
      ? Promise.resolve(new Response("no", { status: 500 }))
      : fetchImpl(url, init);
  const probe = new VideoStudioProbe(
    { isLocal: true },
    { routerPorts: () => [11434], fetchImpl: noEvents, now: () => T }
  );
  const v = await probe.probe();
  assert.equal(v.llmWait, null);
  assert.equal(v.studio.state, "ready");
  assert.equal(v.queueRunning, 1);
  probe.dispose();
});

test("probe: history is refetched only every 30 s or when the running prompt changes", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  const { fetchImpl, calls } = makeFetch(state);
  let now = T;
  const probe = new VideoStudioProbe(
    { isLocal: true },
    { routerPorts: () => [11434], fetchImpl, now: () => now }
  );
  const historyCalls = () => calls.filter((c) => c.url.includes("/history")).length;
  const eventsCalls = () => calls.filter((c) => c.url.endsWith("/api/events")).length;
  await probe.probe();
  assert.equal(historyCalls(), 1);
  assert.equal(eventsCalls(), 1);

  now = T + 3000;
  await probe.probe();
  assert.equal(historyCalls(), 1);
  assert.equal(eventsCalls(), 1);

  state.queue = {
    queue_running: [[28, "run-2", H3_GRAPH, { client_id: "igk-runner" }, []]],
    queue_pending: [],
  };
  now = T + 6000;
  const v = await probe.probe();
  assert.equal(historyCalls(), 2);
  assert.equal(v.active.promptId, "run-2");

  now = T + 12_000;
  await probe.probe();
  assert.equal(eventsCalls(), 2);
  probe.dispose();
});

test("hasJob: running, pending and unknown prompts", async () => {
  const { probe } = newProbe({ running: RUNNING_WITH_STUDIO });
  assert.equal(probe.hasJob("run-1"), null, "nothing known before the first poll");
  await probe.probe();
  assert.equal(probe.hasJob("run-1"), "running");
  assert.equal(probe.hasJob("pend-1"), "pending");
  assert.equal(probe.hasJob("pend-2"), "pending");
  assert.equal(probe.hasJob("newOk"), null, "a finished job is not in the queue");
  assert.equal(probe.hasJob(""), null);
  assert.equal(probe.hasJob(undefined), null);
  probe.dispose();
});

test("studioPort: set while the studio is ready, null once it leaves /running", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  const { fetchImpl } = makeFetch(state);
  let now = T;
  const probe = new VideoStudioProbe(
    { isLocal: true },
    { routerPorts: () => [11434], fetchImpl, now: () => now }
  );
  assert.equal(probe.studioPort(), null, "null before the first poll");
  await probe.probe();
  assert.equal(probe.studioPort(), 8189);

  state.running = RUNNING_WITHOUT_STUDIO;
  now = T + 3000;
  await probe.probe();
  assert.equal(probe.studioPort(), null);
  assert.equal(probe.hasJob("run-1"), null, "live queue is dropped with the studio");
  probe.dispose();
});

test("studioPort: null while the studio is restarting (loading)", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  let now = T;
  const { probe } = newProbe(state, () => now);
  await probe.probe();
  assert.equal(probe.studioPort(), 8189);

  state.running = {
    running: [{ model: "h3-studio", state: "starting", proxy: COMFY, name: "MiniMax H3 video studio (ComfyUI)" }],
  };
  state.comfyStatsDown = true;
  now = T + 3000;
  const v = await probe.probe();
  assert.equal(v.studio.state, "loading");
  assert.equal(probe.studioPort(), null);
  probe.dispose();
});

// ─── llmWait rules ──────────────────────────────────────────

const RUNNING_LLM_SERVING = {
  running: [
    { model: "qwen38-flash-next", state: "ready", proxy: "http://127.0.0.1:8000", name: "Qwen3.8" },
    { model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8001" },
  ],
};

/** Probe over a fake router; returns helpers to count /api/events calls. */
function newProbe(state, now = () => T) {
  const { fetchImpl, calls } = makeFetch(state);
  const probe = new VideoStudioProbe(
    { isLocal: true },
    { routerPorts: () => [11434], fetchImpl, now }
  );
  const events = () => calls.filter((c) => c.url.endsWith("/api/events")).length;
  return { probe, calls, events };
}

test("llmWait: studio unloaded while the LLM is resident and serving gives null, no /api/events", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  let now = T;
  const { probe, events } = newProbe(state, () => now);
  const first = await probe.probe();
  assert.ok(first.llmWait);
  assert.equal(events(), 1);

  // the studio is gone, the chat model is back and serving its own requests
  state.running = RUNNING_LLM_SERVING;
  state.requests = [
    { id: "1", model: "qwen38-flash-next", req_path: "/v1/chat/completions", elapsed_ms: 8000 },
    { id: "2", model: "qwen3-embedding", req_path: "/v1/embeddings", elapsed_ms: 5 },
  ];
  now = T + 60_000;
  const v = await probe.probe();
  assert.equal(v.studio.state, "unloaded");
  assert.equal(v.llmWait, null);
  assert.equal(events(), 1, "/api/events is not opened without a resident studio");
  probe.dispose();
});

test("llmWait: an unreachable router clears the last waiting count instead of replaying it", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  let now = T;
  const { probe } = newProbe(state, () => now);
  const first = await probe.probe();
  assert.ok(first.llmWait, "a waiting count while the studio is resident");

  state.runningResponse = () => new Response("bad gateway", { status: 502 });
  now = T + 3000;
  const v = await probe.probe();
  assert.equal(v.available, false);
  assert.equal(v.llmWait, null);
  probe.dispose();
});

test("llmWait: only requests for models that are not ready residents are counted", async () => {
  const state = {
    running: RUNNING_WITH_STUDIO, // h3-studio + qwen3-embedding resident; the LLM is unloaded
    requests: [
      // the resident embedder is being served
      { id: "1", model: "qwen3-embedding", req_path: "/v1/embeddings", elapsed_ms: 99_000 },
      // the unloaded LLM is blocked
      { id: "2", model: "qwen38-flash-next", req_path: "/v1/chat/completions", elapsed_ms: 30_000 },
      // a non-/v1 path for an unloaded model is blocked as well
      { id: "3", model: "ornith-35b", req_path: "/completion", elapsed_ms: 40_000 },
      // the studio's own traffic is never a wait
      { id: "4", model: "h3-studio", req_path: "/v1/x", elapsed_ms: 500_000 },
    ],
  };
  const { probe } = newProbe(state);
  const v = await probe.probe();
  assert.deepEqual(v.llmWait, {
    waiting: 2,
    oldestMs: 40_000,
    models: ["qwen38-flash-next", "ornith-35b"],
  });
  probe.dispose();
});

// ─── safety: redirects, body caps ───────────────────────────

test("probe: every request is redirect:'manual' and a 302 from /queue is not followed", async () => {
  const state = {
    running: RUNNING_WITH_STUDIO,
    queueResponse: () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
  };
  const { probe, calls } = newProbe(state);
  const v = await probe.probe();
  assert.match(v.error, /queue: HTTP 302/);
  assert.equal(v.studio.state, "ready");
  assert.equal(v.active, null);
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((c) => c.redirect === "manual"), "all fetches use redirect: manual");
  assert.ok(calls.every((c) => !c.url.includes("169.254")));
  probe.dispose();
});

test("probe: an oversized body sets error, stops reading, and never throws", async () => {
  let cancelled = false;
  let sent = 0;
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(c) {
          sent += 64 * 1024;
          c.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
        cancel() {
          cancelled = true;
        },
      })
    );
  const state = { running: RUNNING_WITH_STUDIO, queueResponse: endless };
  const { probe } = newProbe(state);
  const v = await probe.probe();
  assert.match(v.error, /queue: response over 2097152 bytes/);
  assert.equal(cancelled, true, "the stream was cancelled at the cap");
  assert.ok(sent < 4 * 1024 * 1024, `read stopped near the cap, read ${sent}`);
  assert.equal(v.available, true);
  assert.equal(v.queueRunning, 0);

  // /running over its 256 KB cap: the router is treated as unreachable, no throw
  const huge = { running: RUNNING_WITH_STUDIO, runningResponse: () => new Response("x".repeat(300 * 1024)) };
  const { probe: p2 } = newProbe(huge);
  const r = await p2.probe();
  assert.equal(r.available, false);
  assert.match(r.error, /llama-swap: response over 262144 bytes/);
  probe.dispose();
  p2.dispose();
});

// ─── loading studio ─────────────────────────────────────────

test("probe: a starting row is a 'loading' studio once the name was seen as ComfyUI", async () => {
  const state = { running: RUNNING_WITH_STUDIO };
  let now = T;
  const { probe, calls } = newProbe(state, () => now);
  await probe.probe();
  assert.equal(isKnownComfyModel(COMFY, "h3-studio"), true);

  // the studio restarts: llama-swap reports it as "starting", its /system_stats is down
  state.running = {
    running: [{ model: "h3-studio", state: "starting", proxy: COMFY, name: "MiniMax H3 video studio (ComfyUI)" }],
  };
  state.comfyStatsDown = true;
  now = T + 3000;
  const comfyBefore = calls.filter((c) => c.url.startsWith(COMFY)).length;
  const v = await probe.probe();
  assert.equal(v.studio.state, "loading");
  assert.equal(v.studio.comfyVersion, "0.37.2");
  assert.equal(v.active, null);
  assert.equal(v.queueRunning, 0);
  assert.equal(v.recent.length, 4, "last renders are kept while loading");
  assert.equal(calls.filter((c) => c.url.startsWith(COMFY)).length, comfyBefore);
  probe.dispose();
});

test("probe: a starting row with an unknown name is not a studio", async () => {
  const state = {
    running: { running: [{ model: "h3-studio", state: "starting", proxy: COMFY }] },
    comfyStatsDown: true,
  };
  const { probe } = newProbe(state);
  const v = await probe.probe();
  assert.equal(v.available, false);
  assert.equal(v.studio, null);
  assert.equal(v.llmWait, null);
  probe.dispose();
});

test("probe: the studio model-name set is bounded", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    model: `studio-${i}`,
    state: "ready",
    proxy: `http://127.0.0.1:${9000 + i}`,
  }));
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/running")) return jsonRes({ running: rows });
    if (u.endsWith("/system_stats")) return jsonRes({ system: { comfyui_version: "0.37.2" } });
    if (u.endsWith("/queue")) return jsonRes({ queue_running: [], queue_pending: [] });
    if (u.includes("/history")) return jsonRes({});
    return new Response("", { status: 404 });
  };
  const probe = new VideoStudioProbe({ isLocal: true }, { routerPorts: () => [11434], fetchImpl, now: () => T });
  await probe.probe();
  assert.equal(probe._studioModels.size, 16);
  probe.dispose();
});
