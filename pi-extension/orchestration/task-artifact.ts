import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeOrchestrationTaskArtifact(args: {
  artifactDir: string;
  orchestrationId: string;
  taskIndex: number;
  finalMessage: string;
}): string | null {
  if (!args.finalMessage || args.finalMessage.length === 0) return null;
  try {
    const dir = join(args.artifactDir, "orchestrations", args.orchestrationId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `task-${args.taskIndex}.md`);
    writeFileSync(path, args.finalMessage, "utf8");
    return path;
  } catch {
    return null;
  }
}
