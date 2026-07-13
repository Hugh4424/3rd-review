import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { prepareAttachments, validateAttachments } from "../lib/attachments.mjs";
import { validateConfig } from "../lib/config.mjs";

const fake = path.resolve("test/fake-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-attachments-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
function packet(root, delivery = "file_only", embed = true) {
  return { root, delivery, manifest: { version: 1, bundle_id: "bundle-1", entries: [{ source: "skills/review/SKILL.md", destination: "skills/review/SKILL.md", size: 4, sha256: sha("lens"), embed }] } };
}
function source() { const root = temp(); fs.mkdirSync(path.join(root, "skills/review"), { recursive: true }); fs.writeFileSync(path.join(root, "skills/review/SKILL.md"), "lens"); return root; }
function config(root, tiers, attachmentRoot = null) {
  const ids = [...new Set(tiers.flat())];
  return validateConfig({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10000, max_output_bytes: 100000, max_attachment_bytes: 10000, liveness_interval_ms: 5, idle_timeout_ms: 0, max_duration_ms: 1000, orphan_timeout_ms: 100 }, attachment_roots: attachmentRoot ? [{ root: attachmentRoot, sources: ["skills"] }] : [], tiers, providers: Object.fromEntries(ids.map((id) => [id, { enabled: true, command: fake, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] }])) });
}

test("doctor advertises broker and per-provider attachment/continuation capabilities", async () => {
  const result = await new Broker(config(temp(), [["kimi", "opencode"]])).doctor();
  assert.deepEqual(result.capabilities, { attachments: true, cancel_source: true });
  assert.deepEqual(result.providers.find((item) => item.provider === "kimi").capabilities, { continuation: true, attachment_delivery: ["file_only"] });
  assert.deepEqual(result.providers.find((item) => item.provider === "opencode").capabilities, { continuation: true, attachment_delivery: ["always_embed"] });
});

test("attachment validation rejects root, source, traversal, links, hashes and size overflow", () => {
  const root = source(); const runtime = temp(); const allow = [{ root, sources: ["skills"] }]; const input = packet(root);
  const prepared = prepareAttachments(input, runtime, "kimi", 100, allow);
  assert.equal(fs.readFileSync(path.join(prepared.cwd, "skills/review/SKILL.md"), "utf8"), "lens");
  assert.equal(fs.statSync(prepared.cwd).mode & 0o777, 0o500);
  assert.throws(() => prepareAttachments({ ...input, root: temp() }, temp(), "kimi", 100, allow), { code: "ATTACHMENT_ROOT_FORBIDDEN" });
  assert.throws(() => prepareAttachments({ ...input, manifest: { ...input.manifest, entries: [{ ...input.manifest.entries[0], source: "README.md" }] } }, temp(), "kimi", 100, allow), { code: "ATTACHMENT_SOURCE_FORBIDDEN" });
  assert.throws(() => prepareAttachments({ ...input, manifest: { ...input.manifest, entries: [{ ...input.manifest.entries[0], destination: "../escape" }] } }, temp(), "kimi", 100, allow), { code: "ATTACHMENT_INVALID" });
  assert.throws(() => prepareAttachments({ ...input, manifest: { ...input.manifest, entries: [{ ...input.manifest.entries[0], sha256: sha("bad!") }] } }, temp(), "kimi", 100, allow), { code: "ATTACHMENT_HASH_MISMATCH" });
  assert.throws(() => prepareAttachments(input, temp(), "kimi", 3, allow), { code: "ATTACHMENT_TOO_LARGE" });
  fs.symlinkSync("SKILL.md", path.join(root, "skills/review/link"));
  const linked = { ...input, manifest: { ...input.manifest, entries: [{ ...input.manifest.entries[0], source: "skills/review/link" }] } };
  assert.throws(() => prepareAttachments(linked, temp(), "kimi", 100, allow), { code: "ATTACHMENT_INVALID" });
});

test("attachment validation rejects duplicate destinations and hard links", () => {
  const root = source(); const allow = [{ root, sources: ["skills"] }]; const input = packet(root); const duplicate = { ...input, manifest: { ...input.manifest, entries: [input.manifest.entries[0], { ...input.manifest.entries[0], source: "skills/review/SKILL.md" }] } };
  assert.throws(() => prepareAttachments(duplicate, temp(), "kimi", 100, allow), { code: "ATTACHMENT_INVALID" });
  fs.linkSync(path.join(root, "skills/review/SKILL.md"), path.join(root, "skills/review/hard.md")); const hard = { ...input, manifest: { ...input.manifest, entries: [{ ...input.manifest.entries[0], source: "skills/review/hard.md" }] } };
  assert.throws(() => prepareAttachments(hard, temp(), "kimi", 100, allow), { code: "ATTACHMENT_INVALID" });
});

