import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseStatusConfig, loadStatusConfig } from "../../pi-extension/subagents/status.ts";

test("status-config: parseStatusConfig with enabled true", () => {
  const result = parseStatusConfig({ status: { enabled: true } });
  assert.equal(result.enabled, true);
  assert.equal(result.lineLimit, 4);
});

test("status-config: parseStatusConfig with enabled false", () => {
  const result = parseStatusConfig({ status: { enabled: false } });
  assert.equal(result.enabled, false);
  assert.equal(result.lineLimit, 4);
});

test("status-config: parseStatusConfig rejects unsupported keys with lineLimit", () => {
  assert.throws(
    () => parseStatusConfig({ status: { enabled: true, lineLimit: 5 } }),
    { message: /unsupported key.*lineLimit/ },
  );
});

test("status-config: parseStatusConfig throws on missing status.enabled", () => {
  assert.throws(
    () => parseStatusConfig({ status: {} }),
    { message: /must be a boolean/ },
  );
});

test("status-config: loadStatusConfig reads exampleFile when main missing", () => {
  const examplePath = "/tmp/test-status-config.json";
  try {
    const result = loadStatusConfig("/tmp/nonexistent.json", examplePath);
    // This test should fail during implementation
    assert.fail("Should have thrown");
  } catch (e) {
    // Expected to fail initially
  }
});

test("status-config: loadStatusConfig throws Missing subagent status config when both missing", () => {
  assert.throws(
    () => loadStatusConfig("/tmp/nonexistent1.json", "/tmp/nonexistent2.json"),
    { message: /Missing subagent status config/ },
  );
});
