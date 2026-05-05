import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  writeSubagentActivityFile,
  createSubagentActivityRecorder,
} from "../../pi-extension/subagents/activity.ts";

describe("activity-recorder", () => {
  let testDir: string;

  // Helper to create a unique temp directory for each test
  function getTempDir(): string {
    const dir = join(tmpdir(), `activity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("recorder writes a snapshot at <dir>/subagent-activity/<id>.json reachable by getSubagentActivityFile", () => {
    testDir = getTempDir();
    try {
      const id = "child-1";
      const activityFile = getSubagentActivityFile(testDir, id);

      // Create a recorder with the test directory
      const now = Date.now();
      const mockNow = () => now;
      const recorder = createSubagentActivityRecorder({
        runningChildId: id,
        activityFile,
        now: mockNow,
      });

      // Trigger a recording
      recorder.sessionStart();

      // Verify file exists at expected location
      assert.ok(existsSync(activityFile), `Activity file should exist at ${activityFile}`);

      // Verify we can read it back
      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.activity.runningChildId, id);
        assert.equal(result.activity.phase, "starting");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("readSubagentActivityFile returns { ok: true, activity } with phase: 'active' after toolExecutionStart", () => {
    testDir = getTempDir();
    try {
      const id = "child-2";
      const activityFile = getSubagentActivityFile(testDir, id);

      const now = Date.now();
      const mockNow = () => now;
      const recorder = createSubagentActivityRecorder({
        runningChildId: id,
        activityFile,
        now: mockNow,
      });

      recorder.toolExecutionStart("tool-1", "bash");

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.activity.phase, "active");
        assert.equal(result.activity.latestEvent, "tool_execution_start");
        assert.equal(result.activity.toolActive, true);
        assert.equal(result.activity.toolCallId, "tool-1");
        assert.equal(result.activity.toolName, "bash");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("readSubagentActivityFile(file, 'other') returns { ok: false, reason: 'wrong-id' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-3";
      const activityFile = getSubagentActivityFile(testDir, id);

      const now = Date.now();
      const mockNow = () => now;
      const recorder = createSubagentActivityRecorder({
        runningChildId: id,
        activityFile,
        now: mockNow,
      });

      recorder.sessionStart();

      // Try to read with wrong id
      const result = readSubagentActivityFile(activityFile, "other");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "wrong-id");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("malformed activity with activeSince: 'bad' returns { ok: false, reason: 'invalid' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-4";
      const activityFile = getSubagentActivityFile(testDir, id);

      // Write malformed activity file
      const malformed = {
        version: 1,
        runningChildId: id,
        createdAt: 100,
        updatedAt: 100,
        sequence: 0,
        latestEvent: "session_start",
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: false,
        activeSince: "bad", // Invalid: should be number
      };

      writeSubagentActivityFile(activityFile, malformed as any);

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("malformed activity with waitingSince: 'bad' returns { ok: false, reason: 'invalid' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-5";
      const activityFile = getSubagentActivityFile(testDir, id);

      const malformed = {
        version: 1,
        runningChildId: id,
        createdAt: 100,
        updatedAt: 100,
        sequence: 0,
        latestEvent: "session_start",
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: false,
        waitingSince: "bad", // Invalid: should be number
      };

      writeSubagentActivityFile(activityFile, malformed as any);

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("malformed activity with activeScope: 'database' returns { ok: false, reason: 'invalid' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-6";
      const activityFile = getSubagentActivityFile(testDir, id);

      const malformed = {
        version: 1,
        runningChildId: id,
        createdAt: 100,
        updatedAt: 100,
        sequence: 0,
        latestEvent: "session_start",
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: false,
        activeScope: "database", // Invalid: not in KNOWN_SCOPES
      };

      writeSubagentActivityFile(activityFile, malformed as any);

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("malformed activity with latestEvent: 'unknown' returns { ok: false, reason: 'invalid' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-7";
      const activityFile = getSubagentActivityFile(testDir, id);

      const malformed = {
        version: 1,
        runningChildId: id,
        createdAt: 100,
        updatedAt: 100,
        sequence: 0,
        latestEvent: "unknown", // Invalid: not in KNOWN_EVENTS
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: false,
      };

      writeSubagentActivityFile(activityFile, malformed as any);

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("malformed activity with runningChildId: 42 returns { ok: false, reason: 'invalid' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-8";
      const activityFile = getSubagentActivityFile(testDir, id);

      const malformed = {
        version: 1,
        runningChildId: 42, // Invalid: should be string
        createdAt: 100,
        updatedAt: 100,
        sequence: 0,
        latestEvent: "session_start",
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: false,
      };

      writeSubagentActivityFile(activityFile, malformed as any);

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("malformed activity with toolActive: 'yes' returns { ok: false, reason: 'invalid' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-9";
      const activityFile = getSubagentActivityFile(testDir, id);

      const malformed = {
        version: 1,
        runningChildId: id,
        createdAt: 100,
        updatedAt: 100,
        sequence: 0,
        latestEvent: "session_start",
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: "yes", // Invalid: should be boolean
      };

      writeSubagentActivityFile(activityFile, malformed as any);

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("malformed activity with toolName containing newline returns { ok: false, reason: 'invalid' }", () => {
    testDir = getTempDir();
    try {
      const id = "child-10";
      const activityFile = getSubagentActivityFile(testDir, id);

      const malformed = {
        version: 1,
        runningChildId: id,
        createdAt: 100,
        updatedAt: 100,
        sequence: 0,
        latestEvent: "session_start",
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: false,
        toolName: "bad\nname", // Invalid: contains newline
      };

      writeSubagentActivityFile(activityFile, malformed as any);

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("subagentDone() marks phase 'done' and recorder becomes disabled", () => {
    testDir = getTempDir();
    try {
      const id = "child-11";
      const activityFile = getSubagentActivityFile(testDir, id);

      const now = Date.now();
      const mockNow = () => now;
      const recorder = createSubagentActivityRecorder({
        runningChildId: id,
        activityFile,
        now: mockNow,
      });

      recorder.subagentDone();

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.activity.phase, "done");
        assert.equal(result.activity.latestEvent, "subagent_done");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("callerPing() marks phase 'done' and recorder becomes disabled", () => {
    testDir = getTempDir();
    try {
      const id = "child-12";
      const activityFile = getSubagentActivityFile(testDir, id);

      const now = Date.now();
      const mockNow = () => now;
      const recorder = createSubagentActivityRecorder({
        runningChildId: id,
        activityFile,
        now: mockNow,
      });

      recorder.callerPing();

      const result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.activity.phase, "done");
        assert.equal(result.activity.latestEvent, "caller_ping");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("sessionShutdown('reload') does not write a 'done' snapshot (latest event stays 'session_start')", () => {
    testDir = getTempDir();
    try {
      const id = "child-13";
      const activityFile = getSubagentActivityFile(testDir, id);

      const now = Date.now();
      const mockNow = () => now;
      const recorder = createSubagentActivityRecorder({
        runningChildId: id,
        activityFile,
        now: mockNow,
      });

      recorder.sessionStart();
      const beforeShutdown = readSubagentActivityFile(activityFile, id);
      assert.equal(beforeShutdown.ok, true);
      if (beforeShutdown.ok) {
        assert.equal(beforeShutdown.activity.latestEvent, "session_start");
      }

      // Call sessionShutdown with 'reload' (should not write done)
      recorder.sessionShutdown("reload");

      const afterShutdown = readSubagentActivityFile(activityFile, id);
      assert.equal(afterShutdown.ok, true);
      if (afterShutdown.ok) {
        // Latest event should still be session_start, not session_shutdown
        assert.equal(afterShutdown.activity.latestEvent, "session_start");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });

  it("tool_result after tool_execution_end does not flip toolActive back to true", () => {
    testDir = getTempDir();
    try {
      const id = "child-14";
      const activityFile = getSubagentActivityFile(testDir, id);

      const now = Date.now();
      let currentTime = now;
      const mockNow = () => currentTime;
      const recorder = createSubagentActivityRecorder({
        runningChildId: id,
        activityFile,
        now: mockNow,
      });

      // Start tool execution
      recorder.toolExecutionStart("tool-1", "bash");
      currentTime += 100;

      // End tool execution
      recorder.toolExecutionEnd("tool-1", "bash");
      currentTime += 100;

      // Check that toolActive is false
      let result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.activity.toolActive, false);
        assert.equal(result.activity.latestEvent, "tool_execution_end");
      }

      // Now call tool_result
      recorder.toolResult("tool-1", "bash");

      // Verify toolActive is still false
      result = readSubagentActivityFile(activityFile, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.activity.toolActive, false, "toolActive should remain false after tool_result");
        assert.equal(result.activity.latestEvent, "tool_result");
      }
    } finally {
      if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
    }
  });
});
