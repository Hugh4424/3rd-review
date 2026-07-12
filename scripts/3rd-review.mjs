#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockBroker, createMockAdapter } from "../lib/v3/mock-broker.mjs";
import { ProtocolError, createMaterial, validateRequest } from "../lib/v3/protocol.mjs";

function usage() {
  return [
    "Usage:",
    "  3rd-review validate --request=<request.json>",
    "  3rd-review run --request=<request.json> --output=<result.json> --adapter=mock",
    "",
    "Phase 0 only freezes the generic protocol and ships a mock integration baseline.",
    "It does not dispatch real providers; that starts in later phases.",
  ].join("\n");
}

function value(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(3).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function readJson(file, label) {
  if (!file) throw new ProtocolError("REQUEST_INVALID", `${label} is required`);
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    throw new ProtocolError("REQUEST_INVALID", `${label} is not readable JSON: ${error.message}`);
  }
}

function atomicWrite(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

async function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "help" || !command) {
    console.log(usage());
    return 0;
  }
  const request = readJson(value("request"), "--request");
  if (command === "validate") {
    console.log(JSON.stringify(validateRequest(request), null, 2));
    return 0;
  }
  if (command !== "run") throw new ProtocolError("REQUEST_INVALID", `unknown command: ${command}`);
  if (value("adapter") !== "mock") throw new ProtocolError("UNSUPPORTED", "Phase 0 supports only --adapter=mock");
  const output = value("output");
  if (!output) throw new ProtocolError("REQUEST_INVALID", "--output is required");
  const adapter = createMockAdapter({
    id: "mock",
    execute: async (ctx) => ({
      raw: JSON.stringify({ transport: "mock", input_hash: ctx.material.input_hash }),
      session_id: "mock-session",
      execution_eligible: true,
      metrics: { elapsed_ms: 0, turns: 1, input_bytes: ctx.material.bytes, output_bytes: createMaterial("mock").bytes, retry_count: 0 },
    }),
  });
  const result = await new MockBroker().run(request, { config: { version: 3, phase: 0 }, adapter });
  atomicWrite(output, result);
  console.log(JSON.stringify({ request_id: result.request_id, output: path.resolve(output) }));
  return 0;
}

main().then((code) => process.exitCode = code).catch((error) => {
  const body = error instanceof ProtocolError
    ? { error_code: error.code, error: error.message }
    : { error_code: "INTERNAL_ERROR", error: error instanceof Error ? error.message : String(error) };
  console.error(JSON.stringify(body));
  process.exitCode = 2;
});

export const __entrypoint = fileURLToPath(import.meta.url);
