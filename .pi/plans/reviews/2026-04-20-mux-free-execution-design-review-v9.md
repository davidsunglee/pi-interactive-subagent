# Review: 2026-04-20-mux-free-execution-design-v7.md

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v7.md`  
Verdict: **v7 closes the prior major blockers; two moderate validation gaps remain**  
Ready to merge: **With fixes**

## Summary

I did not find a new major architecture or sequencing blocker in v7. The plan is materially stronger than v6:

- the pi transcript boundary is now described honestly and tested via projection instead of cast-based assignment (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:9-11,34,2028-2071,2312-2407`)
- the Claude `--print` placement bug in the pane restriction test is explicitly fixed (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:11,3183-3267`)
- the shared launch-spec seam, backend selector, and release-sequencing notes are still in the right places for an incremental rollout (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:33-39,511-515`)

The remaining issues are both about **test validity / coverage**, not the core design itself.

## Strengths

- **The headless/backend seam is now well-factored.** Extracting `resolveLaunchSpec()` above backend selection still matches the amount of launch normalization currently buried in `launchSubagent()` (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:33-35,1457-1571`; current code in `pi-extension/subagents/index.ts:697-965`).
- **The pi transcript contract is now much more truthful.** Replacing the v6 cast with `projectPiMessageToTranscript(...)` is the right remediation for the real pi-ai `UserMessage` shape (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:2028-2071,2312-2407`; `node_modules/@mariozechner/pi-ai/dist/types.d.ts:117-139`).
- **Release sequencing is called out clearly.** The warning about not shipping Phase 1 preflight changes without the real headless backend is explicit and actionable (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:511-515,1696-1720`).

## Prioritized findings

### 1) The pane-Claude E2E restriction test still does not reliably prove that Bash was blocked or allowed

**Severity: Moderate**

The plan correctly keeps a real pane-Claude end-to-end restriction test as the shell-boundary guard (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:3183-3267`). But the proposed assertions still key off whether the assistant text contains `HELLO_FROM_BASH_42`:

- restricted case: assert the response does **not** include the marker (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:3224-3245`)
- unrestricted case: assert the response **does** include the marker (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:3247-3261`)

That is not a trustworthy execution oracle for a security-sensitive test:

- a compliant refusal can still quote the requested command or marker text (false failure in the restricted case)
- the model can emit the marker text without actually invoking Bash (false pass in the unrestricted case)

So the test can pass or fail based on model phrasing instead of actual tool availability. Because this is the only proposed pane-Claude **E2E** proof that `--tools` survived shell assembly, the current assertion shape is too weak.

#### Recommended fix

Make the assertion depend on an observable side effect, not assistant prose. For example:

- run in a temp directory
- ask Bash to create/write a uniquely named file
- restricted case: assert the file does **not** appear
- unrestricted case: assert the file **does** appear and contains the expected payload

If filesystem side effects are undesirable, use another externally verifiable artifact rather than checking whether the assistant happened to repeat a marker string.

### 2) The “headline” no-mux integration gate only tests forced headless mode, not the default auto/no-mux fallback the feature is actually selling

**Severity: Moderate**

The plan’s stated goal is that orchestration works in environments without a mux, and the architecture explicitly says backend selection falls back to headless in `PI_SUBAGENT_MODE=auto` (the default) (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:5,34-35`). The file-structure summary and Task 23b then present `orchestration-headless-no-mux.test.ts` as the “headline gate” proving the real registered tool path reaches headless (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:63,4474-4479`).

But the actual test forces `process.env.PI_SUBAGENT_MODE = "headless"` before execution (`.pi/plans/2026-04-20-mux-free-execution-design-v7.md:4563-4568`). That means it never exercises the default **auto + no mux** path. If `selectBackend()` or the preflight wiring regressed only in auto mode, this headline gate would still pass.

That distinction matters in this repo because mux detection is real environment logic, not a trivial constant: current code uses runtime env vars plus command availability to decide whether a mux exists (`pi-extension/subagents/cmux.ts:30-83`). Forced headless and auto/no-mux are adjacent, but not the same path.

#### Recommended fix

Keep the current forced-headless case, but add a companion case with:

- `PI_SUBAGENT_MODE` unset (or explicitly `auto`)
- mux env vars cleared
- the same registered-tool callback execution

That would make the end-to-end gate actually cover the user-default behavior advertised in the goal and architecture sections.

## Assessment

**Ready to merge: With fixes**

I do **not** see a new major design blocker in v7. The prior major issues around transcript truthfulness and Claude test flag placement are addressed well.

What remains are two moderate validation issues:

1. the pane-Claude E2E restriction test still uses assistant text as a proxy for actual Bash execution
2. the no-mux orchestration integration gate only proves forced headless, not default auto fallback

If those are tightened, I’d be comfortable calling this plan ready.
