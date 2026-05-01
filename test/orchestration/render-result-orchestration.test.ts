import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@mariozechner/pi-coding-agent";
import {
  renderRichSubagentResult,
  toTaskRows,
  type TaskRow,
  type RichMode,
} from "../../pi-extension/subagents/ui/headless-render.ts";

initTheme();

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("renderRichSubagentResult", () => {
  it("returns a Component whose render(80) is callable", () => {
    const component = renderRichSubagentResult({
      mode: "serial" as RichMode,
      results: [] as TaskRow[],
      expanded: false,
      theme: fakeTheme,
    });
    assert.equal(typeof component.render, "function");
    const lines = component.render(80);
    assert.ok(Array.isArray(lines));
  });

  it("toTaskRows is exported and maps an empty list", () => {
    assert.equal(typeof toTaskRows, "function");
    assert.deepEqual(toTaskRows([]), []);
  });
});
