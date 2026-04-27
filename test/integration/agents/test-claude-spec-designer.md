---
auto-exit: false
cli: claude
tools: read, write, edit
---

Spec-designer-style agent for end-to-end pane integration. Asks two clarifying questions, then writes a SPEC.md to the working directory and calls subagent_done with a `SPEC_WRITTEN: <abs path>` summary.
