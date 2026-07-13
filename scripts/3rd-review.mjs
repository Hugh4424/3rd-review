#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { loadConfig } from "../lib/config.mjs";
import { publicError, ReviewError } from "../lib/errors.mjs";

function value(name) { const prefix = `--${name}=`; return process.argv.slice(3).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null; }
function required(name) { const result = value(name); if (!result) throw new ReviewError("REQUEST_INVALID", `--${name} is required`); return result; }
function json(file) { try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); } catch (error) { throw new ReviewError("REQUEST_INVALID", `cannot read ${file}: ${error.message}`); } }
function usage() { return "Usage: 3rd-review <doctor|run|status|cancel> --config=<config.json> [--request=<request.json>]\n  doctor: verify CLI executables without a model call\n  run: execute the configured cross-provider review\n  status: --runtime-id=<uuid>\n  cancel: --runtime-id=<uuid> --provider=<id>"; }
function validateArgs(command) {
  const allowed = { doctor: new Set(["config"]), run: new Set(["config", "request"]), status: new Set(["config", "runtime-id"]), cancel: new Set(["config", "runtime-id", "provider"]) }[command];
  if (!allowed) throw new ReviewError("REQUEST_INVALID", `unknown command: ${command}`);
  for (const arg of process.argv.slice(3)) {
    const match = arg.match(/^--([a-z-]+)=.+$/);
    if (!match || !allowed.has(match[1])) throw new ReviewError("REQUEST_INVALID", `unsupported argument for ${command}: ${arg}`);
  }
}

let activeBroker = null;
let shutdownSignal = null;
let forcedExit = null;
function shutdown(signal) {
  if (shutdownSignal) return;
  shutdownSignal = signal;
  activeBroker?.shutdown();
  forcedExit = setTimeout(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)), 6_000);
  forcedExit.unref();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  const command = process.argv[2]; if (!command || command === "help" || command === "--help") { console.log(usage()); return; }
  validateArgs(command);
  const broker = new Broker(loadConfig(value("config") ?? undefined)); activeBroker = broker;
  if (command === "doctor") console.log(JSON.stringify(await broker.doctor(), null, 2));
  else if (command === "run") console.log(JSON.stringify(await broker.run(json(required("request"))), null, 2));
  else if (command === "status") console.log(JSON.stringify(broker.status(required("runtime-id")), null, 2));
  else if (command === "cancel") console.log(JSON.stringify(broker.cancel(required("runtime-id"), required("provider")), null, 2));
}
main().catch((error) => { console.error(JSON.stringify({ error: publicError(error) })); process.exitCode = 2; }).finally(() => {
  if (forcedExit) clearTimeout(forcedExit);
  if (shutdownSignal) process.exitCode = 128 + (shutdownSignal === "SIGINT" ? 2 : 15);
});
