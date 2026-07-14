import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { probeFileOnlySandbox, verifyManagedWrapper } from "../lib/attachment-sandbox.mjs";
import { execute } from "../lib/process.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-managed-wrapper-"));
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const options = (root) => ({ root, owner: process.getuid(), chainRoot: root });
function fixture() {
  const root = temp(); const nested = path.join(root, "v1"); const command = path.join(nested, "wrapper"); fs.mkdirSync(nested, { mode: 0o700 }); fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o500 }); fs.chmodSync(root, 0o700); fs.chmodSync(nested, 0o700); fs.chmodSync(command, 0o500);
  return { root, command, config: () => ({ command, args: [], sha256: digest(command), provider_visible_root: "/attachments" }) };
}

test("managed wrapper path accepts a secure non-symlink hierarchy", () => {
  const value = fixture(); assert.equal(verifyManagedWrapper(value.config(), options(value.root)), true);
});

test("managed wrapper path rejects a user-writable parent", () => {
  const value = fixture(); fs.chmodSync(path.dirname(value.command), 0o777); assert.equal(verifyManagedWrapper(value.config(), options(value.root)), false);
});

test("managed wrapper revalidation rejects replacement after an earlier check", () => {
  const value = fixture(); const policy = value.config(); assert.equal(verifyManagedWrapper(policy, options(value.root)), true); fs.chmodSync(value.command, 0o700); fs.writeFileSync(value.command, "#!/bin/sh\necho replaced\n"); fs.chmodSync(value.command, 0o500); assert.equal(verifyManagedWrapper(policy, options(value.root)), false);
});

test("spawn-time wrapper recheck blocks a replacement race before execution", async () => {
  const value = fixture(); const policy = value.config(); assert.equal(verifyManagedWrapper(policy, options(value.root)), true); fs.chmodSync(value.command, 0o700); fs.writeFileSync(value.command, "#!/bin/sh\nexit 99\n"); fs.chmodSync(value.command, 0o500);
  const result = await execute({ command: value.command, argv: [], cwd: value.root, env: process.env, input: null, redact: [], beforeSpawn: () => { if (!verifyManagedWrapper(policy, options(value.root))) { const error = new Error("wrapper changed"); error.code = "ATTACHMENT_SANDBOX_UNAVAILABLE"; throw error; } } }, { maxOutputBytes: 1024 });
  assert.equal(result.ok, false); assert.equal(result.error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
});

test("managed root nested under a writable ancestor is rejected", () => {
  const base = temp(); const root = path.join(base, "managed"); const nested = path.join(root, "v1"); const command = path.join(nested, "wrapper"); fs.mkdirSync(nested, { recursive: true, mode: 0o700 }); fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o500 }); fs.chmodSync(base, 0o777); fs.chmodSync(root, 0o700); fs.chmodSync(nested, 0o700); fs.chmodSync(command, 0o500);
  assert.equal(verifyManagedWrapper({ command, args: [], sha256: digest(command), provider_visible_root: "/attachments" }, { root, owner: process.getuid(), chainRoot: base }), false);
});

test("sandbox probe rejects a wrapper that exposes a workdir file outside bundle", () => {
  const value = fixture(); const workdir = path.join(value.root, "work"); const bundle = path.join(workdir, "bundle"); fs.mkdirSync(bundle, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(bundle, "review-packet.v1.json"), "packet", { mode: 0o400 });
  // This fixture maps only /attachments to the bundle but leaves the third
  // sentinel (the workdir sibling) readable. The probe must fail closed.
  fs.chmodSync(value.command, 0o700); fs.writeFileSync(value.command, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
const dash = process.argv.indexOf("--");
const bundle = process.argv.find((value) => value.startsWith("--bundle=")).slice("--bundle=".length);
const inner = process.argv.slice(dash + 1);
inner[3] = path.join(bundle, inner[3].slice("/attachments/".length));
inner[4] = "/unreadable-a"; inner[5] = "/unreadable-b"; inner[7] = "/unreadable-c";
const result = spawnSync(inner[0], inner.slice(1), { encoding: "utf8" });
process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status ?? 1);
`, { mode: 0o500 }); fs.chmodSync(value.command, 0o500);
  assert.equal(probeFileOnlySandbox(value.config(), bundle, workdir, options(value.root)), false);
});
