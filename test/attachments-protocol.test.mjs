import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { prepareAttachments, probeAttachmentWorkspace, validateAttachments } from "../lib/attachments.mjs";
import { validateConfig } from "../lib/config.mjs";
import { cancellationRequested, cancellationSource, createRuntime, requestCancellation } from "../lib/runtime.mjs";

const fake = path.resolve("test/fake-cli.mjs");
const slow = path.resolve("test/slow-cli.mjs");
const stdinOpenCode = path.resolve("test/stdin-opencode-cli.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-attachments-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
function packet(root, delivery = "file_only", embed = true) {
  return { root, delivery, manifest: { version: 1, bundle_id: "bundle-1", entries: [{ source: "skills/review/SKILL.md", destination: "skills/review/SKILL.md", size: 4, sha256: sha("lens"), embed }] } };
}
function source() { const root = temp(); fs.mkdirSync(path.join(root, "skills/review"), { recursive: true }); fs.writeFileSync(path.join(root, "skills/review/SKILL.md"), "lens"); return root; }
function config(root, tiers, attachmentRoot = null) {
  const ids = [...new Set(tiers.flat())];
  return validateConfig({ version: 4, runtime: { root, ttl_hours: 24, max_prompt_bytes: 10000, max_output_bytes: 100000, max_attachment_bytes: 10000, liveness_interval_ms: 5, idle_timeout_ms: 0, max_duration_ms: 1000, orphan_timeout_ms: 100 }, attachment_roots: attachmentRoot ? [{ root: attachmentRoot, sources: ["skills", "contracts", "review-packet.v1.json"] }] : [], tiers, providers: Object.fromEntries(ids.map((id) => [id, { enabled: true, command: fake, model: null, effort: null, thinking: null, auth: { type: "native" }, env: [] }])) });
}

test("doctor requires configured attachment roots and verifies the requested root", async () => {
  const unconfigured = await new Broker(config(temp(), [["kimi", "opencode"]])).doctor();
  assert.deepEqual(unconfigured.capabilities, { attachments: false, cancel_source: true });
  assert.deepEqual(unconfigured.attachment_root, { status: "unavailable", error: { code: "ATTACHMENT_ROOT_UNCONFIGURED" } });
  const root = source(); const broker = new Broker(config(temp(), [["kimi", "opencode"]], root));
  const result = await broker.doctor({ attachmentRoot: root });
  assert.deepEqual(result.capabilities, { attachments: true, cancel_source: true });
  assert.deepEqual(result.attachment_root, { status: "ready" });
  assert.equal(result.verification, "workspace_copy_only");
  const forbidden = await broker.doctor({ attachmentRoot: temp() });
  assert.deepEqual(forbidden.capabilities, { attachments: false, cancel_source: true });
  assert.equal(forbidden.attachment_root.status, "unavailable");
  assert.equal(forbidden.attachment_root.error.code, "ATTACHMENT_ROOT_FORBIDDEN");
  assert.deepEqual(result.providers.find((item) => item.provider === "kimi").capabilities, { continuation: true, attachment_delivery: ["file_only"] });
  assert.deepEqual(result.providers.find((item) => item.provider === "opencode").capabilities, { continuation: true, attachment_delivery: ["always_embed"] });
});

test("doctor attachment probe copies and locks a private bundle without touching the packet root", () => {
  const runtime = temp(); const packetRoot = source(); const before = fs.readdirSync(packetRoot);
  for (const provider of ["kimi", "opencode"]) probeAttachmentWorkspace(runtime, provider, 1);
  assert.deepEqual(fs.readdirSync(packetRoot), before);
  assert.equal(fs.readdirSync(runtime).some((name) => name.startsWith("attachment-probe-")), false);
  const file = path.join(runtime, "not-a-directory"); fs.writeFileSync(file, "x");
  assert.throws(() => probeAttachmentWorkspace(file, "kimi", 1), { code: "ATTACHMENT_PROBE_FAILED" });
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

test("file_only sends Kimi a private bundle and rejects OpenCode", async () => {
  const attachmentsRoot = source(); const runtime = temp(); const broker = new Broker(config(runtime, [["kimi", "opencode"]], attachmentsRoot));
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: packet(attachmentsRoot, "file_only", true) });
  assert.equal(result.providers.find((item) => item.provider === "kimi").status, "completed");
  const openCode = result.providers.find((item) => item.provider === "opencode"); assert.equal(openCode.status, "failed"); assert.equal(openCode.error.code, "ATTACHMENT_DELIVERY_UNSUPPORTED"); assert.equal(Object.hasOwn(openCode, "delivery_used"), false);
  assert.equal(fs.existsSync(path.join(runtime, result.runtime_id, "workspace/kimi/skills/review/SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(runtime, result.runtime_id, "embed/opencode")), false);
});

test("first-round provider_allowlist is a strict route intersection", async () => {
  const attachmentsRoot = source(); const runtime = temp(); const broker = new Broker(config(runtime, [["kimi", "opencode"]], attachmentsRoot));
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, provider_allowlist: ["kimi"], attachments: packet(attachmentsRoot, "file_only", true) });
  assert.deepEqual(result.providers.map((item) => item.provider), ["kimi"]);
  assert.equal(result.providers[0].delivery_used, "file_only");
});

test("continuation intersects its frozen allowlist with completed sessions only", async () => {
  const runtime = temp(); const broker = new Broker(config(runtime, [["kimi", "opencode"]]));
  const first = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, provider_allowlist: ["kimi", "opencode"] });
  const statePath = path.join(runtime, first.runtime_id, "state.json"); const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.providers.opencode.status = "running"; fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const resumed = await broker.run({ version: 4, host_provider: "codex", prompt: "delta", continuation: { runtime_id: first.runtime_id }, provider_allowlist: ["kimi", "opencode"] });
  assert.deepEqual(resumed.providers.map((item) => item.provider), ["kimi"]);
  assert.equal(resumed.providers[0].session_id, first.providers.find((item) => item.provider === "kimi").session_id);
});

