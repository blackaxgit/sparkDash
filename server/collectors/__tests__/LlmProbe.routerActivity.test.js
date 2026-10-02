/**
 * llama-swap router observability: model state events, request outcomes from the
 * activity log, the configured-model list, per-engine prompt rate and the
 * unload/load actions.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import {
  diffRouterRows,
  buildRouterActivity,
  parseRouterModels,
  promptTokensFromMetrics,
} from "../swapRouter.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function textRes(txt, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => txt };
}

function vllmMetrics({ start, prompt = 0, gen = 0 }) {
  return `process_start_time_seconds ${start}
vllm:prompt_tokens_total{engine="0",model_name="a"} ${prompt}.0
vllm:prompt_tokens_total{engine="0",model_name="b"} 1.0
vllm:prompt_tokens_cached_total{engine="0"} 999.0
vllm:generation_tokens_total{engine="0"} ${gen}.0
`;
}

const row = (model, state = "ready", proxy = null) => ({ model, state, proxy, name: null, description: null });

// ─── events ─────────────────────────────────────────────

test("events: first poll seeds state without emitting", () => {
  const first = diffRouterRows(null, [row("a"), row("h3-studio", "starting")], 1000, []);
  assert.deepEqual(first.events, []);
  // …and the next identical poll is still quiet.
  const second = diffRouterRows(first.state, [row("a"), row("h3-studio", "starting")], 2000, first.events);
  assert.deepEqual(second.events, []);
});

test("events: loading → ready carries loadMs; stopping and disappearing emit one stopped", () => {
  let s = diffRouterRows(new Map(), [], 0, []); // seeded, empty
  s = diffRouterRows(s.state, [row("m", "starting")], 10_000, s.events);
  assert.deepEqual(s.events.map((e) => [e.model, e.state, e.loadMs]), [["m", "loading", null]]);

  s = diffRouterRows(s.state, [row("m", "starting")], 15_000, s.events);
  assert.equal(s.events.length, 1, "a model that keeps loading is not a new event");

  s = diffRouterRows(s.state, [row("m", "ready")], 40_000, s.events);
  assert.deepEqual(
    s.events.map((e) => [e.state, e.loadMs]),
    [
      ["ready", 30_000],
      ["loading", null],
    ],
    "newest first; loadMs spans the first loading sighting to ready"
  );

  s = diffRouterRows(s.state, [row("m", "stopping")], 50_000, s.events);
  assert.equal(s.events[0].state, "stopped");
  s = diffRouterRows(s.state, [], 52_000, s.events);
  assert.equal(s.events.length, 3, "loading, ready, then one stopped — not two");
});

test("events: a model first seen ready, or a seeded loader that turns ready, has no loadMs", () => {
  const seeded = diffRouterRows(null, [row("slow", "starting")], 1000, []);
  const s = diffRouterRows(seeded.state, [row("slow", "ready"), row("new")], 9000, seeded.events);
  const byModel = Object.fromEntries(s.events.map((e) => [e.model, e]));
  assert.equal(byModel.slow.state, "ready");
  assert.equal(byModel.slow.loadMs, null, "the load began before we were watching");
  assert.equal(byModel.new.loadMs, null);
});

test("events: studio rows are tracked and the log is capped at 10, newest first", () => {
  let s = diffRouterRows(null, [], 0, []);
  for (let i = 1; i <= 25; i++) {
    const present = i % 2 === 1;
    s = diffRouterRows(s.state, present ? [row("h3-studio"), row("llm")] : [], i * 1000, s.events);
  }
  assert.equal(s.events.length, 10);
  assert.equal(s.events[0].at, 25_000, "newest first");
  assert.ok(s.events.some((e) => e.model === "h3-studio"));
});

test("probe: events accumulate across polls and the first poll is silent", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  let running = [{ model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8001" }];
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith(":11434/v1/models")) return jsonRes({ data: [{ id: "x", owned_by: "llama-swap" }] });
    if (u.endsWith("/running")) return jsonRes({ running });
    if (u.endsWith(":8001/metrics")) return textRes(vllmMetrics({ start: 1 }));
    return jsonRes({}, 404);
  };
  assert.deepEqual((await probe.probe()).routerEvents, []);

  running = [];
  const snap = await probe.probe();
  assert.deepEqual(
    snap.routerEvents.map((e) => [e.model, e.state]),
    [["qwen3-embedding", "stopped"]]
  );
});

// ─── activity ───────────────────────────────────────────

test("activity: buckets by local hour, rolling last hour, errors newest first", () => {
  const now = new Date(2026, 9, 1, 15, 30, 0).getTime();
  const at = (ms) => new Date(ms).toISOString();
  const rec = (ms, status, extra = {}) => ({
    timestamp: at(ms),
    model: "ornith-35b",
    resp_status_code: status,
    error_msg: "",
    src: "ip:10.0.0.9",
    ...extra,
  });
  const payload = {
    data: [
      rec(now - 20 * MIN, 200), // 15:10, current hour
      rec(now - 25 * MIN, 429, { error_msg: "queue full" }), // 15:05
      rec(now - 50 * MIN, 500, { error_msg: "boom" }), // 14:40, inside the rolling hour
      rec(now - 70 * MIN, 200), // 14:20, previous bucket but outside the rolling hour
      rec(now - 23 * HOUR, 302), // 16:30 yesterday: the oldest bucket
      rec(now - 25 * HOUR, 200), // older than 24 h: ignored
      rec(now - 24 * HOUR, 200), // exactly 24 h: before the oldest bucket, ignored
    ],
  };

  const a = buildRouterActivity(payload, now);

  assert.equal(a.hourly.length, 24);
  assert.equal(a.hourly[23].hourStart, new Date(2026, 9, 1, 15).getTime());
  assert.equal(a.hourly[0].hourStart, a.hourly[23].hourStart - 23 * HOUR);
  assert.deepEqual(a.hourly[23], { hourStart: a.hourly[23].hourStart, ok: 1, rejected: 1, failed: 0 });
  assert.deepEqual(a.hourly[22], { hourStart: a.hourly[22].hourStart, ok: 1, rejected: 0, failed: 1 });
  assert.equal(a.hourly[0].ok, 1, "3xx counts as ok");
  assert.equal(
    a.hourly.reduce((n, h) => n + h.ok + h.rejected + h.failed, 0),
    5,
    "records older than 24 h are not counted"
  );
  assert.deepEqual(a.lastHour, { ok: 1, rejected: 1, failed: 1 });
  assert.deepEqual(
    a.recentErrors.map((e) => [e.status, e.message, e.model, e.src]),
    [
      [429, "queue full", "ornith-35b", "ip:10.0.0.9"],
      [500, "boom", "ornith-35b", "ip:10.0.0.9"],
    ]
  );
  assert.equal(a.recentErrors[0].at, now - 25 * MIN);
  assert.equal(a.updatedAt, now);
});

test("activity: recentErrors keeps the newest five; a non-activity payload is null", () => {
  const now = Date.now();
  const data = Array.from({ length: 8 }, (_, i) => ({
    timestamp: new Date(now - (i + 1) * 1000).toISOString(),
    model: "m",
    resp_status_code: 500,
  }));
  const a = buildRouterActivity({ data }, now);
  assert.equal(a.recentErrors.length, 5);
  assert.equal(a.recentErrors[0].at, now - 1000);
  assert.equal(a.recentErrors[0].message, null);
  assert.equal(buildRouterActivity({ nope: 1 }, now), null);
});

test("activity: a full page is flagged truncated; a short page is not", () => {
  const now = Date.now();
  const rec = (i) => ({ timestamp: new Date(now - i * 1000).toISOString(), model: "m", resp_status_code: 200 });
  const page = (n) => ({ data: Array.from({ length: n }, (_, i) => rec(i + 1)) });
  assert.equal(buildRouterActivity(page(998), now).truncated, false);
  assert.equal(buildRouterActivity(page(999), now).truncated, true);
});

// ─── models ─────────────────────────────────────────────

test("models: aliases and foreign owners are dropped; sorted by id; loaded from status", () => {
  const models = parseRouterModels({
    data: [
      { id: "zeta", name: "Zeta", owned_by: "llama-swap", meta: { llamaswap: { type: "model" } }, status: { value: "loaded" } },
      { id: "embeddings", owned_by: "llama-swap", meta: { llamaswap: { type: "alias", modelID: "qwen3-embedding" } } },
      { id: "alpha", owned_by: "llama-swap", meta: { llamaswap: { type: "model" } }, status: { value: "unloaded" } },
      { id: "peer-model", owned_by: "somebody-else" },
    ],
  });
  assert.deepEqual(models, [
    { id: "alpha", name: null, loaded: false },
    { id: "zeta", name: "Zeta", loaded: true },
  ]);
  assert.equal(parseRouterModels({}), null);
});

test("models: ids that are dot segments are dropped (they would escape the URL path)", () => {
  const m = (id) => ({ id, owned_by: "llama-swap", meta: { llamaswap: { type: "model" } } });
  assert.deepEqual(
    parseRouterModels({ data: [m("."), m(".."), m("..."), m("ok")] }).map((x) => x.id),
    ["...", "ok"]
  );
});

function pollingFetch(state) {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, opts });
      if (u.endsWith("/slots")) return jsonRes({}, 404);
      if (u.endsWith(":11434/v1/models")) {
        return jsonRes({
          data: [
            { id: "ornith-35b", name: "Ornith", owned_by: "llama-swap", meta: { llamaswap: { type: "model" } }, status: { value: "loaded" } },
            { id: "embeddings", owned_by: "llama-swap", meta: { llamaswap: { type: "alias" } } },
          ],
        });
      }
      if (u.endsWith("/running")) return jsonRes({ running: state.running });
      if (u.includes("/api/metrics/activity")) return state.activity();
      if (u.endsWith(":8001/metrics")) return textRes(vllmMetrics({ start: 1, prompt: state.prompt }));
      return jsonRes({}, 404);
    },
  };
}

const EMBEDDER = { model: "qwen3-embedding", state: "ready", proxy: "http://127.0.0.1:8001" };

/** Wait for the background router feeds (activity, models) started by the last probe(). */
const settle = () => new Promise((r) => setImmediate(r));

