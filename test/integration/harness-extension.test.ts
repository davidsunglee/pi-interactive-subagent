/**
 * Regression test: the integration harness must launch pi with the
 * working-tree extension (`-ne -e <pi-extension/subagents/index.ts>`) instead
 * of relying on pi's normal extension auto-discovery, which would silently
 * load a `pi-package` snapshot pinned to the last released tag.
 *
 * Originally ported from upstream commit aa3d34b
 * (`test(integration): load working-tree extension instead of installed package`).
 *
 * This test does not require a mux backend — it exercises the pure command
 * builder so it always runs as part of `npm run test:integration`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { buildPiCommand, EXTENSION_SOURCE } from "./harness.ts";

describe("integration harness: working-tree extension loading", () => {
  it("EXTENSION_SOURCE points at the checkout's extension entry file", () => {
    assert.ok(
      isAbsolute(EXTENSION_SOURCE),
      `EXTENSION_SOURCE should be absolute, got ${EXTENSION_SOURCE}`,
    );
    assert.match(
      EXTENSION_SOURCE,
      /pi-extension[\\/]+subagents[\\/]+index\.ts$/,
      `EXTENSION_SOURCE should end with pi-extension/subagents/index.ts, got ${EXTENSION_SOURCE}`,
    );
    assert.ok(
      existsSync(EXTENSION_SOURCE),
      `EXTENSION_SOURCE must exist on disk in the working tree: ${EXTENSION_SOURCE}`,
    );
  });

  it("buildPiCommand disables auto-discovery and force-loads the working-tree extension", () => {
    const cmd = buildPiCommand("/tmp/some-test-dir", "do a thing", {
      model: "anthropic/claude-haiku-4-5",
    });

    // -ne disables pi's extension auto-discovery so no installed package
    // snapshot is loaded.
    assert.match(
      cmd,
      /(^|\s)-ne(\s|$)/,
      `command must include -ne to disable extension auto-discovery: ${cmd}`,
    );

    // -e <path> force-loads the working-tree extension.
    assert.ok(
      cmd.includes(`-e `),
      `command must include -e <path> for the working-tree extension: ${cmd}`,
    );
    assert.ok(
      cmd.includes(EXTENSION_SOURCE),
      `command must reference the working-tree EXTENSION_SOURCE (${EXTENSION_SOURCE}): ${cmd}`,
    );

    // -ne must come before -e so auto-discovery is disabled before pi resolves
    // the explicit extension argument.
    const neIdx = cmd.indexOf("-ne");
    const eIdx = cmd.indexOf("-e ");
    assert.ok(
      neIdx !== -1 && eIdx !== -1 && neIdx < eIdx,
      `-ne should appear before -e in command: ${cmd}`,
    );
  });

  it("buildPiCommand still honors model and extraArgs (existing harness contract)", () => {
    const cmd = buildPiCommand("/tmp/some-test-dir", "task body", {
      model: "anthropic/claude-haiku-4-5",
      extraArgs: "--print",
    });

    assert.ok(cmd.startsWith("cd "), `command must cd into the test dir first: ${cmd}`);
    assert.ok(
      cmd.includes("--model"),
      `command must include --model for the configured test model: ${cmd}`,
    );
    assert.ok(
      cmd.includes("anthropic/claude-haiku-4-5"),
      `command must include the chosen model name: ${cmd}`,
    );
    assert.ok(cmd.includes("--print"), `command must pass extraArgs through verbatim: ${cmd}`);
  });
});