test("always_embed enforces the private embed budget", () => {
  const root = temp(); const contents = "x".repeat(512 * 1024); fs.mkdirSync(path.join(root, "skills")); fs.writeFileSync(path.join(root, "skills", "large.md"), contents); const input = { root, delivery: "always_embed", manifest: { version: 1, bundle_id: "large", entries: [{ source: "skills/large.md", destination: "skills/large.md", size: Buffer.byteLength(contents), sha256: sha(contents), embed: true }] } };
  assert.throws(() => validateAttachments(input, 1024 * 1024, [{ root, sources: ["skills"] }]), { code: "ATTACHMENT_EMBED_TOO_LARGE" });
});

test("one request negotiates Kimi file_only and OpenCode always_embed", async () => {
  const attachmentsRoot = source(); const runtime = temp(); const broker = new Broker(config(runtime, [["kimi", "opencode"]], attachmentsRoot));
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: packet(attachmentsRoot, "file_only", true) });
  assert.ok(result.providers.every((item) => item.status === "completed"));
  assert.equal(fs.existsSync(path.join(runtime, result.runtime_id, "workspace/kimi/skills/review/SKILL.md")), true);
  const openCwd = path.join(runtime, result.runtime_id, "embed/opencode");
  assert.match(fs.readFileSync(path.join(openCwd, "review-input.md"), "utf8"), /<attachments mode="always_embed">/);
  assert.equal(fs.existsSync(path.join(openCwd, "skills")), false);
});

test("provider negotiation fails explicitly when fallback embedding is forbidden", async () => {
  const attachmentsRoot = source(); const broker = new Broker(config(temp(), [["opencode"]], attachmentsRoot));
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: packet(attachmentsRoot, "file_only", false) });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "ATTACHMENT_DELIVERY_UNSUPPORTED");
});

test("continuation verifies frozen attachment identity and Kimi uses only private skills", async () => {
  const attachmentsRoot = source(); const runtime = temp(); const broker = new Broker(config(runtime, [["kimi"]], attachmentsRoot));
  const first = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: packet(attachmentsRoot) });
  await assert.rejects(() => broker.run({ version: 4, host_provider: "codex", prompt: "continue", continuation: { runtime_id: first.runtime_id }, attachments: packet(attachmentsRoot) }), { code: "ATTACHMENT_IMMUTABLE" });
  const frozen = path.join(runtime, first.runtime_id, "workspace/kimi/skills/review/SKILL.md");
  const second = await broker.run({ version: 4, host_provider: "codex", prompt: "continue", continuation: { runtime_id: first.runtime_id } });
  assert.equal(second.providers[0].status, "completed");
  fs.chmodSync(frozen, 0o600); fs.writeFileSync(frozen, "swap");
  const third = await broker.run({ version: 4, host_provider: "codex", prompt: "continue", continuation: { runtime_id: first.runtime_id } });
  assert.equal(third.providers[0].error.code, "ATTACHMENT_IMMUTABLE");
});

test("raw output is private and public status does not leak refs, output, sessions or absolute paths", async () => {
  const runtime = temp(); const broker = new Broker(config(runtime, [["kimi"]])); const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null });
  const privateState = JSON.parse(fs.readFileSync(path.join(runtime, result.runtime_id, "state.json"), "utf8"));
  assert.equal(typeof privateState.providers.kimi.raw_stdout_ref, "string");
  assert.equal(typeof privateState.providers.kimi.raw_stderr_ref, "string");
  assert.equal(fs.statSync(path.join(runtime, result.runtime_id, privateState.providers.kimi.raw_stdout_ref)).mode & 0o777, 0o400);
  assert.doesNotMatch(JSON.stringify(result), /raw_stdout_ref|raw_stderr_ref/);
  const text = JSON.stringify(broker.status(result.runtime_id)); assert.doesNotMatch(text, /session_id|raw_stdout_ref|raw_stderr_ref|kimi opinion/); assert.equal(text.includes(runtime), false);
});

test("cancel source is persisted and projected on CANCELLED error", async () => {
  const runtime = temp(); const value = config(runtime, [["kimi"]]); value.providers.kimi.command = slow; const broker = new Broker(value);
  const running = broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null }); await new Promise((resolve) => setTimeout(resolve, 80));
  const runtimeId = fs.readdirSync(runtime).find((name) => /^[0-9a-f-]{36}$/i.test(name)); assert.deepEqual(broker.cancel(runtimeId, "kimi", "workflowhub"), { cancelled: true, source: "workflowhub" });
  const result = await running; assert.equal(result.providers[0].error.source, "workflowhub"); assert.equal(result.providers[0].cancellation_source, "workflowhub");
});
