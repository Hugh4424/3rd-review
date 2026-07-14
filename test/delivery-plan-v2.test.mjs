import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalDeliveryManifestHash, canonicalInnerManifestHash, canonicalMaterialManifestHash, canonicalPacketHash, planDelivery, validateAttachments, validateContinuationTriad, validateFileOnlyTriad } from "../lib/attachments.mjs";
import { Broker } from "../lib/broker.mjs";
import { loadConfig, validateConfig, validateSystemFileOnlyPolicy } from "../lib/config.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-delivery-plan-v2-"));
const capture = path.resolve("test/capture-cli.mjs");

function source(label = "", delivery = "file_only") {
  const root = temp();
  const diff = `DIFF_HEAD\n${"x".repeat(24 * 1024)}\nDIFF_MIDDLE\n${"y".repeat(24 * 1024)}\nDIFF_TAIL\n${label}`;
  const packet = { version: "review-packet.v1", manifest_hash: canonicalMaterialManifestHash("v2", [{ target: "changes.diff", sha256: sha(diff), size: Buffer.byteLength(diff), embed: true }]), diff_sha256: sha(diff) }; packet.packet_hash = canonicalPacketHash(packet);
  const files = [["review-packet.v1.json", `${JSON.stringify(packet)}\n`], ["changes.diff", diff]];
  for (const [name, value] of files) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  }
  const attachments = files.map(([destination, value]) => ({ destination, sha256: sha(value), size: Buffer.byteLength(value) }));
  const outerFiles = [...attachments.map(({ destination: target, sha256, size }) => ({ target, sha256, size, embed: true })), { target: "manifest.json", sha256: "0".repeat(64), size: 0, embed: true }];
  const manifest = { version: "review-attachment-manifest.v1", delivery_mode: delivery, packet_hash: packet.packet_hash, manifest_hash: packet.manifest_hash, diff_sha256: packet.diff_sha256, attachments, delivery_manifest_hash: canonicalDeliveryManifestHash("v2", outerFiles, delivery) }; manifest.inner_manifest_hash = canonicalInnerManifestHash(manifest);
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const all = [...files, ["manifest.json", `${JSON.stringify(manifest)}\n`]];
  return {
    root,
    packet,
    attachmentManifest: { version: 1, bundle_id: "v2", entries: all.map(([source, value]) => ({ source, destination: source, size: Buffer.byteLength(value), sha256: sha(value), embed: true })) },
  };
}

function config(runtime, root, provider, maxPromptBytes = 1024 * 1024) {
  return validateConfig({ version: 4, runtime: { root: runtime, ttl_hours: 24, max_prompt_bytes: maxPromptBytes, max_output_bytes: 100_000, max_attachment_bytes: 2 * 1024 * 1024, liveness_interval_ms: 5, idle_timeout_ms: 0, max_duration_ms: 1_000, orphan_timeout_ms: 100 }, attachment_roots: [{ root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }], tiers: [[provider]], providers: { [provider]: { enabled: true, command: capture, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] } } });
}

function continuationDelta(initialMaterialHash, sequence = 1, previous_delivery_manifest_hash = null, label = "") {
  const delta = source(label); const innerPath = path.join(delta.root, "manifest.json"); const inner = JSON.parse(fs.readFileSync(innerPath, "utf8")); inner.continuation = { initial_material_manifest_hash: initialMaterialHash, sequence, previous_delivery_manifest_hash }; inner.inner_manifest_hash = canonicalInnerManifestHash(inner); fs.writeFileSync(innerPath, `${JSON.stringify(inner)}\n`); const entry = delta.attachmentManifest.entries.find((item) => item.destination === "manifest.json"); const bytes = fs.readFileSync(innerPath); entry.size = bytes.length; entry.sha256 = sha(bytes); return delta;
}

