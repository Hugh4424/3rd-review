#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const bundle = process.argv[2];
if (!bundle) process.exit(2);

let bundleRoot;
try { bundleRoot = fs.realpathSync(bundle); }
catch { process.exit(2); }

// A prompt-only review has no frozen bundle and therefore no control file.
// The server must still start and advertise an empty file set: exiting here
// makes Cursor report the allowlisted MCP server as missing, which provokes
// retries and degraded tool events that supervision cannot attribute.
const controlFile = path.join(bundleRoot, "attachments-manifest.json");
let allowed = new Map();
if (fs.existsSync(controlFile)) try {
  const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
  if (!Array.isArray(control.files) || control.files.length === 0) throw new Error();
  allowed = new Map(control.files.map((file) => {
    if (!file || typeof file.target !== "string" || !file.target || path.isAbsolute(file.target) || file.target.split(/[\\/]/).includes("..") || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error();
    return [file.target, { sha256: file.sha256, size: file.size }];
  }));
  if (allowed.size !== control.files.length) throw new Error();
} catch { process.exit(2); }

function resolveFile(relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.startsWith("~") || relative.split(/[\\/]/).includes("..")) throw new Error("path must be relative to the frozen bundle");
  if (!allowed.has(relative)) throw new Error("path is not declared by the broker attachment manifest");
  const target = fs.realpathSync(path.join(bundleRoot, relative));
  if (target !== bundleRoot && !target.startsWith(`${bundleRoot}${path.sep}`)) throw new Error("path escapes the frozen bundle");
  if (!fs.statSync(target).isFile()) throw new Error("path is not a regular file");
  return target;
}

function readFile(relative) {
  const contents = fs.readFileSync(resolveFile(relative), "utf8");
  const expected = allowed.get(relative);
  if (Buffer.byteLength(contents) !== expected.size || createHash("sha256").update(contents).digest("hex") !== expected.sha256) throw new Error("file no longer matches the broker attachment manifest");
  return contents;
}

const tools = [
  {
    name: "list_bundle",
    description: "List the immutable review files available in the hash-verified bundle.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_bundle",
    description: "Read one UTF-8 review file by its relative path inside the immutable bundle.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path returned by list_bundle" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function error(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } })}\n`);
}

function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "third-review-bundle", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") { result(message.id, {}); return; }
  if (message.method === "tools/list") { result(message.id, { tools }); return; }
  if (message.method === "tools/call") {
    try {
      if (message.params?.name === "list_bundle") {
        result(message.id, { content: [{ type: "text", text: [...allowed.keys()].sort().join("\n") }] });
        return;
      }
      if (message.params?.name === "read_bundle") {
        const text = readFile(message.params?.arguments?.path);
        result(message.id, { content: [{ type: "text", text }] });
        return;
      }
      throw new Error("unknown bundle tool");
    } catch {
      result(message.id, { isError: true, content: [{ type: "text", text: "bundle request rejected" }] });
    }
    return;
  }
  if (Object.hasOwn(message, "id")) error(message.id, "method not found");
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split(/\r?\n/); buffered = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
