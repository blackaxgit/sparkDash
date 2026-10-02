import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  detectComfyUpstream,
  isKnownComfyUpstream,
  noteComfyModel,
  isKnownComfyModel,
  readJsonCapped,
  resetComfyDetectCache,
} from "../comfyDetect.js";

beforeEach(() => resetComfyDetectCache());

const ORIGIN = "http://127.0.0.1:8189";
const T0 = 1_000_000;

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const COMFY_STATS = { system: { comfyui_version: "0.37.2" } };

/** Fetch that answers from a queue of handlers and records every call. */
function scripted(...handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return h();
  };
  return { fetchImpl, calls };
}

test("a ComfyUI /system_stats is a studio, cached for 5 min, then re-checked", async () => {
  const { fetchImpl, calls } = scripted(() => jsonRes(COMFY_STATS));
  const a = await detectComfyUpstream(ORIGIN, { fetchImpl, now: T0 });
  assert.deepEqual({ isComfy: a.isComfy, version: a.version, failed: a.failed }, {
    isComfy: true,
    version: "0.37.2",
    failed: false,
  });
  assert.equal(isKnownComfyUpstream(ORIGIN), true);

  await detectComfyUpstream(ORIGIN, { fetchImpl, now: T0 + 5 * 60_000 - 1 });
  assert.equal(calls.length, 1, "still cached just before the TTL");
  await detectComfyUpstream(ORIGIN, { fetchImpl, now: T0 + 5 * 60_000 });
  assert.equal(calls.length, 2, "re-checked once the TTL expired");
});