function continuationSandbox() {
  const directory = temp(); const command = path.join(directory, "trusted-test-wrapper.mjs");
  fs.writeFileSync(command, `#!/usr/bin/env node\nimport { spawnSync } from \"node:child_process\";\nconst args = process.argv.slice(2);\nif (args.includes(\"--3rd-review-probe\")) { console.log(JSON.stringify({ version: 1, sentinel_readable: false })); process.exit(0); }\nconst marker = args.indexOf(\"--\"); const child = spawnSync(args[marker + 1], args.slice(marker + 2), { stdio: \"inherit\" }); process.exit(child.status ?? 1);\n`, { mode: 0o500 });
  return { command, args: [] };
}

function sandboxExecProbeWrapper() {
  const directory = temp(); const command = path.join(directory, "sandbox-exec-probe-wrapper.sh");
  fs.writeFileSync(command, `#!/bin/sh
for arg in "$@"; do case "$arg" in --sentinel=*) sentinel="\${arg#--sentinel=}";; esac; done
if [ "$1" = "--3rd-review-probe" ]; then
  policy="(version 1) (deny default) (allow process-exec) (allow process-fork) (allow file-read*) (deny file-read* (literal \\\"$sentinel\\\"))"
  /usr/bin/sandbox-exec -p "$policy" /usr/bin/cat "$sentinel" >/dev/null 2>&1
  if [ "$?" -ne 0 ]; then printf '{"version":1,"sentinel_readable":false}\\n'; exit 0; fi
  printf '{"version":1,"sentinel_readable":true}\\n'; exit 1
fi
exit 64
`, { mode: 0o500 });
  return { command, args: [] };
}

test("a caller-forged wrapper object cannot enable file_only", async () => {
  const input = source(); const value = config(temp(), input.root, "opencode"); value.file_only_sandbox = { command: continuationSandbox().command, args: [], sha256: "0".repeat(64), provider_visible_root: "/attachments", trusted: true };
  const report = await new Broker(value).doctor({ attachmentRoot: input.root }); const provider = report.providers.find((item) => item.provider === "opencode");
  assert.equal(provider.status, "ready"); assert.doesNotMatch(JSON.stringify(provider.capabilities), /file_only/);
});

test("system sandbox policy parser is separate from caller configuration", () => {
  const policy = validateSystemFileOnlyPolicy({ command: "/usr/local/libexec/3rd-review-wrapper", args: ["--locked"], sha256: "a".repeat(64), provider_visible_root: "/attachments" });
  assert.deepEqual(policy, { command: "/usr/local/libexec/3rd-review-wrapper", args: ["--locked"], sha256: "a".repeat(64), provider_visible_root: "/attachments" });
  assert.throws(() => validateConfig({ version: 4, runtime: {}, file_only_sandbox: policy, tiers: [["opencode"]], providers: { opencode: { command: capture, auth: { type: "native" } } } }), { code: "CONFIG_INVALID" });
});

test("loaded broker config is frozen so caller mutation cannot alter a capability fingerprint", () => {
  const input = source(); const raw = config(temp(), input.root, "opencode"); const file = path.join(temp(), "caller-config.json"); fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 }); const loaded = loadConfig(file);
  assert.ok(Object.isFrozen(loaded)); assert.ok(Object.isFrozen(loaded.runtime)); assert.throws(() => { loaded.runtime.root = "/attacker"; }, TypeError);
});

