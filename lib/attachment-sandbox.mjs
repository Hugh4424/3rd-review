import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.mjs";

// A provider process and its model tools share an OS process.  A cwd or a
// system prompt is therefore not a security boundary.  We only enable
// file_only after an OS sandbox can prove a deny-by-default path ACL.
//
// macOS still ships sandbox-exec, but it is deprecated and its minimal ACL
// profile cannot execute a normal provider binary in this runtime without
// reopening host paths.  Keep the probe explicit and fail closed instead of
// claiming that a provider-private cwd is isolation.
export function fileOnlySandboxProbe() {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) return { ready: false, reason: "NO_VERIFIED_FILE_ONLY_SANDBOX" };
  const profile = "(version 1) (deny default) (allow process*) (allow file-read* (subpath \"/__3rd_review_bundle_only__\"))";
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/true"], { encoding: "utf8", timeout: 2_000 });
  return result.status === 0 ? { ready: true, reason: null } : { ready: false, reason: "DARWIN_SANDBOX_PATH_ACL_UNVERIFIED" };
}

export function requireFileOnlySandbox() {
  const probe = fileOnlySandboxProbe();
  if (!probe.ready) fail("ATTACHMENT_SANDBOX_UNAVAILABLE", probe.reason);
  // A future supported platform must wrap the provider plan here, and its
  // probe must prove a host sentinel unreadable before returning ready.
  fail("ATTACHMENT_SANDBOX_UNAVAILABLE", "NO_PROVIDER_SANDBOX_WRAPPER");
}