test("probe: activity and models land in the snapshot, read at most once a minute", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const state = {
    running: [EMBEDDER],
    prompt: 0,
    activity: () =>
      jsonRes({ data: [{ timestamp: new Date().toISOString(), model: "m", resp_status_code: 429, error_msg: "full" }] }),
  };
  const { fetch, calls } = pollingFetch(state);
  probe._fetch = fetch;

  await probe.probe();
  await settle();
  const snap = await probe.probe();
  assert.deepEqual(snap.routerModels, [{ id: "ornith-35b", name: "Ornith", loaded: true }]);
  assert.equal(snap.routerActivity.lastHour.rejected, 1);
  assert.equal(snap.routerActivity.truncated, false);

  const activityCalls = () => calls.filter((c) => c.url.includes("/api/metrics/activity"));
  assert.equal(activityCalls().length, 1);
  const url = new URL(activityCalls()[0].url);
  assert.equal(url.searchParams.get("limit"), "999");
  const start = Date.parse(url.searchParams.get("start"));
  assert.ok(Math.abs(Date.now() - 24 * HOUR - start) < 5000, "start is now − 24 h (RFC 3339)");

  await probe.probe();
  await settle();
  assert.equal(activityCalls().length, 1, "gated to one read per minute");
});

test("probe: the router poll does not wait for a slow activity or models read", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const calls = [];
  let polling = false;
  probe._fetch = (url) => {
    const u = String(url);
    calls.push(u);
    // Backend detection reads /v1/models before the first /running; the router feed's read never answers.
    if (u.endsWith("/running")) polling = true;
    if (u.endsWith(":11434/v1/models") && !polling) {
      return Promise.resolve(jsonRes({ data: [{ id: "x", owned_by: "llama-swap" }] }));
    }
    if (u.includes("/api/metrics/activity") || u.endsWith(":11434/v1/models")) return new Promise(() => {}); // never resolves
    if (u.endsWith("/slots")) return Promise.resolve(jsonRes({}, 404));
    if (u.endsWith("/running")) return Promise.resolve(jsonRes({ running: [EMBEDDER] }));
    if (u.endsWith(":8001/metrics")) return Promise.resolve(textRes(vllmMetrics({ start: 1 })));
    return Promise.resolve(jsonRes({}, 404));
  };
  const timeout = new Promise((r) => setTimeout(() => r("hung"), 3000).unref());
  const snap = await Promise.race([probe.probe(), timeout]);
  assert.notEqual(snap, "hung", "probe() must resolve while the feeds are still pending");
  assert.equal(snap.routerEngines[0].model, "qwen3-embedding");
  assert.equal(snap.routerActivity, null);

  const activityRun = probe._activityRun;
  const modelsRun = probe._modelsRun;
  assert.ok(activityRun && modelsRun, "both feeds are running in the background");
  const before = calls.length;
  probe._activityNextAt = 0;
  probe._modelsNextAt = 0;
  await Promise.race([probe.probe(), timeout]);
  assert.equal(
    calls.slice(before).filter((u) => u.includes("/api/metrics/activity")).length,
    0,
    "a feed still in flight is not started a second time"
  );
  assert.equal(probe._activityRun, activityRun);
  assert.equal(probe._modelsRun, modelsRun);
});

