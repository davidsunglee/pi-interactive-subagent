import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  formatStatusLine,
  formatTransitionLine,
  capStatusLines,
  formatStatusAggregate,
  normalizeStatusName,
  MAX_STATUS_NAME_LENGTH,
  MAX_STATUS_LINE_LENGTH,
} from "../../pi-extension/subagents/status.ts";

test("status-format: formatStatusLine for kind starting", () => {
  const snapshot = {
    kind: "starting" as const,
    elapsedMs: 5000,
    elapsedText: "5s",
    activeSinceMs: null,
    activeDurationText: null,
    activeScope: null,
    waitingSinceMs: null,
    waitingDurationText: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: "unseen" as const,
    snapshotError: null,
    snapshotProblemText: null,
    statusLabel: null,
  };
  const result = formatStatusLine("test", snapshot);
  assert.match(result, /running.*5s.*starting/);
});

test("status-format: formatStatusLine for kind active with label and duration", () => {
  const snapshot = {
    kind: "active" as const,
    elapsedMs: 5000,
    elapsedText: "5s",
    activeSinceMs: 3000,
    activeDurationText: "2s",
    activeScope: null,
    waitingSinceMs: null,
    waitingDurationText: null,
    latestEvent: null,
    activityLabel: "bash",
    snapshotState: "present" as const,
    snapshotError: null,
    snapshotProblemText: null,
    statusLabel: null,
  };
  const result = formatStatusLine("test", snapshot);
  assert.match(result, /active.*bash.*2s/);
});

test("status-format: formatStatusLine for kind waiting with done label adds (done)", () => {
  const snapshot = {
    kind: "waiting" as const,
    elapsedMs: 5000,
    elapsedText: "5s",
    activeSinceMs: null,
    activeDurationText: null,
    activeScope: null,
    waitingSinceMs: 4000,
    waitingDurationText: "1s",
    latestEvent: null,
    activityLabel: null,
    snapshotState: "present" as const,
    snapshotError: null,
    snapshotProblemText: null,
    statusLabel: "done",
  };
  const result = formatStatusLine("test", snapshot);
  assert.match(result, /done/);
});

test("status-format: formatStatusLine for kind stalled with snapshot problem text", () => {
  const snapshot = {
    kind: "stalled" as const,
    elapsedMs: 70000,
    elapsedText: "1m",
    activeSinceMs: null,
    activeDurationText: null,
    activeScope: null,
    waitingSinceMs: null,
    waitingDurationText: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: "invalid" as const,
    snapshotError: null,
    snapshotProblemText: "10s",
    statusLabel: "stalled",
  };
  const result = formatStatusLine("test", snapshot);
  assert.match(result, /stalled/);
});

test("status-format: formatStatusAggregate with line limit", () => {
  const result = formatStatusAggregate(["a", "b", "c", "d", "e"], 4);
  assert.match(result, /Subagent status/);
  assert.match(result, /• a/);
  assert.match(result, /• b/);
  assert.match(result, /• c/);
  assert.match(result, /• d/);
  assert.match(result, /\+1 more running/);
});

test("status-format: normalizeStatusName collapses whitespace and truncates", () => {
  const input = " a   b ";
  const result = normalizeStatusName(input);
  assert.equal(result, "a b");

  const longName = "x".repeat(MAX_STATUS_NAME_LENGTH + 10);
  const longResult = normalizeStatusName(longName);
  assert.ok(longResult.length <= MAX_STATUS_NAME_LENGTH);
});

test("status-format: formatTransitionLine for recovered includes recovered word", () => {
  const snapshot = {
    kind: "active" as const,
    elapsedMs: 65000,
    elapsedText: "1m",
    activeSinceMs: 64000,
    activeDurationText: "1s",
    activeScope: null,
    waitingSinceMs: null,
    waitingDurationText: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: "present" as const,
    snapshotError: null,
    snapshotProblemText: null,
    statusLabel: null,
  };
  const result = formatTransitionLine("test", snapshot, "recovered");
  assert.match(result, /recovered/);
});
