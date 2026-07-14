import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyManagedWrapper } from "../lib/attachment-sandbox.mjs";
import { execute } from "../lib/process.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-managed-wrapper-"));
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture() {
  const root = temp(); const nested = path.join(root, "v1"); const command = path.join(nested, "wrapper"); fs.mkdirSync(nested, { mode: 0o700 }); fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o500 }); fs.chmodSync(root, 0o700); fs.chmodSync(nested, 0o700); fs.chmodSync(command, 0o500);
  return { root, command, config: () => ({ command, args: [], sha256: digest(command), provider_visible_root: "/attachments" }) };
}

test("managed wrapper path accepts a secure non-symlink hierarchy", () => {
  const value = fixture(); assert.equal(verifyManagedWrapper(value.config(), { root: value.root, owner: process.getuid() }), true);
});

test("managed wrapper path rejects a user-writable parent", () => {
  const value = fixture(); fs.chmodSync(path.dirname(value.command), 0o777); assert.equal(verifyManagedWrapper(value.config(), { root: value.root, owner: process.getuid() }), false);
});

test("managed wrapper revalidation rejects replacement after an earlier check", () => {
  const value = fixture(); const policy = value.config(); assert.equal(verifyManagedWrapper(policy, { root: value.root, owner: process.getuid() }), true); fs.chmodSync(value.command, 0o700); fs.writeFileSync(value.command, "#!/bin/sh\necho replaced\n"); fs.chmodSync(value.command, 0o500); assert.equal(verifyManagedWrapper(policy, { root: value.root, owner: process.getuid() }), false);
});

test("spawn-time wrapper recheck blocks a replacement race before execution", async () => {
  const value = fixture(); const policy = value.config(); assert.equal(verifyManagedWrapper(policy, { root: value.root, owner: process.getuid() }), true); fs.chmodSync(value.command, 0o700); fs.writeFileSync(value.command, "#!/bin/sh\nexit 99\n"); fs.chmodSync(value.command, 0o500);
  const result = await execute({ command: value.command, argv: [], cwd: value.root, env: process.env, input: null, redact: [], beforeSpawn: () => { if (!verifyManagedWrapper(policy, { root: value.root, owner: process.getuid() })) { const error = new Error("wrapper changed"); error.code = "ATTACHMENT_SANDBOX_UNAVAILABLE"; throw error; } } }, { maxOutputBytes: 1024 });
  assert.equal(result.ok, false); assert.equal(result.error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
});