test("probe: a failing activity read keeps the previous value; a 404 stays null and backs off", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const state = { running: [EMBEDDER], prompt: 0, activity: () => jsonRes({ data: [] }) };
  const { fetch } = pollingFetch(state);
  probe._fetch = fetch;
  await probe.probe();
  await settle();
  const first = probe.routerActivity;
  assert.ok(first);

  const warn = console.warn;
  console.warn = () => {};
  try {
    state.activity = () => jsonRes({}, 500);
    probe._activityNextAt = 0;
    await probe.probe();
    await settle();
    assert.equal(probe.routerActivity, first, "previous value survives a failed read");
  } finally {
    console.warn = warn;
  }

  const old = new LlmProbe({ isLocal: true }, 11434);
  const oldState = { running: [EMBEDDER], prompt: 0, activity: () => jsonRes({}, 404) };
  const oldFetch = pollingFetch(oldState);
  old._fetch = oldFetch.fetch;
  await old.probe();
  await settle();
  assert.equal(old.routerActivity, null);
  assert.ok(old._activityNextAt - Date.now() > 5 * MIN, "older llama-swap is not asked every minute");
});

test("probe: a failing feed backs off 1, 2, 4… minutes (cap 10) and logs once per state change", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const state = { running: [EMBEDDER], prompt: 0, activity: () => jsonRes({}, 500) };
  probe._fetch = pollingFetch(state).fetch;
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const waits = [];
    for (let i = 0; i < 6; i++) {
      probe._activityNextAt = 0;
      const before = Date.now();
      await probe.probe();
      await settle();
      waits.push(Math.round((probe._activityNextAt - before) / MIN));
    }
    assert.deepEqual(waits, [1, 2, 4, 8, 10, 10]);
    const failures = warned.filter((l) => l.includes("activity") && l.includes("failing"));
    assert.equal(failures.length, 1, "one line for the whole failing run");
    assert.ok(failures[0].includes("HTTP 500") && failures[0].includes("/api/metrics/activity"));
    assert.ok(!failures[0].includes("start="), "no query string in the log");

    state.activity = () => jsonRes({ data: [] });
    probe._activityNextAt = 0;
    await probe.probe();
    await settle();
    assert.equal(warned.filter((l) => l.includes("activity") && l.includes("recovered")).length, 1);
    assert.ok(probe.routerActivity);
    assert.ok(probe._activityNextAt - Date.now() <= MIN, "success returns to the normal cadence");
  } finally {
    console.warn = warn;
  }
});

