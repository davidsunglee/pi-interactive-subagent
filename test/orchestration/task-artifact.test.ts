import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOrchestrationTaskArtifact } from "../../pi-extension/orchestration/task-artifact.ts";

describe("writeOrchestrationTaskArtifact", () => {
  it("returns null on empty finalMessage", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-artifact-empty-"));
    try {
      const result = writeOrchestrationTaskArtifact({
        artifactDir: tmpDir,
        orchestrationId: "test123",
        taskIndex: 0,
        finalMessage: "",
      });
      assert.equal(result, null);
      // Confirm no directory was created
      assert.equal(
        existsSync(join(tmpDir, "orchestrations")),
        false,
        "empty finalMessage should not create directory",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes the body byte-for-byte to the expected path", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-artifact-bytewise-"));
    try {
      const body = `# Heading\nLine 1\n$$ $& $1\n🎯 emoji test\nFinal line`;
      const result = writeOrchestrationTaskArtifact({
        artifactDir: tmpDir,
        orchestrationId: "abcd1234",
        taskIndex: 5,
        finalMessage: body,
      });

      assert.ok(result, "should return non-null path");
      assert.equal(
        readFileSync(result, "utf8"),
        body,
        "file content must match input byte-for-byte",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates the orchestrations/<id>/ subdirectory on demand", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-artifact-mkdir-"));
    try {
      const result = writeOrchestrationTaskArtifact({
        artifactDir: tmpDir,
        orchestrationId: "xyz789",
        taskIndex: 0,
        finalMessage: "test body",
      });

      assert.ok(result);
      assert.equal(
        existsSync(join(tmpDir, "orchestrations", "xyz789", "task-0.md")),
        true,
        "orchestrations/<id>/task-<index>.md must exist",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null on write failure", () => {
    const result = writeOrchestrationTaskArtifact({
      artifactDir: "/dev/null/no-such-dir",
      orchestrationId: "test",
      taskIndex: 0,
      finalMessage: "body",
    });
    assert.equal(result, null, "should return null on write failure");
  });
});
