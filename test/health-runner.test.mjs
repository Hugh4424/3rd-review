import assert from "node:assert/strict";
import test from "node:test";
import { createHealthRunner } from "../lib/health-runner.mjs";

class FakeClock {
  nowMs = 0; nextId = 1; timers = new Map();
  now = () => this.nowMs;
  setTimeout = (fn, delay) => { const id = this.nextId++; this.timers.set(id, { at: this.nowMs + delay, fn }); return id; };
  clearTimeout = (id) => { this.timers.delete(id); };
  async tick(ms) { const target = this.nowMs + ms; while (true) { const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; this.timers.delete(next[0]); this.nowMs = next[1].at; next[1].fn(); await Promise.resolve(); await Promise.resolve(); } this.nowMs = target; await Promise.resolve(); await Promise.resolve(); }
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup(options = {}) { const clock = new FakeClock(); const decisions = []; const runner = createHealthRunner({ clock, onDecision: (value) => decisions.push(value), ...options }); runner.start(); return { clock, decisions, runner }; }

test("health probes start at the default 60 second interval and never overlap", async () => {
  const pending = deferred(); let calls = 0; const { clock, runner } = setup({ probeSession: () => { calls += 1; return pending.promise; }, probeDeadlineMs: 120_000 });
  await clock.tick(59_999); assert.equal(calls, 0); await clock.tick(1); assert.equal(calls, 1); await clock.tick(60_000); assert.equal(calls, 1);
  pending.resolve({ status: "busy", session_id: "s", cursor: "c", raw: null, error: null, evidence: "running" }); await clock.tick(0); runner.stop();
});

test("completed health harvest requires parseable raw", async () => {
  const valid = setup({ intervalMs: 10, probeSession: async () => ({ status: "completed", session_id: "s", cursor: "done", raw: { stdout: "FINAL", stderr: "" }, error: null, evidence: "terminal" }), validateCompleted: (raw) => raw.stdout === "FINAL" });
  await valid.clock.tick(10); assert.equal(valid.decisions[0].status, "completed"); assert.deepEqual(valid.decisions[0].raw, { stdout: "FINAL", stderr: "" });
  const invalid = setup({ intervalMs: 10, probeSession: async () => ({ status: "completed", session_id: "s", cursor: null, raw: { stdout: "PARTIAL", stderr: "" }, error: null, evidence: "terminal" }), validateCompleted: () => false });
  await invalid.clock.tick(10); assert.equal(invalid.decisions[0].error.code, "HEALTH_INVALID");
});

test("abort-aware probe deadlines settle before a later probe may start", async () => {
  let active = 0; let maxActive = 0; let calls = 0; const probeSession = ({ signal }) => new Promise((resolve, reject) => { assert.ok(signal instanceof AbortSignal); active += 1; maxActive = Math.max(maxActive, active); calls += 1; signal.addEventListener("abort", () => { active -= 1; reject(new Error("aborted")); }, { once: true }); });
  const { clock, decisions } = setup({ intervalMs: 10, probeDeadlineMs: 3, probeSession });
  await clock.tick(10); assert.equal(active, 1); await clock.tick(3); assert.equal(active, 0); assert.equal(calls, 1); assert.deepEqual(decisions, []);
  await clock.tick(10); assert.equal(active, 1); await clock.tick(3); assert.equal(active, 0); assert.equal(decisions[0].error.code, "HEALTH_UNVERIFIABLE"); assert.equal(maxActive, 1);
});

test("a probe that ignores abort is PROBE_ABORT_FAILED after grace without a second probe", async () => {
  let calls = 0; const { clock, decisions, runner } = setup({ intervalMs: 10, probeDeadlineMs: 3, probeAbortGraceMs: 2, probeSession: () => { calls += 1; return new Promise(() => {}); } });
  await clock.tick(13); assert.deepEqual(decisions, []); await clock.tick(2); assert.equal(decisions[0].error.code, "PROBE_ABORT_FAILED"); assert.equal(runner.snapshot().unverifiable, 0); await clock.tick(100); assert.equal(calls, 1);
});

test("runner stop aborts an active probe and leaves no closure timer", async () => {
  let active = 0; const { clock, decisions, runner } = setup({ intervalMs: 10, probeDeadlineMs: 100, probeSession: ({ signal }) => new Promise((resolve, reject) => { active += 1; signal.addEventListener("abort", () => { active -= 1; reject(new Error("stopped")); }, { once: true }); }) });
  await clock.tick(10); assert.equal(active, 1); runner.stop(); await clock.tick(0); assert.equal(active, 0); assert.equal(clock.timers.size, 0); assert.deepEqual(decisions, []);
});

test("runner cancellation aborts an active probe before publishing CANCELLED", async () => {
  let active = 0; const { clock, decisions, runner } = setup({ intervalMs: 10, probeDeadlineMs: 100, probeSession: ({ signal }) => new Promise((resolve, reject) => { active += 1; signal.addEventListener("abort", () => { active -= 1; reject(new Error("cancelled")); }, { once: true }); }) });
  await clock.tick(10); assert.equal(active, 1); runner.cancel(); await clock.tick(0); assert.equal(active, 0); assert.equal(decisions[0].error.code, "CANCELLED"); assert.equal(clock.timers.size, 0);
});

test("new structured progress wins a stale dead probe and updates cursor", async () => {
  const pending = deferred(); const { clock, decisions, runner } = setup({ intervalMs: 10, probeDeadlineMs: 100, probeSession: () => pending.promise });
  await clock.tick(10); runner.noteProgress({ cursor: "stream-2" }); pending.resolve({ status: "dead", session_id: "s", cursor: "old", raw: null, error: { code: "PROCESS_DEAD" }, evidence: "stale" }); await clock.tick(0);
  assert.deepEqual(decisions, []); assert.equal(runner.snapshot().cursor, "stream-2"); runner.stop();
});

test("cancellation wins before probe, after probe, and immediately before publish", async () => {
  for (const cancelAt of [1, 2, 3]) { let checks = 0; let calls = 0; const { clock, decisions } = setup({ intervalMs: 10, isCancelled: () => ++checks >= cancelAt, probeSession: async () => { calls += 1; return { status: "dead", session_id: "s", cursor: null, raw: null, error: null, evidence: "dead" }; } }); await clock.tick(10); assert.equal(decisions[0].error.code, "CANCELLED"); if (cancelAt === 1) assert.equal(calls, 0); }
});

test("adapters without a probe fail closed after two stream-fallback rounds", async () => {
  const { clock, decisions, runner } = setup({ intervalMs: 10 }); await clock.tick(10); assert.deepEqual(decisions, []); runner.noteProgress({ cursor: "event-1" }); await clock.tick(10); assert.deepEqual(decisions, []); await clock.tick(10); assert.deepEqual(decisions, []); await clock.tick(10); assert.equal(decisions[0].error.code, "HEALTH_UNVERIFIABLE");
});