// ─── promptTps ──────────────────────────────────────────

test("promptTokensFromMetrics: sums label sets and ignores the cached counter", () => {
  assert.equal(promptTokensFromMetrics(vllmMetrics({ start: 1, prompt: 100 })), 101);
  assert.equal(promptTokensFromMetrics("process_start_time_seconds 1\n"), null);
});

test("engines: an embedder shows promptTps while it embeds", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const state = { running: [EMBEDDER], prompt: 1000, activity: () => jsonRes({ data: [] }) };
  probe._fetch = pollingFetch(state).fetch;
  const idle = await probe.probe();
  assert.equal(idle.routerEngines[0].promptTps, 0, "first sample is a baseline, not a rate");

  for (const st of probe._engineStats.values()) st.at -= 2000;
  state.prompt = 1400; // +400 prompt tokens in 2 s, no generation
  const snap = await probe.probe();
  const e = snap.routerEngines.find((r) => r.model === "qwen3-embedding");
  assert.ok(Math.abs(e.promptTps - 200) < 2, `promptTps ${e.promptTps}`);
  assert.equal(e.generationTps, 0);

  for (const st of probe._engineStats.values()) st.at -= 2000;
  const quiet = await probe.probe();
  assert.equal(quiet.routerEngines[0].promptTps, 0, "rate returns to 0 when the counter stops");
});

