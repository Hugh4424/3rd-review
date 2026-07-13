import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { validateConfig } from "../lib/config.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-delivery-plan-v2-"));
const capture = path.resolve("test/capture-cli.mjs");

function source() {
  const root = temp();
  const diff = `DIFF_HEAD\n${"x".repeat(24 * 1024)}\nDIFF_MIDDLE\n${"y".repeat(24 * 1024)}\nDIFF_TAIL\n`;
  const packet = { version: "review-packet.v1", packet_hash: "1".repeat(64), manifest_hash: "2".repeat(64), diff_sha256: sha(diff) };
  const files = [["review-packet.v1.json", `${JSON.stringify(packet)}\n`], ["changes.diff", diff]];
  for (const [name, value] of files) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  }
  const attachments = files.map(([destination, value]) => ({ destination, sha256: sha(value), size: Buffer.byteLength(value) }));
  const manifest = { packet_hash: packet.packet_hash, manifest_hash: packet.manifest_hash, diff_sha256: packet.diff_sha256, attachments };
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

test("file_only plans before rendering and gives OpenCode only its isolated triad", async () => {
  const input = source(); const runtime = temp();
  const result = await new Broker(config(runtime, input.root, "opencode")).run({ version: 4, host_provider: "codex", prompt: "SHORT_REVIEW_INSTRUCTION", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "completed");
  assert.equal(result.providers[0].delivery_used, "file_only");
  const observed = JSON.parse(result.providers[0].output);
  assert.equal(observed.input, "SHORT_REVIEW_INSTRUCTION");
  assert.doesNotMatch(observed.input, /DIFF_(HEAD|MIDDLE|TAIL)|<attachments|review-packet\.v1\.json/);
  assert.equal(observed.has_triage_files, true);
  assert.equal(observed.diff_head, true); assert.equal(observed.diff_middle, true); assert.equal(observed.diff_tail, true);
  assert.deepEqual({ packet_hash: observed.packet_hash, manifest_hash: observed.manifest_hash, diff_sha256: observed.diff_sha256 }, { packet_hash: input.packet.packet_hash, manifest_hash: input.packet.manifest_hash, diff_sha256: input.packet.diff_sha256 });
  assert.equal(observed.cwd.includes(input.root), false);
  const state = JSON.parse(fs.readFileSync(path.join(runtime, result.runtime_id, "state.json"), "utf8"));
  assert.deepEqual(state.providers.opencode.delivery, { delivery_mode: "file_only", material_manifest_hash: sha(JSON.stringify({ version: 1, bundle_id: "v2", files: input.attachmentManifest.entries.map(({ destination, sha256, size, embed }) => ({ target: destination, sha256, size, embed })) })), total_bytes: input.attachmentManifest.entries.reduce((sum, item) => sum + item.size, 0), provider_visible_attachment_manifest: input.attachmentManifest.entries.map(({ destination, sha256, size }) => ({ destination, sha256, size })) });
});

test("file_only rejects a triad whose inner manifest omits a delivered file", async () => {
  const input = source(); const invalid = JSON.parse(fs.readFileSync(path.join(input.root, "manifest.json"), "utf8"));
  invalid.attachments.pop(); fs.writeFileSync(path.join(input.root, "manifest.json"), `${JSON.stringify(invalid)}\n`);
  const manifestEntry = input.attachmentManifest.entries.find((item) => item.destination === "manifest.json"); const bytes = fs.readFileSync(path.join(input.root, "manifest.json")); manifestEntry.size = bytes.length; manifestEntry.sha256 = sha(bytes);
  const runtime = temp(); const result = await new Broker(config(runtime, input.root, "kimi")).run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "MATERIAL_INCOMPLETE");
  assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
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
      assert.ok(["MATERIAL_INCOMPLETE", "ATTACHMENT_HASH_MISMATCH"].includes(result.providers[0].error.code));
      assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
    });
  }
});

test("always_embed measures the complete rendered prompt once and fails before a provider session", async () => {
  const input = source(); const runtime = temp(); const result = await new Broker(config(runtime, input.root, "opencode", 1024 * 1024)).run({ version: 4, host_provider: "codex", prompt: "p".repeat(500 * 1024), continuation: null, attachments: { root: input.root, delivery: "always_embed", manifest: input.attachmentManifest } });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "MATERIAL_TOO_LARGE");
  assert.equal(Object.hasOwn(result.providers[0], "session_id"), false);
  const state = JSON.parse(fs.readFileSync(path.join(runtime, result.runtime_id, "state.json"), "utf8"));
  assert.equal(state.providers.opencode.session_id, undefined);
  const resumed = await new Broker(config(runtime, input.root, "opencode")).run({ version: 4, host_provider: "codex", prompt: "delta", continuation: { runtime_id: result.runtime_id } });
  assert.equal(resumed.providers[0].error.code, "NO_CONTINUABLE_SESSION");
});

test("continuation refuses a file_only provider whose recorded material hash changed", async () => {
  const input = source(); const runtime = temp(); const broker = new Broker(config(runtime, input.root, "opencode"));
  const first = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: input.root, delivery: "file_only", manifest: input.attachmentManifest } });
  const statePath = path.join(runtime, first.runtime_id, "state.json"); const state = JSON.parse(fs.readFileSync(statePath, "utf8")); state.providers.opencode.delivery.material_manifest_hash = "0".repeat(64); fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const resumed = await broker.run({ version: 4, host_provider: "codex", prompt: "delta", continuation: { runtime_id: first.runtime_id } });
  assert.equal(resumed.providers[0].status, "failed");
  assert.equal(resumed.providers[0].error.code, "MATERIAL_INCOMPLETE");
});
