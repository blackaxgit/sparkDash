/**
 * The allow/refuse decisions behind the llama-swap load/unload routes and
 * video/cancel. Pure functions: every refusal and every allowed path.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { routerActionVerdict, videoCancelVerdict } from "../swapRouter.js";

const STUDIO = { model: "h3-studio", name: "H3 Studio" };
const MODELS = [
  { id: "ornith-35b", loaded: false },
  { id: "qwen3-embedding", loaded: true },
  { id: "h3-studio", loaded: true },
];

/** A video snapshot for the studio, idle unless counts are given. */
const video = (over = {}) => ({
  available: true,
  studio: { model: "h3-studio", name: "H3 Studio", state: "ready" },
  queueRunning: 0,
  queuePending: 0,
  ...over,
});

/** Request context with the studio resident and its queue known and empty. */
const ctx = (over = {}) => ({
  runningModels: ["qwen3-embedding", "h3-studio"],
  studio: STUDIO,
  routerModels: MODELS,
  video: video(),
  loadInFlight: false,
  ...over,
});

const load = (model, over) => routerActionVerdict({ action: "load", model, ...ctx(over) });
const unload = (model, over) => routerActionVerdict({ action: "unload", model, ...ctx(over) });

function assertRefused(v, status, re) {
  assert.ok(v, "expected a refusal, got allowed");
  assert.equal(v.status, status);
  assert.match(v.error, re);
}

// ─── unload ─────────────────────────────────────────────

test("unload: a model that is not running is refused", () => {
  assertRefused(unload("ornith-35b"), 409, /not running/);
});

test("unload: an LLM is allowed even while the studio renders", () => {
  assert.equal(unload("qwen3-embedding", { video: video({ queueRunning: 1, queuePending: 2 }) }), null);
});

test("unload: the studio is refused while it renders or has queued work", () => {
  assertRefused(unload("h3-studio", { video: video({ queueRunning: 1 }) }), 409, /1 running and 0 queued/);
  assertRefused(unload("h3-studio", { video: video({ queuePending: 3 }) }), 409, /0 running and 3 queued/);
});

test("unload: the studio is refused when its queue state is unknown", () => {
  const unknown = /GPU held by video studio H3 Studio \(state unknown\)/;
  assertRefused(unload("h3-studio", { video: null }), 409, unknown);
  assertRefused(unload("h3-studio", { video: video({ available: false }) }), 409, unknown);
  assertRefused(unload("h3-studio", { video: video({ studio: { model: "other-studio", name: "Other" } }) }), 409, unknown);
});

test("unload: an idle studio with a known queue is allowed", () => {
  assert.equal(unload("h3-studio"), null);
});

test("unload: the studio is recognised from the video snapshot when the probe has not flagged it", () => {
  assertRefused(unload("h3-studio", { studio: null, video: video({ queueRunning: 1 }) }), 409, /1 running/);
  assertRefused(unload("h3-studio", { studio: null, video: video({ available: false }) }), 409, /state unknown/);
});

// ─── load ───────────────────────────────────────────────

test("load: a model the router does not list is refused", () => {
  assertRefused(load("mystery"), 409, /not a configured model/);
});

test("load: a model already loaded per /v1/models is refused", () => {
  assertRefused(load("qwen3-embedding", { runningModels: [] }), 409, /already loaded/);
});

test("load: a model present in /running (running or mid-load) is refused", () => {
  assertRefused(load("ornith-35b", { runningModels: ["ornith-35b"], studio: null, video: null }), 409, /already running or loading/);
});

test("load: refused while the studio has renders in flight", () => {
  assertRefused(load("ornith-35b", { video: video({ queueRunning: 1, queuePending: 2 }) }), 409, /GPU held by video studio H3 Studio \(1 running, 2 queued\)/);
});

test("load: fails closed when the studio's queue state is unknown", () => {
  const unknown = /GPU held by video studio H3 Studio \(state unknown\)/;
  assertRefused(load("ornith-35b", { video: null }), 409, unknown);
  assertRefused(load("ornith-35b", { video: video({ available: false }) }), 409, unknown);
  assertRefused(load("ornith-35b", { video: video({ studio: { model: "other-studio", name: null } }) }), 409, unknown);
  assertRefused(load("ornith-35b", { studio: null, video: video({ available: false }) }), 409, unknown);
});

test("load: refused while another load is in flight", () => {
  assertRefused(load("ornith-35b", { loadInFlight: true }), 409, /already in flight/);
});

test("load: allowed when no studio is resident, even with no video snapshot", () => {
  assert.equal(load("ornith-35b", { runningModels: ["qwen3-embedding"], studio: null, video: null }), null);
});

test("load: allowed when the resident studio is idle with a known queue", () => {
  assert.equal(load("ornith-35b"), null);
});

test("load: a stale video snapshot of a studio that is no longer running does not block", () => {
  assert.equal(
    load("ornith-35b", { runningModels: ["qwen3-embedding"], studio: null, video: video({ queueRunning: 2 }) }),
    null
  );
});

// ─── bad ids ────────────────────────────────────────────

test("'.' and '..' are refused as model ids for both actions, before anything else", () => {
  for (const id of [".", ".."]) {
    // Even if a hostile router lists them as running and configured.
    const over = { runningModels: [id], routerModels: [{ id, loaded: false }] };
    assertRefused(load(id, over), 400, /model must be/);
    assertRefused(unload(id, over), 400, /model must be/);
  }
});

test("a non-string, empty or oversized model id is refused with 400", () => {
  for (const id of [undefined, null, 5, "", "x".repeat(201)]) {
    assertRefused(load(id), 400, /model must be/);
    assertRefused(unload(id), 400, /model must be/);
  }
  assert.equal(unload("x".repeat(200), { runningModels: ["x".repeat(200)] }), null);
});

// ─── video cancel ───────────────────────────────────────

test("video cancel: no resident studio is refused", () => {
  assertRefused(videoCancelVerdict({ promptId: "abc", studioPort: null, jobState: "running" }), 409, /No video studio/);
});

test("video cancel: a job that is not queued is refused", () => {
  assertRefused(videoCancelVerdict({ promptId: "abc", studioPort: 8188, jobState: null }), 409, /not in the studio queue/);
});

test("video cancel: a running or pending job on a ready studio is allowed", () => {
  assert.equal(videoCancelVerdict({ promptId: "abc", studioPort: 8188, jobState: "running" }), null);
  assert.equal(videoCancelVerdict({ promptId: "abc", studioPort: 8188, jobState: "pending" }), null);
});

test("video cancel: '.', '..', empty, non-string and oversized prompt ids are refused with 400", () => {
  for (const promptId of [".", "..", "", undefined, 7, "p".repeat(65)]) {
    assertRefused(videoCancelVerdict({ promptId, studioPort: 8188, jobState: "running" }), 400, /promptId is required/);
  }
  assert.equal(videoCancelVerdict({ promptId: "p".repeat(64), studioPort: 8188, jobState: "pending" }), null);
});
