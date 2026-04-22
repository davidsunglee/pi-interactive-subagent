# Plan Review — Orchestration Lifecycle Expansion v3

## Summary verdict

[Issues Found]

v3 is materially stronger than v2. It fixes the prior serial-resume blocker by gating continuation on `state === "completed"`, corrects the bad spec-path reference, and adds explicit pane/headless backend-real coverage tasks instead of stopping at registry- or seam-level tests.

The remaining problems are now narrower and mostly concentrated in the new end-to-end test plan. The largest one is buildability: the backend-real block/resume/complete tests in Task 14 depend on a test fixture that cannot actually complete after resume in the current repo. There is also a concrete mismatch between Task 14.2c and the current headless test/runtime controls.

## Addressed previous findings

1. **`sessionId` vs `sessionPath` mismatch on the unblock key**  
   **Status:** Addressed  
   v3 keeps the v2 `sessionKey` contract and threads it consistently through the lifecycle design, including blocked notifications and `subagent_resume` re-ingestion.

2. **Async serial cleanup cancelling downstream tasks after a block**  
   **Status:** Addressed  
   Task 10.5 still preserves the paused-on-block branch, and Task 11 now adds the missing continuation driver instead of collapsing the tail to `cancelled` prematurely.

3. **Blocked widget rows only clearing on whole-orchestration completion**  
   **Status:** Addressed  
   Task 13 keeps the per-task terminal hook and explicitly clears virtual blocked rows on each terminal transition.

4. **Recursive `caller_ping` behavior only simulated, not wired through real `subagent_resume`**  
   **Status:** Addressed  
   Task 12 routes both terminal resume results and ping-during-resume back into the registry, and Task 14.2 now requires exercising that through the real registered `subagent_resume` tool path.

5. **Public blocked notification kind drifted from `blocked` to `orchestration_blocked`**  
   **Status:** Addressed  
   v3 keeps `BLOCKED_KIND = "blocked"` and retains the explicit final grep invariant.

6. **Real backend / extension coverage was too weak for the new lifecycle**  
   **Status:** Partially addressed  
   v3 clearly improves this by adding Task 14.2b and Task 14.2c for pane/headless backend-real coverage. However, those tasks are not fully executable as written against the current repo state; see Remaining Findings 1 and 2.

## Remaining findings

### 1) Error — Task 14's backend-real resume-completion tests are not buildable with the current `test-ping` fixture
**Impacted tasks:** Task 14.2b, Task 14.2c

**Problem:**  
Both backend-real tests require the same child session to:
1. call `caller_ping` on its first run, and then
2. complete successfully after the parent invokes the real `subagent_resume` tool.

But the only fixture the plan points at for these tests is `test/integration/agents/test-ping.md`, and that agent currently instructs the child to call `caller_ping` for **any** task it receives. There is no task in the plan that adds a resumable ping fixture or modifies `test-ping` so a resumed session can terminate normally.

**Why this matters:**  
This is execution-blocking for the new required pane/headless end-to-end coverage. As written, Task 14's "blocked → real resume → orchestration_complete" path cannot pass with the current test agent set.

**Concrete fix:**  
Add an explicit task before 14.2b/14.2c that creates or updates a fixture for this scenario, for example:
- a dedicated agent that pings once and then completes after a follow-up prompt, or
- a test agent that switches behavior based on the resume message.

Without that fixture work, the most important new backend-real tests have no passing path.

### 2) Warning — Task 14.2c does not match current headless test/runtime reality
**Impacted tasks:** Task 14.2c

**Problem:**  
Task 14.2c's scaffold conflicts with the current codebase in three concrete ways:

- It uses `PI_SUBAGENT_BACKEND`, but backend selection currently reads `PI_SUBAGENT_MODE` in `pi-extension/subagents/backends/select.ts`.
- It calls `createTestEnv("headless")`, but `test/integration/harness.ts` only models mux backends (`cmux` / `tmux`), not a `headless` backend value.
- It says the test should run whenever `pi` is on PATH, but the real `subagent_resume` tool still hard-requires a mux in `pi-extension/subagents/index.ts`. So the "complete through the real `subagent_resume` tool path" half is not actually mux-free today.

**Why this matters:**  
The task's acceptance criteria and example code do not line up with the current repo. That creates avoidable implementation churn exactly in the new high-risk integration coverage area.

**Concrete fix:**  
Rewrite Task 14.2c against the current controls:
- use `PI_SUBAGENT_MODE=headless`,
- use an agent-fixture setup that matches the real harness API,
- and either require mux availability for the resume half or add a separate task that makes `subagent_resume` headless-capable before claiming mux-independent execution.

### 3) Warning — Several real-extension tests still depend on an unspecified test seam
**Impacted tasks:** Task 8.3b, Task 10.7b, Task 14.2

**Problem:**  
These steps call for real `subagentsExtension(pi)` tests while also injecting deterministic `LauncherDeps` or controlled `watchSubagent` outcomes "through the existing `__test__` surface if needed." But the current `pi-extension/subagents/index.ts` `__test__` export only exposes widget/launch-spec helpers; it does not expose an orchestration deps override or a resume-watcher seam.

The plan leaves that plumbing implicit instead of assigning a concrete implementation step.

**Why this matters:**  
This is not a spec-coverage gap, but it is a planning ambiguity. The implementer has to invent cross-cutting test infrastructure in the middle of Phase 1/2 execution, which increases the chance of either scope drift or tests that quietly stop being "real extension" coverage.

**Concrete fix:**  
Add one explicit earlier task that defines the extension test seam, including:
- what hook is added,
- where it lives (`__test__` or equivalent), and
- which tests are expected to use it.

Alternatively, convert those cases to fully real backend tests and remove the mixed "real extension + injected backend behavior" expectation.

## Recommended next steps

1. **Add a resumable ping fixture before Task 14.** This is the only remaining blocker that can make the new backend-real tests impossible to pass.
2. **Correct Task 14.2c to match the actual codebase controls.** Use `PI_SUBAGENT_MODE`, align with the existing harness API, and be explicit about the mux requirement of the current `subagent_resume` implementation.
3. **Make the extension test seam explicit or simplify the test strategy.** Decide whether the plan wants seam-driven real-extension tests or fully real backend tests, and encode that choice concretely.

Once those adjustments are made, the plan looks structurally ready to execute.

[Issues Found]
