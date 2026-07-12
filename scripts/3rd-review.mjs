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

async function main() {
  const command = process.argv[2]; if (!command || command === "help" || command === "--help") { console.log(usage()); return; }
  const broker = new Broker(loadConfig(value("config") ?? undefined));
  if (command === "doctor") console.log(JSON.stringify(await broker.doctor(), null, 2));
  else if (command === "run") console.log(JSON.stringify(await broker.run(json(required("request"))), null, 2));
  else if (command === "status") console.log(JSON.stringify(broker.status(required("runtime-id")), null, 2));
  else if (command === "cancel") console.log(JSON.stringify(broker.cancel(required("runtime-id"), required("provider")), null, 2));
  else throw new ReviewError("REQUEST_INVALID", `unknown command: ${command}`);
}
main().catch((error) => { console.error(JSON.stringify({ error: publicError(error) })); process.exitCode = 2; });
