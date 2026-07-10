#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
for await (const _chunk of process.stdin) {}
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "manifest.json"), "utf8"));
let n = 0;
for (const entry of manifest.entries) for (const chunk of entry.chunks) {
  const id = `read-${++n}`, filePath = path.join(process.cwd(), chunk.path);
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath, offset: 1, limit: Math.max(1, chunk.lines) } }] } }) + "\n");
  const source = fs.readFileSync(filePath, "utf8"), lines = source === "" ? [] : source.replace(/\n$/u, "").split("\n");
  const content = lines.map((line, index) => `${String(index + 1).padStart(6, " ")}→${line}`).join("\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: content }] }] } }) + "\n");
}
process.stdout.write(JSON.stringify({ type: "result", structured_output: { verdict: "pass", findings: [], resolutionSummary: "scoped" } }) + "\n");
