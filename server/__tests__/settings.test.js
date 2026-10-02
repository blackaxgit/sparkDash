/**
 * Global settings: the Services layout preference is server-side so the choice
 * follows the user to every browser.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(dir, "settings.json");
const { loadSettings, updateSettings, getSettings } = await import("../settings.js");

test("servicesLayout defaults to the side-by-side grid", () => {
  loadSettings();
  assert.equal(getSettings().servicesLayout, "grid");
});

test("servicesLayout accepts rows and persists it to disk", () => {
  const updated = updateSettings({ servicesLayout: "rows" });
  assert.equal(updated.servicesLayout, "rows");
  const raw = JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf8"));
  assert.equal(raw.servicesLayout, "rows");
  assert.equal(loadSettings().servicesLayout, "rows");
});

test("an unknown servicesLayout falls back to the default", () => {
  assert.equal(updateSettings({ servicesLayout: "sideways" }).servicesLayout, "grid");
});
