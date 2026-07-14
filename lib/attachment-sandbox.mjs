import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fail } from "./errors.mjs";

// Trusted external wrapper contract:
//   wrapper ... --3rd-review-probe --bundle=<dir> --sentinel=<host-file>
// emits {"version":1,"sentinel_readable":false}; --3rd-review-run receives
// --bundle/--workdir followed by -- command argv and enforces the same ACL.
function probe(config, requestedBundle = null) {
  if (!trustedWrapper(config)) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-sandbox-probe-")); const bundle = requestedBundle ?? path.join(root, "bundle"); const sentinel = path.join(root, "host-sentinel");
  if (!requestedBundle) { fs.mkdirSync(bundle, { mode: 0o700 }); fs.writeFileSync(path.join(bundle, "attachment-probe.txt"), "provider-visible", { mode: 0o400 }); fs.chmodSync(bundle, 0o500); }
  fs.writeFileSync(sentinel, "host-only", { mode: 0o600 });
  try { const result = spawnSync(config.command, [...config.args, "--3rd-review-probe", `--bundle=${bundle}`, `--sentinel=${sentinel}`], { encoding: "utf8", timeout: 5_000 }); const value = JSON.parse(result.stdout || "{}"); return result.status === 0 && value?.version === 1 && value.sentinel_readable === false; }
  catch { return false; } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function trustedWrapper(config) {
  if (!config?.trusted || !fs.existsSync(config.command)) return false;
  try {
    const target = fs.realpathSync(config.command); const stat = fs.lstatSync(target); const owned = stat.uid === process.getuid() || stat.uid === 0;
    return stat.isFile() && !stat.isSymbolicLink() && owned && (stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0 && createHash("sha256").update(fs.readFileSync(target)).digest("hex") === config.sha256;
  } catch { return false; }
}
export function hasConfiguredFileOnlySandbox(config, bundle = null) { return probe(config?.file_only_sandbox, bundle); }
export function fileOnlySandboxProbe() { return { ready: false, reason: "NO_VERIFIED_FILE_ONLY_SANDBOX_WRAPPER" }; }
export function requireFileOnlySandbox(config, plan, bundle, workdir) {
  if (!hasConfiguredFileOnlySandbox(config, bundle)) fail("ATTACHMENT_SANDBOX_UNAVAILABLE", "NO_VERIFIED_FILE_ONLY_SANDBOX_WRAPPER");
  const sandbox = config.file_only_sandbox;
  return { ...plan, command: sandbox.command, argv: [...sandbox.args, "--3rd-review-run", `--bundle=${bundle}`, `--workdir=${workdir}`, "--", plan.command, ...plan.argv] };
}
