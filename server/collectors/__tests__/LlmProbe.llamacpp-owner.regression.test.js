/**
 * Regression: llama.cpp behind a transiently failing /slots probe must not be
 * misclassified as vLLM. The misclassification is sticky (the anti-404-spam
 * guard never re-probes /slots once backendType is "vllm"), which blanks
 * every metric tile. llama-server reports owned_by "llamacpp" on /v1/models;
 * classification must honor it when the first-contact /slots probe throws
 * (timeout while the server is busy or waking from --sleep-idle-seconds).
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

test("llama.cpp detect: /slots times out but owned_by=llamacpp → llama.cpp", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 11434);
  let slotsCalls = 0;
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) {
      slotsCalls += 1;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (u.endsWith("/v1/models")) {
      return jsonRes({
        object: "list",
        data: [{ id: "ornith-35b", object: "model", owned_by: "llamacpp" }],
      });
    }
    return jsonRes({}, 404);
  };

  await probe._detectServerType();
  assert.equal(probe.backendType, "llama.cpp");
  assert.equal(probe.serverIsOpenAI, false);

  // Guard must keep re-probing /slots for llama.cpp so it can recover.
  await probe._detectServerType();
  assert.equal(slotsCalls, 2);
  assert.equal(probe.backendType, "llama.cpp");
});
