import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createStatusState,
  observeStatus,
  classifyStatus,
  advanceStatusState,
  forceStatusAfterInterrupt,
  SNAPSHOT_STALLED_AFTER_MS,
} from "../../pi-extension/subagents/status.ts";

test("status-state: fresh pi-source state has currentKind: starting", () => {
  const state = createStatusState({ source: "pi", startTimeMs: 1000 });
  assert.equal(state.currentKind, "starting");
});

test("status-state: claude-source state always classifies as running", () => {
  const state = createStatusState({ source: "claude", startTimeMs: 1000 });
  const snapshot = classifyStatus(state, 2000);
  assert.equal(snapshot.kind, "running");
});

test("status-state: present observation with active phase flips to active via advanceStatusState", () => {
  const state = createStatusState({ source: "pi", startTimeMs: 1000 });
  const observation = {
    snapshot: "present" as const,
    updatedAt: 2000,
    sequence: 1,
    phase: "active" as const,
  };
  const updated = observeStatus(state, observation, 2000);
  const { snapshot, nextState } = advanceStatusState(updated, 2000);
  assert.equal(nextState.currentKind, "active");
  assert.equal(snapshot.kind, "active");
});

test("status-state: idle past SNAPSHOT_STALLED_AFTER_MS from firstObservationAtMs flips to stalled", () => {
  const state = createStatusState({ source: "pi", startTimeMs: 1000 });
  const now = 1000 + SNAPSHOT_STALLED_AFTER_MS + 1000;
  const { nextState } = advanceStatusState(state, now);
  assert.equal(nextState.currentKind, "stalled");
});

test("status-state: forceStatusAfterInterrupt sets phase waiting, activityLabel interrupted, localOverrideSequence", () => {
  const state = createStatusState({ source: "pi", startTimeMs: 1000 });
  const observation = {
    snapshot: "present" as const,
    updatedAt: 2000,
    sequence: 5,
    phase: "active" as const,
  };
  const updated = observeStatus(state, observation, 2000);
  const forced = forceStatusAfterInterrupt(updated, 3000);
  assert.equal(forced.phase, "waiting");
  assert.equal(forced.activityLabel, "interrupted");
  assert.equal(forced.localOverrideSequence, 5);
});

test("status-state: stale present observation (updatedAt < lastActivityAtMs) is rejected", () => {
  const state = createStatusState({ source: "pi", startTimeMs: 1000 });
  const observation1 = {
    snapshot: "present" as const,
    updatedAt: 3000,
    sequence: 1,
    phase: "active" as const,
  };
  const updated1 = observeStatus(state, observation1, 3000);

  const staleObservation = {
    snapshot: "present" as const,
    updatedAt: 2000,
    sequence: 2,
    phase: "waiting" as const,
  };
  const updated2 = observeStatus(updated1, staleObservation, 4000);
  assert.equal(updated2.lastActivityAtMs, 3000);
  assert.equal(updated2.phase, "active");
});

test("status-state: recovery path stalled → active on fresh observation, transition is recovered", () => {
  const state = createStatusState({ source: "pi", startTimeMs: 1000 });
  const now = 1000 + SNAPSHOT_STALLED_AFTER_MS + 1000;
  const stalled = advanceStatusState(state, now);

  const observation = {
    snapshot: "present" as const,
    updatedAt: now + 100,
    sequence: 1,
    phase: "active" as const,
  };
  const updated = observeStatus(stalled.nextState, observation, now + 100);
  const result = advanceStatusState(updated, now + 100);
  assert.equal(result.nextState.currentKind, "active");
  assert.equal(result.transition, "recovered");
});