// ─── actions ────────────────────────────────────────────

test("routerUnload: authenticated POST to /api/models/unload/{model}", async () => {
  const probe = new LlmProbe({ isLocal: true, llmApiKeys: { 11434: "sekret" } }, 11434);
  const seen = [];
  probe._fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return textRes("OK");
  };
  const out = await probe.routerUnload("org/model x");
  assert.deepEqual(out, { ok: true, status: 200, message: "unloaded" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:11434/api/models/unload/org%2Fmodel%20x");
  assert.equal(seen[0].opts.method, "POST");
  assert.notEqual(seen[0].opts.authenticated, false, "the router key must be sent");
  assert.equal(seen[0].opts.longLived, undefined, "an unload is short-lived");

  probe._fetch = async () => textRes("model not found", 404);
  assert.deepEqual(await probe.routerUnload("nope"), { ok: false, status: 404, message: "model not found" });
  probe._fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.deepEqual(await probe.routerUnload("x"), { ok: false, status: 0, message: "ECONNREFUSED" });
});

test("routerUnload / routerLoad: '.' and '..' are refused without any request", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  let fetched = 0;
  probe._fetch = async () => {
    fetched++;
    return textRes("OK");
  };
  for (const id of [".", ".."]) {
    const out = await probe.routerUnload(id);
    assert.equal(out.ok, false);
    assert.deepEqual(probe.routerLoad(id), { started: false, reason: "invalid" });
  }
  assert.equal(fetched, 0);
  assert.equal(probe._routerLoadInFlight, false, "a refused load does not occupy the slot");
});

test("runningModels: the model names of the last /running rows, [] when not a router", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  assert.deepEqual(probe.runningModels(), []);
  probe._fetch = pollingFetch({ running: [EMBEDDER, { model: "ornith-35b", state: "starting" }], prompt: 0, activity: () => jsonRes({ data: [] }) }).fetch;
  await probe.probe();
  assert.deepEqual(probe.runningModels(), ["qwen3-embedding", "ornith-35b"]);
});