test("file_only never starts OpenCode before a verified external sandbox wrapper", async () => {
  const input = source(); const runtime = temp();
  const result = await new Broker(config(runtime, input.root, "opencode")).run({ version: 4, host_provider: "codex", prompt: "SHORT_REVIEW_INSTRUCTION", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
  assert.equal(result.providers[0].delivery_used, "file_only");
  assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
});

test("file_only reports missing trusted sandbox before provider delivery capability", async () => {
  const input = source(); const result = await new Broker(config(temp(), input.root, "codex")).run({ version: 4, host_provider: "kimi", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
});

test("file_only fails closed before provider execution when the OS sandbox cannot prove its path ACL", async () => {
  const input = source(); const result = await new Broker(config(temp(), input.root, "opencode")).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
  assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
});

test("file_only rejects a triad whose inner manifest omits a delivered file", async () => {
  const input = source(); const invalid = JSON.parse(fs.readFileSync(path.join(input.root, "manifest.json"), "utf8"));
  invalid.attachments.pop(); fs.writeFileSync(path.join(input.root, "manifest.json"), `${JSON.stringify(invalid)}\n`);
  const manifestEntry = input.attachmentManifest.entries.find((item) => item.destination === "manifest.json"); const bytes = fs.readFileSync(path.join(input.root, "manifest.json")); manifestEntry.size = bytes.length; manifestEntry.sha256 = sha(bytes);
  const runtime = temp(); const result = await new Broker(config(runtime, input.root, "kimi")).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
  assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
});

test("file_only rejects a paired packet and inner-manifest forgery even when the diff is unchanged", async () => {
  const input = source(); const packetPath = path.join(input.root, "review-packet.v1.json"); const packet = JSON.parse(fs.readFileSync(packetPath, "utf8")); packet.acceptance_design_excerpt = "FORGED_PACKET_CONTEXT"; fs.writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);
  const packetEntry = input.attachmentManifest.entries.find((item) => item.destination === "review-packet.v1.json"); const bytes = fs.readFileSync(packetPath); packetEntry.size = bytes.length; packetEntry.sha256 = sha(bytes); const innerPath = path.join(input.root, "manifest.json"); const inner = JSON.parse(fs.readFileSync(innerPath, "utf8")); const innerPacket = inner.attachments.find((item) => item.destination === "review-packet.v1.json"); innerPacket.size = bytes.length; innerPacket.sha256 = sha(bytes); const outerFiles = input.attachmentManifest.entries.map(({ destination: target, sha256, size, embed }) => ({ target, sha256, size, embed })); inner.delivery_manifest_hash = canonicalDeliveryManifestHash(input.attachmentManifest.bundle_id, outerFiles, "file_only"); inner.inner_manifest_hash = canonicalInnerManifestHash(inner); fs.writeFileSync(innerPath, `${JSON.stringify(inner)}\n`); const innerEntry = input.attachmentManifest.entries.find((item) => item.destination === "manifest.json"); const innerBytes = fs.readFileSync(innerPath); innerEntry.size = innerBytes.length; innerEntry.sha256 = sha(innerBytes);
  const result = await new Broker(config(temp(), input.root, "opencode")).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
});

test("file_only outer canonical binds delivery mode and embed semantics", () => {
  const input = source(); input.attachmentManifest.entries.find((item) => item.destination === "changes.diff").embed = false;
  const checked = validateAttachments({ root: input.root, delivery: "file_only", manifest: input.attachmentManifest }, 2 * 1024 * 1024, [{ root: input.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }]);
  assert.throws(() => validateFileOnlyTriad(checked), { code: "MATERIAL_INCOMPLETE" });
});

test("always_embed requires the same complete hash-bound triad", () => {
  const input = source("", "always_embed"); const roots = [{ root: input.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }]; const worker = { capabilities: { attachment_delivery: ["always_embed"] } };
  const incomplete = { ...input.attachmentManifest, entries: input.attachmentManifest.entries.filter((entry) => entry.destination !== "manifest.json") }; const checkedIncomplete = validateAttachments({ root: input.root, delivery: "always_embed", manifest: incomplete }, 2 * 1024 * 1024, roots); assert.throws(() => planDelivery(worker, checkedIncomplete, "review", 1024 * 1024), { code: "MATERIAL_INCOMPLETE" });
  const forged = JSON.parse(fs.readFileSync(path.join(input.root, "review-packet.v1.json"), "utf8")); forged.packet_hash = "0".repeat(64); fs.writeFileSync(path.join(input.root, "review-packet.v1.json"), `${JSON.stringify(forged)}\n`); const entry = input.attachmentManifest.entries.find((item) => item.destination === "review-packet.v1.json"); const bytes = fs.readFileSync(path.join(input.root, "review-packet.v1.json")); entry.size = bytes.length; entry.sha256 = sha(bytes); const checkedForged = validateAttachments({ root: input.root, delivery: "always_embed", manifest: input.attachmentManifest }, 2 * 1024 * 1024, roots); assert.throws(() => planDelivery(worker, checkedForged, "review", 1024 * 1024), { code: "MATERIAL_INCOMPLETE" });
  const mismatched = source(); const mismatchRoots = [{ root: mismatched.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }]; const checkedMismatch = validateAttachments({ root: mismatched.root, delivery: "always_embed", manifest: mismatched.attachmentManifest }, 2 * 1024 * 1024, mismatchRoots); assert.throws(() => planDelivery(worker, checkedMismatch, "review", 1024 * 1024), { code: "MATERIAL_INCOMPLETE" });
});

test("continuation delta triad binds the initial material hash and ordered predecessor", () => {
  const initial = source(); const roots = [{ root: initial.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }]; const initialChecked = validateAttachments({ root: initial.root, delivery: "file_only", manifest: initial.attachmentManifest }, 2 * 1024 * 1024, roots);
  assert.throws(() => validateContinuationTriad(initialChecked, { attachments: { manifest_hash: initialChecked.manifest_hash }, continuation_materials: [] }), { code: "MATERIAL_INCOMPLETE" });
  const delta = source(); const innerPath = path.join(delta.root, "manifest.json"); const inner = JSON.parse(fs.readFileSync(innerPath, "utf8")); inner.continuation = { initial_material_manifest_hash: initialChecked.manifest_hash, sequence: 1, previous_delivery_manifest_hash: null }; inner.inner_manifest_hash = canonicalInnerManifestHash(inner); fs.writeFileSync(innerPath, `${JSON.stringify(inner)}\n`); const entry = delta.attachmentManifest.entries.find((item) => item.destination === "manifest.json"); const bytes = fs.readFileSync(innerPath); entry.size = bytes.length; entry.sha256 = sha(bytes);
  const checked = validateAttachments({ root: delta.root, delivery: "file_only", manifest: delta.attachmentManifest }, 2 * 1024 * 1024, [{ root: delta.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }]);
  assert.doesNotThrow(() => validateContinuationTriad(checked, { attachments: { manifest_hash: initialChecked.manifest_hash }, continuation_materials: [] }));
  assert.throws(() => validateContinuationTriad(checked, { attachments: { manifest_hash: "0".repeat(64) }, continuation_materials: [] }), { code: "MATERIAL_INCOMPLETE" });
  assert.throws(() => validateContinuationTriad(checked, { attachments: { manifest_hash: initialChecked.manifest_hash }, continuation_materials: [{ delivery_manifest_hash: "f".repeat(64) }] }), { code: "MATERIAL_INCOMPLETE" });
});

test("real Broker R2 setup failure does not consume its delta sequence", async () => {
  const initial = source("", "always_embed"); const delta = continuationDelta("0".repeat(64)); const runtime = temp(); const value = config(runtime, initial.root, "opencode"); value.attachment_roots.push({ root: delta.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }); const broker = new Broker(value); const first = await broker.run({ version: 4, host_provider: "codex", prompt: "initial", continuation: null, attachments: { root: initial.root, delivery: "always_embed", manifest: initial.attachmentManifest } }); assert.equal(first.providers[0].status, "completed");
  const initialChecked = validateAttachments({ root: initial.root, delivery: "file_only", manifest: initial.attachmentManifest }, 2 * 1024 * 1024, [{ root: initial.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }]); const statePath = path.join(runtime, first.runtime_id, "state.json"); const state = JSON.parse(fs.readFileSync(statePath, "utf8")); state.attachments = { requested_delivery: "file_only", bundle_id: initialChecked.bundle_id, manifest_hash: initialChecked.manifest_hash, files: initialChecked.files }; fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const rebound = continuationDelta(initialChecked.manifest_hash); value.attachment_roots.push({ root: rebound.root, sources: ["review-packet.v1.json", "changes.diff", "manifest.json"] }); const result = await broker.run({ version: 4, host_provider: "codex", prompt: "R2_SHORT_INSTRUCTION", continuation: { runtime_id: first.runtime_id }, attachments: { root: rebound.root, delivery: "file_only", manifest: rebound.attachmentManifest } });
  assert.equal(result.providers[0].error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
  const after = JSON.parse(fs.readFileSync(statePath, "utf8")); assert.deepEqual(after.continuation_materials ?? [], []);
});

test("file_only fails closed when triad filename, outer hash, or packet hash binding is wrong", async (t) => {
  for (const mutate of [
    ["filename", (input) => input.attachmentManifest.entries.splice(input.attachmentManifest.entries.findIndex((item) => item.destination === "changes.diff"), 1)],
    ["outer hash", (input) => { input.attachmentManifest.entries.find((item) => item.destination === "changes.diff").sha256 = "0".repeat(64); }],
    ["packet binding", (input) => { const file = path.join(input.root, "review-packet.v1.json"); const packet = JSON.parse(fs.readFileSync(file, "utf8")); packet.manifest_hash = "f".repeat(64); fs.writeFileSync(file, `${JSON.stringify(packet)}\n`); const entry = input.attachmentManifest.entries.find((item) => item.destination === "review-packet.v1.json"); const value = fs.readFileSync(file); entry.size = value.length; entry.sha256 = sha(value); }],
  ]) {
    await t.test(mutate[0], async () => {
      const input = source(); mutate[1](input); const broker = new Broker(config(temp(), input.root, "opencode")); const request = { version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } };
      if (mutate[0] === "outer hash") { await assert.rejects(() => broker.run(request), { code: "ATTACHMENT_HASH_MISMATCH" }); return; }
      const result = await broker.run(request);
      assert.equal(result.providers[0].status, "failed");
      assert.ok(["ATTACHMENT_SANDBOX_UNAVAILABLE", "ATTACHMENT_HASH_MISMATCH"].includes(result.providers[0].error.code));
      assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
    });
  }
});

test("always_embed measures the complete rendered prompt once and fails before a provider session", async () => {
  const input = source("", "always_embed"); const runtime = temp(); const result = await new Broker(config(runtime, input.root, "opencode", 511 * 1024)).run({ version: 4, host_provider: "codex", prompt: "p".repeat(520 * 1024), continuation: null, attachments: { root: input.root, delivery: "always_embed", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "MATERIAL_TOO_LARGE");
  assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
  const state = JSON.parse(fs.readFileSync(path.join(runtime, result.runtime_id, "state.json"), "utf8"));
  assert.equal(state.providers.opencode.session_id, undefined);
  const resumed = await new Broker(config(runtime, input.root, "opencode")).run({ version: 4, host_provider: "codex", prompt: "delta", continuation: { runtime_id: result.runtime_id } });
  assert.equal(resumed.providers[0].error.code, "NO_CONTINUABLE_SESSION");
});

test("continuation cannot gain a session after file_only sandbox setup failure", async () => {
  const input = source(); const runtime = temp(); const broker = new Broker(config(runtime, input.root, "opencode"));
  const first = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(first.providers[0].error.code, "ATTACHMENT_SANDBOX_UNAVAILABLE");
  const resumed = await broker.run({ version: 4, host_provider: "codex", prompt: "delta", continuation: { runtime_id: first.runtime_id } });
  assert.equal(resumed.providers[0].error.code, "NO_CONTINUABLE_SESSION");
});
