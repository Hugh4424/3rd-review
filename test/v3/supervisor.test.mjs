import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cancelPersistedAttempt, CliSupervisor } from "../../lib/v3/supervisor.mjs";

function fixture(source) {
  return { command: process.execPath, argv: ["-e", source] };
}

test("runs a direct CLI in a private runtime and records output activity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  try {
    const supervisor = new CliSupervisor({ runtimeRoot: root, pollIntervalMs: 10 });
    const result = await supervisor.run({
      attempt_id: "attempt_one",
      runtime_id: "runtime_one",
      provider: "mock",
      ...fixture('process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 20);'),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.error_code, null);
    assert.equal(result.activity_count >= 2, true);
    assert.equal(readFileSync(result.stdout_path, "utf8"), "first\nsecond\n");
    assert.match(result.stdout_path, /runtime_one\/mock\/attempt_one\.stdout$/);
    const receipt = JSON.parse(readFileSync(result.receipt_path, "utf8"));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.stdout_file, "attempt_one.stdout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records a non-zero direct CLI exit as a failed attempt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  try {
    const result = await new CliSupervisor({ runtimeRoot: root }).run({
      attempt_id: "attempt_nonzero", runtime_id: "runtime_nonzero", provider: "mock",
      ...fixture("process.exit(7);"),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "PROCESS_EXIT_NONZERO");
    assert.equal(result.exit_code, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports an initial private-storage failure without throwing or claiming persistence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  const blockedRoot = path.join(root, "not-a-directory");
  try {
    writeFileSync(blockedRoot, "blocked");
    const result = await new CliSupervisor({ runtimeRoot: blockedRoot }).run({
      attempt_id: "attempt_storage", runtime_id: "runtime_storage", provider: "mock",
      ...fixture('process.stdout.write("never starts");'),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "RUNTIME_UNAVAILABLE");
    assert.equal(result.persisted, false);
    assert.equal(result.receipt_path, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("has no default deadline and only terminates on an explicit deadline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  try {
    const supervisor = new CliSupervisor({ runtimeRoot: root, pollIntervalMs: 10, cancelGraceMs: 10 });
    const completed = await supervisor.run({
      attempt_id: "attempt_no_deadline", runtime_id: "runtime_deadline", provider: "mock",
      ...fixture('setTimeout(() => process.stdout.write("done"), 35);'),
    });
    assert.equal(completed.status, "completed");
    const expired = await supervisor.run({
      attempt_id: "attempt_deadline", runtime_id: "runtime_deadline", provider: "mock",
      deadline_seconds: 0.02,
      ...fixture('setInterval(() => process.stdout.write("tick\\n"), 5_000);'),
    });
    assert.equal(expired.status, "deadline_exceeded");
    assert.equal(expired.error_code, "DEADLINE_EXCEEDED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel is observable, idempotent, and does not create a fresh attempt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  try {
    const supervisor = new CliSupervisor({ runtimeRoot: root, pollIntervalMs: 10, cancelGraceMs: 10 });
    const pending = supervisor.run({
      attempt_id: "attempt_cancel", runtime_id: "runtime_cancel", provider: "mock",
      ...fixture('setInterval(() => process.stdout.write("tick\\n"), 5_000);'),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(supervisor.status("attempt_cancel").status, "running");
    assert.equal(supervisor.cancel("attempt_cancel"), true);
    assert.equal(supervisor.cancel("attempt_cancel"), true);
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.error_code, "CANCELLED");
    assert.equal(supervisor.status("attempt_cancel").status, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second CLI process can inspect and cancel a fingerprint-bound active attempt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  try {
    const active = path.join(root, "runtime_persisted", "mock", ".3rd-review-active.json");
    const supervisor = new CliSupervisor({ runtimeRoot: root, pollIntervalMs: 10, cancelGraceMs: 10 });
    const pending = supervisor.run({
      attempt_id: "attempt_persisted", runtime_id: "runtime_persisted", provider: "mock", active_path: active,
      ...fixture('setInterval(() => {}, 5_000);'),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const state = JSON.parse(readFileSync(active, "utf8"));
    assert.equal(state.attempt_id, "attempt_persisted");
    assert.equal(state.terminal, false);
    assert.equal(cancelPersistedAttempt({ active_path: active, attempt_id: "attempt_persisted" }), true);
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(JSON.parse(readFileSync(active, "utf8")).terminal, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output limit fails loud and leaves a private diagnostic instead of claiming completion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  try {
    const supervisor = new CliSupervisor({ runtimeRoot: root, pollIntervalMs: 10, cancelGraceMs: 10 });
    const result = await supervisor.run({
      attempt_id: "attempt_limit", runtime_id: "runtime_limit", provider: "mock", max_output_bytes: 8,
      ...fixture('process.stdout.write("0123456789abcdef"); setInterval(() => {}, 5_000);'),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "OUTPUT_LIMIT");
    assert.equal(result.persisted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permits exactly the configured output budget and supports explicit terminal pruning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "3rd-review-supervisor-"));
  try {
    const supervisor = new CliSupervisor({ runtimeRoot: root });
    const result = await supervisor.run({
      attempt_id: "attempt_exact_limit", runtime_id: "runtime_exact_limit", provider: "mock", max_output_bytes: 8,
      ...fixture('process.stdout.write("12345678");'),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output_bytes, 8);
    assert.equal(supervisor.pruneTerminalBefore(result.finished_at_ms + 1), 1);
    assert.equal(supervisor.status("attempt_exact_limit"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