test("Kimi gets a writable private root with a complete read-only bundle view", async () => {
  const attachmentsRoot = temp(); const files = [["review-packet.v1.json", "PACKET"], ["contracts/review.md", "CONTRACT"], ["skills/review/SKILL.md", "SKILL"]]; for (const [name, contents] of files) { fs.mkdirSync(path.dirname(path.join(attachmentsRoot, name)), { recursive: true }); fs.writeFileSync(path.join(attachmentsRoot, name), contents); } const manifest = { version: 1, bundle_id: "complete", entries: files.map(([name, contents]) => ({ source: name, destination: name, size: Buffer.byteLength(contents), sha256: sha(contents), embed: false })) }; const runtime = temp(); const broker = new Broker(config(runtime, [["kimi"]], attachmentsRoot));
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: { root: attachmentsRoot, delivery: "file_only", manifest } }); assert.equal(result.providers[0].status, "completed"); const root = path.join(runtime, result.runtime_id, "work", "kimi"); const frozen = path.join(runtime, result.runtime_id, "workspace", "kimi"); assert.equal(fs.statSync(root).mode & 0o200, 0o200); for (const [name, contents] of files) { assert.equal(fs.readFileSync(path.join(root, "bundle", name), "utf8"), contents); assert.equal(fs.readFileSync(path.join(frozen, name), "utf8"), contents); assert.equal(fs.statSync(path.join(frozen, name)).mode & 0o222, 0); }
});

test("OpenCode sends the full 80KB packet once then resumes with only the delta prompt", async () => {
  const attachmentsRoot = temp(); const contents = `ATTACHMENT_HEAD\n${"x".repeat(80 * 1024)}\nATTACHMENT_TAIL`; fs.mkdirSync(path.join(attachmentsRoot, "skills")); fs.writeFileSync(path.join(attachmentsRoot, "skills", "packet.md"), contents); const runtime = temp(); const value = config(runtime, [["opencode"]], attachmentsRoot); value.runtime.max_prompt_bytes = 100_000; value.runtime.max_attachment_bytes = 100_000; value.providers.opencode.command = stdinOpenCode; const broker = new Broker(value); const input = { root: attachmentsRoot, delivery: "always_embed", manifest: { version: 1, bundle_id: "large-packet", entries: [{ source: "skills/packet.md", destination: "review-packet.v1.json", size: Buffer.byteLength(contents), sha256: sha(contents), embed: true }] } };
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "PROMPT_HEAD review the complete packet", continuation: null, attachments: input }); assert.equal(result.providers[0].status, "completed"); const observed = JSON.parse(result.providers[0].output); assert.ok(observed.bytes > 80_000); assert.match(observed.head, /^PROMPT_HEAD/); assert.match(observed.tail, /ATTACHMENT_TAIL[\s\S]*<\/attachments>$/); assert.equal(fs.existsSync(path.join(runtime, result.runtime_id, "embed", "opencode", "review-input.md")), false);
  const resumed = await broker.run({ version: 4, host_provider: "codex", prompt: "DELTA_ONLY_MARKER inspect the fixed line", continuation: { runtime_id: result.runtime_id } });
  assert.equal(resumed.providers[0].status, "completed"); assert.equal(resumed.providers[0].session_id, result.providers[0].session_id);
  const delta = JSON.parse(resumed.providers[0].output); assert.equal(delta.bytes, Buffer.byteLength("DELTA_ONLY_MARKER inspect the fixed line")); assert.match(delta.head, /^DELTA_ONLY_MARKER/); assert.doesNotMatch(delta.tail, /ATTACHMENT_(HEAD|TAIL)/);
});

