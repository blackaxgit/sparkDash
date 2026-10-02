import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemCollector } from "../SystemCollector.js";

test("collectGpu reports collected:false when the GPU query throws", async (t) => {
  t.mock.method(console, "error", () => {});
  const c = new SystemCollector({ id: "t", isLocal: true, kind: "spark" });
  c._getGPUAll = async () => {
    throw new Error("nvidia-smi failed");
  };
  const gpu = await c.collectGpu();
  assert.equal(gpu.collected, false);
  assert.equal(gpu.temperature, 0);
});

test("collectGpu reports collected:false when the query returns unusable readings", async () => {
  const c = new SystemCollector({ id: "t", isLocal: true, kind: "spark" });
  c._getGPUAll = async () => c._defaultGpu();
  c._collectThermal = async () => null;
  const gpu = await c.collectGpu();
  assert.equal(gpu.collected, false);
});

test("remote storage has no I/O rates: readSpeed/writeSpeed are null, not zero", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sc-ssh-"));
  const df = [
    "Filesystem Type 1B-blocks Used Available Use% Mounted",
    "/dev/nvme0n1p2 ext4 1073741824000 536870912000 536870912000 50% /",
  ].join("\n");
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\ncat <<'DF'\n${df}\nDF\n`, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const c = new SystemCollector({
      id: "remote",
      isLocal: false,
      kind: "host",
      lanIp: "192.168.1.50",
      ssh: { user: "ops", host: "192.168.1.50" },
    });
    const disks = await c.collectStorage();
    assert.equal(disks.length, 1);
    assert.equal(disks[0].label, "/");
    assert.equal(disks[0].percentage, 50);
    assert.equal(disks[0].readSpeed, null);
    assert.equal(disks[0].writeSpeed, null);
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
