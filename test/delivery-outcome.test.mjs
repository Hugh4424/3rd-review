import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Broker } from "../lib/broker.mjs";
import { validateConfig } from "../lib/config.mjs";

const fake = path.resolve("test/fake-cli.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-delivery-outcome-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");

function source() {
  const root = temp();
  fs.mkdirSync(path.join(root, "skills/review"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills/review/SKILL.md"), "lens");
  return root;
}

function attachments(root, delivery, embed = true) {
  return {
    root,
    delivery,
    manifest: {
      version: 1,
      bundle_id: "delivery-outcome",
      entries: [{
        source: "skills/review/SKILL.md",
        destination: "skills/review/SKILL.md",
        size: 4,
        sha256: sha("lens"),
        embed,
      }],
    },
  };
}

function config(root, tiers, attachmentRoot) {
  const ids = [...new Set(tiers.flat())];
  return validateConfig({
    version: 4,
    runtime: {
      root,
      ttl_hours: 24,
      max_prompt_bytes: 10_000,
      max_output_bytes: 100_000,
      max_attachment_bytes: 10_000,
      liveness_interval_ms: 5,
      idle_timeout_ms: 0,
      max_duration_ms: 1_000,
      orphan_timeout_ms: 100,
    },
    attachment_roots: [{ root: attachmentRoot, sources: ["skills"] }],
    tiers,
    providers: Object.fromEntries(ids.map((id) => [id, {
      enabled: true,
      command: fake,
      model: null,
      effort: null,
      thinking: null,
      auth: { type: "native" },
      env: [],
    }])),
  });
}

for (const [policy, provider, expected] of [
  ["file_only", "kimi", "file_only"],
  ["always_embed", "kimi", "file_only"],
  ["always_embed", "opencode", "always_embed"],
]) {
  test(`${policy} policy reports ${provider} delivery_used=${expected}`, async () => {
    const attachmentRoot = source();
    const runtimeRoot = temp();
    const result = await new Broker(config(runtimeRoot, [[provider]], attachmentRoot)).run({
      version: 4,
      host_provider: "codex",
      prompt: "review",
      continuation: null,
      attachments: attachments(attachmentRoot, policy),
    });

    assert.equal(result.providers[0].status, "completed");
    assert.equal(result.providers[0].delivery_used, expected);
    const privateState = JSON.parse(fs.readFileSync(path.join(runtimeRoot, result.runtime_id, "state.json"), "utf8"));
    assert.equal(privateState.providers[provider].delivery_used, expected);
  });
}

test("file_only never falls back to an always_embed provider", async () => {
  const attachmentRoot = source();
  const runtimeRoot = temp();
  const result = await new Broker(config(runtimeRoot, [["opencode"]], attachmentRoot)).run({
    version: 4,
    host_provider: "codex",
    prompt: "review",
    continuation: null,
    provider_allowlist: ["opencode"],
    attachments: attachments(attachmentRoot, "file_only"),
  });

  assert.deepEqual(result.providers.map((item) => item.provider), ["opencode"]);
  assert.equal(result.providers[0].status, "failed");
  assert.equal(result.providers[0].error.code, "ATTACHMENT_DELIVERY_UNSUPPORTED");
  assert.equal(Object.hasOwn(result.providers[0], "delivery_used"), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, result.runtime_id, "embed", "opencode")), false);
  const state = JSON.parse(fs.readFileSync(path.join(runtimeRoot, result.runtime_id, "state.json"), "utf8"));
  assert.equal(state.providers.opencode, undefined);
});

test("a provider with no compatible attachment capability fails explicitly and is not silently skipped", async () => {
  const attachmentRoot = source();
  const broker = new Broker(config(temp(), [["kimi", "opencode"]], attachmentRoot));
  const result = await broker.run({
    version: 4,
    host_provider: "codex",
    prompt: "review",
    continuation: null,
    attachments: attachments(attachmentRoot, "file_only", false),
  });

  assert.deepEqual(result.providers.map((item) => item.provider).sort(), ["kimi", "opencode"]);
  assert.equal(result.providers.find((item) => item.provider === "kimi").status, "completed");
  const unsupported = result.providers.find((item) => item.provider === "opencode");
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.error.code, "ATTACHMENT_DELIVERY_UNSUPPORTED");
});

test("continuation reuses only the file_only provider session", async () => {
  const attachmentRoot = source();
  const broker = new Broker(config(temp(), [["kimi", "opencode"]], attachmentRoot));
  const first = await broker.run({
    version: 4,
    host_provider: "codex",
    prompt: "first",
    continuation: null,
    attachments: attachments(attachmentRoot, "file_only"),
  });
  const second = await broker.run({
    version: 4,
    host_provider: "codex",
    prompt: "continue",
    continuation: { runtime_id: first.runtime_id },
  });

  assert.equal(first.providers.find((item) => item.provider === "kimi").delivery_used, "file_only");
  assert.equal(first.providers.find((item) => item.provider === "opencode").error.code, "ATTACHMENT_DELIVERY_UNSUPPORTED");
  assert.equal(Object.hasOwn(first.providers.find((item) => item.provider === "opencode"), "delivery_used"), false);
  assert.deepEqual(second.providers.map((item) => item.provider), ["kimi"]);
  for (const item of second.providers) {
    assert.equal(item.status, "completed");
    assert.equal(item.delivery_used, first.providers.find((prior) => prior.provider === item.provider).delivery_used);
  }
});

test("run may expose delivery outcome while status keeps attachment internals private", async () => {
  const attachmentRoot = source();
  const runtimeRoot = temp();
  const broker = new Broker(config(runtimeRoot, [["kimi"]], attachmentRoot));
  const result = await broker.run({
    version: 4,
    host_provider: "codex",
    prompt: "review",
    continuation: null,
    attachments: attachments(attachmentRoot, "file_only"),
  });

  assert.equal(result.providers[0].delivery_used, "file_only");
  assert.equal(typeof result.providers[0].session_id, "string");
  assert.equal(typeof result.providers[0].output, "string");
  assert.match(result.providers[0].raw_stdout_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.providers[0].raw_stderr_sha256, /^[a-f0-9]{64}$/);
  const privateState = JSON.parse(fs.readFileSync(path.join(runtimeRoot, result.runtime_id, "state.json"), "utf8"));
  assert.equal(privateState.providers.kimi.raw_stdout_sha256, result.providers[0].raw_stdout_sha256);
  assert.equal(privateState.providers.kimi.raw_stderr_sha256, result.providers[0].raw_stderr_sha256);
  const status = JSON.stringify(broker.status(result.runtime_id));
  assert.doesNotMatch(status, /attachments|attachment_delivery|bundle_id|manifest_hash|workspace|raw_stdout_ref|raw_stderr_ref|raw_stdout_sha256|raw_stderr_sha256|session_id|kimi opinion/);
  assert.equal(status.includes(attachmentRoot), false);
  assert.equal(status.includes(runtimeRoot), false);
});

test("doctor keeps broker and provider delivery capabilities", async () => {
  const attachmentRoot = source();
  const result = await new Broker(config(temp(), [["kimi", "opencode"]], attachmentRoot)).doctor();
  assert.deepEqual(result.capabilities, { attachments: true, cancel_source: true });
  assert.deepEqual(result.providers.find((item) => item.provider === "kimi").capabilities, { continuation: true, attachment_delivery: ["file_only"] });
  assert.deepEqual(result.providers.find((item) => item.provider === "opencode").capabilities, { continuation: true, attachment_delivery: ["always_embed"] });
});