test("OpenCode stdin delivery still obeys max_prompt_bytes", async () => {
  const attachmentsRoot = source(); const runtime = temp(); const value = config(runtime, [["opencode"]], attachmentsRoot); value.runtime.max_prompt_bytes = 20; const broker = new Broker(value);
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: packet(attachmentsRoot, "always_embed", true) }); assert.equal(result.providers[0].error.code, "PROMPT_TOO_LARGE"); assert.equal(result.providers[0].delivery_used, "always_embed");
  const privateState = JSON.parse(fs.readFileSync(path.join(runtime, result.runtime_id, "state.json"), "utf8")); assert.equal(privateState.providers.opencode.delivery_used, "always_embed");
});

test("an always_embed continuation uses the small delta prompt and preserves its session", async () => {
  const attachmentsRoot = source(); const runtime = temp();
  const first = await new Broker(config(runtime, [["opencode"]], attachmentsRoot)).run({ version: 4, host_provider: "codex", prompt: "first", continuation: null, attachments: packet(attachmentsRoot, "always_embed", true) });
  const constrained = config(runtime, [["opencode"]], attachmentsRoot); constrained.runtime.max_prompt_bytes = 20;
  const second = await new Broker(constrained).run({ version: 4, host_provider: "codex", prompt: "continue", continuation: { runtime_id: first.runtime_id } });
  const afterSecond = JSON.parse(fs.readFileSync(path.join(runtime, first.runtime_id, "state.json"), "utf8")).providers.opencode;
  const third = await new Broker(config(runtime, [["opencode"]], attachmentsRoot)).run({ version: 4, host_provider: "codex", prompt: "recover", continuation: { runtime_id: first.runtime_id } });

  assert.deepEqual({
    second: { status: second.providers[0].status, error: second.providers[0].error?.code, delivery_used: second.providers[0].delivery_used },
    private_after_second: { status: afterSecond.status, session_id: afterSecond.session_id, delivery_used: afterSecond.delivery_used },
    third: { provider: third.providers[0].provider, status: third.providers[0].status, error: third.providers[0].error?.code, delivery_used: third.providers[0].delivery_used },
  }, {
    second: { status: "completed", error: undefined, delivery_used: "always_embed" },
    private_after_second: { status: "completed", session_id: first.providers[0].session_id, delivery_used: "always_embed" },
    third: { provider: "opencode", status: "completed", error: undefined, delivery_used: "always_embed" },
  });
});

test("provider negotiation fails explicitly when fallback embedding is forbidden", async () => {
  const attachmentsRoot = source(); const runtime = temp(); const broker = new Broker(config(runtime, [["opencode"]], attachmentsRoot));
  const result = await broker.run({ version: 4, host_provider: "codex", prompt: "review", continuation: null, attachments: packet(attachmentsRoot, "file_only", false) });
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "ATTACHMENT_DELIVERY_UNSUPPORTED");
  assert.equal(Object.hasOwn(result.providers[0], "delivery_used"), false);
  const privateState = JSON.parse(fs.readFileSync(path.join(runtime, result.runtime_id, "state.json"), "utf8")); assert.equal(privateState.providers.opencode, undefined);
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
  const runtimeId = fs.readdirSync(runtime).find((name) => /^[0-9a-f-]{36}$/i.test(name)); assert.deepEqual(broker.cancel(runtimeId, "kimi", "workflow_shutdown"), { cancelled: true, source: "workflow_shutdown" });
  const result = await running; assert.equal(result.providers[0].error.source, "workflow_shutdown"); assert.equal(result.providers[0].cancellation_source, "workflow_shutdown");
});

test("cancellation provenance is limited to the documented enum", () => {
  const runtime = temp(); const state = createRuntime(runtime, 24, "codex");
  assert.throws(() => requestCancellation(runtime, state.runtime_id, "kimi", "workflowhub"), { code: "REQUEST_INVALID" });
  for (const source of ["user", "workflow_shutdown", "broker_idle_timeout", "broker_max_duration"]) {
    assert.doesNotThrow(() => requestCancellation(runtime, state.runtime_id, "kimi", source));
  }
});

test("a tampered cancellation marker remains explicit instead of defaulting to user", () => {
  const runtime = temp(); const state = createRuntime(runtime, 24, "codex");
  fs.writeFileSync(path.join(runtime, state.runtime_id, ".cancel-kimi"), JSON.stringify({ version: 1, source: "forged" }));
  assert.equal(cancellationRequested(runtime, state.runtime_id, "kimi"), true);
  assert.equal(cancellationSource(runtime, state.runtime_id, "kimi"), "invalid");
});
