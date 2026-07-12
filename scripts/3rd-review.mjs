#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { MockBroker, createMockAdapter } from "../lib/v3/mock-broker.mjs";
import { LiveBroker } from "../lib/v3/live-broker.mjs";
import { loadConfig } from "../lib/v3/config.mjs";
import { CliSupervisor } from "../lib/v3/supervisor.mjs";
import { ProtocolError, createMaterial, validateRequest } from "../lib/v3/protocol.mjs";

function usage() {
  return [
    "Usage:",
    "  3rd-review validate --request=<request.json>",
    "  3rd-review run --request=<request.json> --config=<config.json> [--output=<result.json>] [--runtime-root=<dir>]",
    "  3rd-review status --runtime-id=<id> [--runtime-root=<dir>]",
    "  3rd-review cancel --runtime-id=<id> --provider=<id> --attempt-id=<id> --nonce=<nonce> [--runtime-root=<dir>]",
    "  3rd-review read-private --runtime-id=<id> --provider=<id> --nonce=<nonce> --ref=raw|diagnostic|receipt [--runtime-root=<dir>]",
    "  3rd-review resume|repair --runtime-id=<id> --provider=<id> --session-id=<id> --material-hash=<sha256> --nonce=<nonce> --resume-input=<text> --config=<config.json>",
    "",
    "--adapter=mock remains a protocol fixture; all normal commands use the durable direct-CLI broker.",
  ].join("\n");
}

function value(name) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(3).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function required(name) {
  const result = value(name);
  if (!result) throw new ProtocolError("REQUEST_INVALID", `--${name} is required`);
  return result;
}

function runtimeRoot() { return value("runtime-root") ?? path.join(tmpdir(), "3rd-review"); }
function broker() { return new LiveBroker({ supervisor: new CliSupervisor({ runtimeRoot: runtimeRoot() }) }); }

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
  if (command === "validate") {
    const request = readJson(value("request"), "--request");
    console.log(JSON.stringify(validateRequest(request), null, 2));
    return 0;
  }
  if (command === "status") {
    console.log(JSON.stringify(broker().status(required("runtime-id")), null, 2));
    return 0;
  }
  if (command === "cancel") {
    console.log(JSON.stringify({ cancelled: broker().cancel({ runtime_id: required("runtime-id"), provider_id: required("provider"), attempt_id: required("attempt-id"), nonce: required("nonce") }) }));
    return 0;
  }
  if (command === "read-private") {
    console.log(JSON.stringify(broker().readPrivate({ runtime_id: required("runtime-id"), provider: required("provider"), nonce: required("nonce"), ref: required("ref") }), null, 2));
    return 0;
  }
  if (command === "resume" || command === "repair") {
    const config = loadConfig(value("config"));
    const args = { runtime_id: required("runtime-id"), provider_id: required("provider"), session_id: required("session-id"), material_hash: required("material-hash"), nonce: required("nonce"), resume_input: required("resume-input"), config, options: { cwd: value("cwd") ?? process.cwd() } };
    console.log(JSON.stringify(await broker()[command](args), null, 2));
    return 0;
  }
  if (command !== "run") throw new ProtocolError("REQUEST_INVALID", `unknown command: ${command}`);
  const request = readJson(value("request"), "--request");
  const output = value("output");
  if (value("adapter") === "mock") {
    if (!output) throw new ProtocolError("REQUEST_INVALID", "--output is required for --adapter=mock");
    const adapter = createMockAdapter({
      id: "mock",
      execute: async (ctx) => ({ raw: JSON.stringify({ transport: "mock", input_hash: ctx.material.input_hash }), session_id: "mock-session", execution_eligible: true, metrics: { elapsed_ms: 0, turns: 1, input_bytes: ctx.material.bytes, output_bytes: createMaterial("mock").bytes, retry_count: 0 } }),
    });
    const result = await new MockBroker().run(request, { config: { version: 3, phase: 0 }, adapter });
    atomicWrite(output, result);
    console.log(JSON.stringify({ request_id: result.request_id, output: path.resolve(output) }));
    return 0;
  }
  const config = loadConfig(value("config"));
  const result = await broker().run({ request, config, host_provider: value("host-provider"), host_verified: value("host-verified") !== "false", options: { cwd: value("cwd") ?? process.cwd() } });
  if (output) atomicWrite(output, result);
  console.log(JSON.stringify(result, null, 2));
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