test("routerLoad: GET /upstream/{model}/health, one load in flight, flag cleared after", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const seen = [];
  let release;
  probe._fetch = (url, opts) => {
    seen.push({ url: String(url), opts });
    return new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 200 });
    });
  };
  const log = console.log;
  const logged = [];
  console.log = (...a) => logged.push(a.join(" "));
  try {
    assert.deepEqual(probe.routerLoad("ornith-35b"), { started: true });
    assert.deepEqual(probe.routerLoad("other"), { started: false, reason: "busy" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "http://127.0.0.1:11434/upstream/ornith-35b/health");
    assert.equal(seen[0].opts.longLived, true, "a load blocks until the model is up, so it is exempt from the idle cut");

    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(probe._routerLoadInFlight, false);
    assert.ok(logged.some((l) => l.includes("ornith-35b") && l.includes("HTTP 200")));
    assert.deepEqual(probe.routerLoad("other"), { started: true }, "a finished load frees the slot");
  } finally {
    release?.();
    await new Promise((r) => setImmediate(r));
    console.log = log;
  }
});

test("dispose: aborts the pending model load and refuses new ones", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  let signal;
  probe._fetch = (url, opts) => {
    signal = opts.signal;
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  const log = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(probe.routerLoad("ornith-35b"), { started: true });
    assert.equal(signal.aborted, false);
    assert.equal(probe.isLoadInFlight(), true);

    probe.dispose();
    assert.equal(signal.aborted, true, "the 20-minute request does not outlive the probe");
    await new Promise((r) => setImmediate(r));
    assert.equal(probe.isLoadInFlight(), false);
    assert.deepEqual(probe.routerLoad("other"), { started: false, reason: "disposed" });
  } finally {
    console.log = log;
  }
});

test("dispose: a feed read that finishes afterwards does not update the probe", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  let release;
  const state = {
    running: [EMBEDDER],
    prompt: 0,
    activity: () => new Promise((resolve) => (release = () => resolve(jsonRes({ data: [] })))),
  };
  probe._fetch = pollingFetch(state).fetch;
  await probe.probe();
  await settle();
  probe.dispose();
  release();
  await settle();
  assert.equal(probe.routerActivity, null);
});

test("re-detecting away from llama-swap clears the router feed state", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  const state = {
    running: [EMBEDDER],
    prompt: 0,
    activity: () => jsonRes({ data: [{ timestamp: new Date().toISOString(), model: "m", resp_status_code: 429, error_msg: "full" }] }),
  };
  probe._fetch = pollingFetch(state).fetch;
  await probe.probe();
  await settle();
  state.running = [];
  const snap = await probe.probe();
  assert.equal(snap.router, "llama-swap");
  assert.equal(snap.routerEvents.length, 1);
  assert.ok(snap.routerActivity);
  assert.equal(snap.routerModels.length, 1);

  probe._resetDetection();
  assert.equal(probe.routerEvents.length, 0);
  assert.equal(probe.routerActivity, null);
  assert.deepEqual(probe.routerModels, []);
  assert.equal(probe._routerRows, null);
  assert.equal(probe._routerPrev, null);
  assert.equal(probe._activityNextAt, 0);
  assert.equal(probe._modelsNextAt, 0);
  assert.equal(probe._activityRun, null);
  assert.equal(probe._modelsRun, null);
  assert.deepEqual(probe._feedHealth, {
    activity: { fails: 0, failing: false },
    models: { fails: 0, failing: false },
  });
});

test("a snapshot only carries router feeds while the server is a llama-swap router", async () => {
  const probe = new LlmProbe({ isLocal: true }, 11434);
  probe.routerEvents = [{ at: 1, model: "m", state: "ready", loadMs: null }];
  probe.routerActivity = { updatedAt: 1 };
  probe.routerModels = [{ id: "m", name: null, loaded: true }];
  probe.router = null;
  const snap = probe._getSnapshot();
  assert.deepEqual(snap.routerEvents, []);
  assert.equal(snap.routerActivity, null);
  assert.deepEqual(snap.routerModels, []);
});