test("a non-studio answer is cached for 60 s; a failure only for 10 s", async () => {
  const notComfy = scripted(() => jsonRes({}, 404));
  const r = await detectComfyUpstream(ORIGIN, { fetchImpl: notComfy.fetchImpl, now: T0 });
  assert.deepEqual({ isComfy: r.isComfy, failed: r.failed }, { isComfy: false, failed: false });
  await detectComfyUpstream(ORIGIN, { fetchImpl: notComfy.fetchImpl, now: T0 + 59_999 });
  assert.equal(notComfy.calls.length, 1);
  await detectComfyUpstream(ORIGIN, { fetchImpl: notComfy.fetchImpl, now: T0 + 60_000 });
  assert.equal(notComfy.calls.length, 2);

  resetComfyDetectCache();
  const down = scripted(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const f = await detectComfyUpstream(ORIGIN, { fetchImpl: down.fetchImpl, now: T0 });
  assert.deepEqual({ isComfy: f.isComfy, failed: f.failed }, { isComfy: false, failed: true });
  await detectComfyUpstream(ORIGIN, { fetchImpl: down.fetchImpl, now: T0 + 9_999 });
  assert.equal(down.calls.length, 1);
  await detectComfyUpstream(ORIGIN, { fetchImpl: down.fetchImpl, now: T0 + 10_000 });
  assert.equal(down.calls.length, 2);
});

test("a failure after a positive verdict keeps the studio, with the short failure TTL", async () => {
  const s = scripted(
    () => jsonRes(COMFY_STATS),
    () => {
      throw new Error("The operation was aborted due to timeout");
    },
    () => jsonRes(COMFY_STATS)
  );
  await detectComfyUpstream(ORIGIN, { fetchImpl: s.fetchImpl, now: T0 });

  const blip = await detectComfyUpstream(ORIGIN, { fetchImpl: s.fetchImpl, now: T0 + 5 * 60_000 });
  assert.equal(blip.isComfy, true, "one timeout must not flip a confirmed studio");
  assert.equal(blip.version, "0.37.2");
  assert.equal(blip.failed, true);
  assert.equal(isKnownComfyUpstream(ORIGIN), true);

  // retried after FAILED_TTL (10 s), not after the 5 min positive TTL
  await detectComfyUpstream(ORIGIN, { fetchImpl: s.fetchImpl, now: T0 + 5 * 60_000 + 9_999 });
  assert.equal(s.calls.length, 2);
  const back = await detectComfyUpstream(ORIGIN, { fetchImpl: s.fetchImpl, now: T0 + 5 * 60_000 + 10_000 });
  assert.equal(s.calls.length, 3);
  assert.equal(back.failed, false);
});

test("a confirmed studio answering 5xx keeps its verdict; a redirect is never followed", async () => {
  const s = scripted(() => jsonRes(COMFY_STATS), () => new Response("busy", { status: 503 }));
  await detectComfyUpstream(ORIGIN, { fetchImpl: s.fetchImpl, now: T0 });
  const r = await detectComfyUpstream(ORIGIN, { fetchImpl: s.fetchImpl, now: T0 + 5 * 60_000 });
  assert.equal(r.isComfy, true);
  assert.equal(s.calls[0].init.redirect, "manual");

  resetComfyDetectCache();
  const redir = scripted(
    () => new Response(null, { status: 302, headers: { location: "http://evil.example/system_stats" } })
  );
  const other = await detectComfyUpstream("http://127.0.0.1:9", { fetchImpl: redir.fetchImpl, now: T0 });
  assert.equal(other.isComfy, false);
  assert.equal(redir.calls.length, 1, "the Location was not requested");
  assert.equal(redir.calls[0].init.redirect, "manual");
});

test("the origin cache holds at most 64 entries and evicts the oldest `at`", async () => {
  const fetchImpl = async () => jsonRes(COMFY_STATS);
  for (let i = 0; i < 64; i++) {
    await detectComfyUpstream(`http://127.0.0.1:${9000 + i}`, { fetchImpl, now: T0 + i });
  }
  assert.equal(isKnownComfyUpstream("http://127.0.0.1:9000"), true);
  await detectComfyUpstream("http://127.0.0.1:9999", { fetchImpl, now: T0 + 100 });
  assert.equal(isKnownComfyUpstream("http://127.0.0.1:9000"), false, "oldest entry evicted");
  assert.equal(isKnownComfyUpstream("http://127.0.0.1:9001"), true);
  assert.equal(isKnownComfyUpstream("http://127.0.0.1:9999"), true);

  // refreshing an origin already in the cache never evicts anyone
  await detectComfyUpstream("http://127.0.0.1:9001", { fetchImpl, now: T0 + 10 * 60_000 });
  assert.equal(isKnownComfyUpstream("http://127.0.0.1:9002"), true);
});

test("a /system_stats body over 64 KB is a failure, not a studio", async () => {
  const big = new Response(JSON.stringify({ system: { comfyui_version: "0.37.2" }, pad: "x".repeat(70 * 1024) }));
  const r = await detectComfyUpstream(ORIGIN, { fetchImpl: async () => big, now: T0 });
  assert.equal(r.isComfy, false);
  assert.equal(r.failed, true);
});

test("noteComfyModel / isKnownComfyModel: keyed by origin+name, bounded at 16, reset clears", () => {
  const A = "http://127.0.0.1:8189";
  const B = "http://127.0.0.1:8000";
  assert.equal(isKnownComfyModel(A, "h3-studio"), false);
  noteComfyModel(A, "h3-studio");
  assert.equal(isKnownComfyModel(A, "h3-studio"), true);
  // A hostile /running cannot borrow the name for another upstream (an LLM's port).
  assert.equal(isKnownComfyModel(B, "h3-studio"), false);
  noteComfyModel(A, "qwen38-flash-next");
  assert.equal(isKnownComfyModel(B, "qwen38-flash-next"), false);

  resetComfyDetectCache();
  noteComfyModel(A, "h3-studio");
  for (let i = 0; i < 16; i++) noteComfyModel(A, `m${i}`);
  assert.equal(isKnownComfyModel(A, "h3-studio"), false, "oldest evicted at 17 entries");
  assert.equal(isKnownComfyModel(A, "m0"), true);
  assert.equal(isKnownComfyModel(A, "m15"), true);

  // re-noting makes a key the newest
  noteComfyModel(A, "m0");
  noteComfyModel(A, "extra");
  assert.equal(isKnownComfyModel(A, "m0"), true);
  assert.equal(isKnownComfyModel(A, "m1"), false);

  noteComfyModel(A, "");
  noteComfyModel(A, "x".repeat(300));
  noteComfyModel(null, "orphan");
  assert.equal(isKnownComfyModel(A, ""), false);
  assert.equal(isKnownComfyModel(null, "orphan"), false);

  resetComfyDetectCache();
  assert.equal(isKnownComfyModel(A, "m0"), false);
});

test("readJsonCapped parses under the cap and rejects over it", async () => {
  assert.deepEqual(await readJsonCapped(jsonRes({ a: 1 }), 1024), { a: 1 });
  await assert.rejects(readJsonCapped(new Response("x".repeat(2048)), 1024), /over 1024 bytes/);
  // a declared Content-Length over the cap is refused without reading
  const declared = new Response("{}", { headers: { "content-length": "99999" } });
  await assert.rejects(readJsonCapped(declared, 1024), /over 1024 bytes/);
  await assert.rejects(readJsonCapped(new Response("not json"), 1024));
});
