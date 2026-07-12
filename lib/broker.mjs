import fs from "node:fs";
import path from "node:path";
import { adapter } from "./adapters/index.mjs";
import { execute } from "./process.mjs";
import { cancellationRequested, createRuntime, cleanup, isAlive, readRuntime, requestCancellation, runtimeDirectory, terminateProcess, updateRunningProvider, updateRuntime } from "./runtime.mjs";
import { fail, publicError } from "./errors.mjs";

const providers = new Set(["claude-code", "kimi", "codex", "opencode"]);
function request(value) { if (!value || value.version !== 4 || typeof value.prompt !== "string" || value.prompt.length === 0 || !providers.has(value.host_provider)) fail("REQUEST_INVALID", "request needs version:4, a non-empty prompt, and a supported host_provider"); if (value.continuation !== null && value.continuation !== undefined && (typeof value.continuation !== "object" || typeof value.continuation.runtime_id !== "string")) fail("REQUEST_INVALID", "continuation must be null or contain runtime_id"); return value; }
function short(text, max = 500) { return text.length <= max ? text : `${text.slice(0, max)}…`; }

export class Broker {
  constructor(config) { this.config = config; cleanup(config.runtime.root, config.runtime.ttl_hours); }

  async doctor() {
    const output = await Promise.all(Object.values(this.config.providers).map(async (provider) => {
      if (!provider.enabled) return { provider: provider.id, status: "disabled" };
      const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
      if (missing.length) return { provider: provider.id, status: "unavailable", error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } };
      const work = fs.mkdtempSync(path.join(this.config.runtime.root, "doctor-"));
      try { const result = await execute(adapter(provider.id).doctor(provider, work), { maxOutputBytes: 65536 }); return result.ok ? { provider: provider.id, status: "ready", verification: "executable_only" } : { provider: provider.id, status: "unavailable", error: result.error }; }
      finally { fs.rmSync(work, { recursive: true, force: true }); }
    }));
    return { version: 4, verification: "executable_only", note: "doctor does not verify model authentication or a real review", providers: output };
  }

  status(runtime_id) { cleanup(this.config.runtime.root, this.config.runtime.ttl_hours); return readRuntime(this.config.runtime.root, runtime_id); }

  cancel(runtime_id, provider) {
    const state = readRuntime(this.config.runtime.root, runtime_id); const item = state.providers?.[provider];
    if (!item || item.status !== "running" || !isAlive(item.pid)) return { cancelled: false, reason: "NOT_ACTIVE" };
    // Keep cancellation separate from heartbeat state, so another broker
    // process cannot erase this intent with a read-modify-write race.
    requestCancellation(this.config.runtime.root, runtime_id, provider);
    const cancelled = terminateProcess(item.pid, "SIGTERM");
    if (cancelled) setTimeout(() => { terminateProcess(item.pid, "SIGKILL"); }, 5_000).unref();
    return { cancelled };
  }

  async run(raw) {
    const input = request(raw); const promptBytes = Buffer.byteLength(input.prompt, "utf8"); if (promptBytes > this.config.runtime.max_prompt_bytes) fail("PROMPT_TOO_LARGE", `prompt exceeds ${this.config.runtime.max_prompt_bytes} bytes`);
    const continuing = input.continuation?.runtime_id;
    const state = continuing ? readRuntime(this.config.runtime.root, continuing) : createRuntime(this.config.runtime.root, this.config.runtime.ttl_hours, input.host_provider);
    if (continuing && state.expires_at_ms <= Date.now()) fail("RUNTIME_EXPIRED", "runtime has expired and cannot be continued");
    if (state.host_provider !== input.host_provider) fail("HOST_MISMATCH", "continuation host_provider must match its first round");
    const selected = continuing ? Object.keys(state.providers).filter((id) => id !== input.host_provider && state.providers[id].status === "completed" && typeof state.providers[id].session_id === "string" && state.providers[id].session_id.length > 0) : null;
    const entries = continuing ? selected.map((id) => ({ id, tier: null, continuation: true })) : this.#route(input.host_provider);
    const output = []; if (continuing && entries.length === 0) return this.#finish(state.runtime_id, input, [{ provider: null, status: "failed", error: { code: "NO_CONTINUABLE_SESSION", message: "no successful provider session is available" } }], null);
    if (continuing) output.push(...await Promise.all(entries.map((entry) => this.#runProvider(state.runtime_id, input.prompt, entry))));
    else {
      for (const tier of entries) {
        const results = await Promise.all(tier.map((entry) => this.#runProvider(state.runtime_id, input.prompt, entry))); output.push(...results);
        if (results.some((result) => result.status === "completed")) return this.#finish(state.runtime_id, input, output, tier[0]?.tier ?? null);
      }
    }
    return this.#finish(state.runtime_id, input, output, null);
  }

  #route(host) { return this.config.tiers.map((tier, index) => tier.map((id) => id === host ? { id, tier: index, skip: "SAME_SOURCE" } : { id, tier: index })); }
  async #runProvider(runtime_id, prompt, entry) {
    if (entry.skip) return { provider: entry.id, tier: entry.tier, status: "skipped", error: { code: entry.skip, message: "host provider cannot review itself" } };
    const provider = this.config.providers[entry.id];
    if (!provider) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED", message: "provider is absent from the current config" } };
    if (!provider.enabled) return { provider: entry.id, tier: entry.tier, status: "skipped", error: { code: "PROVIDER_DISABLED", message: "disabled in config" } };
    const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
    if (missing.length) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } };
    const state = readRuntime(this.config.runtime.root, runtime_id); const prior = state.providers[entry.id]; if (prior?.status === "running" && isAlive(prior.pid)) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_BUSY", message: "provider has an active process" } };
    const runtime = runtimeDirectory(this.config.runtime.root, runtime_id); const cwd = path.join(runtime, "workspace"); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const worker = adapter(entry.id); let plan;
    try { plan = entry.continuation ? worker.resume(provider, cwd, prior.session_id, prompt, runtime) : worker.start(provider, cwd, prompt, runtime); }
    catch (error) { return { provider: entry.id, tier: entry.tier, status: "failed", error: publicError(error) }; }
    const touch = (patch) => updateRunningProvider(this.config.runtime.root, runtime_id, entry.id, patch);
    const result = await execute(plan, {
      maxOutputBytes: this.config.runtime.max_output_bytes,
      idleTimeoutMs: this.config.runtime.idle_timeout_ms,
      maxDurationMs: this.config.runtime.max_duration_ms,
      livenessIntervalMs: this.config.runtime.liveness_interval_ms,
      onStart: (pid) => { const current = Date.now(); updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, providers: { ...next.providers, [entry.id]: { provider: entry.id, tier: entry.tier, status: "running", pid, started_at_ms: current, heartbeat_at_ms: current, last_activity_at_ms: current, session_id: prior?.session_id ?? null } } })); },
      onLiveness: () => touch({ heartbeat_at_ms: Date.now() }),
      onActivity: () => { const current = Date.now(); touch({ heartbeat_at_ms: current, last_activity_at_ms: current }); },
    });
    const cancelled = cancellationRequested(this.config.runtime.root, runtime_id, entry.id);
    if (cancelled) return this.#store(runtime_id, entry, { status: "cancelled", duration_ms: result.duration_ms, error: { code: "CANCELLED", message: "cancel was requested by the caller" } });
    if (!result.ok) return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, error: result.error, diagnostic: short(`${result.stdout}\n${result.stderr}`) });
    const parsed = worker.parse(result.stdout, result.stderr);
    if (!parsed.ok) return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, error: parsed.error, diagnostic: short(`${result.stdout}\n${result.stderr}`) });
    return this.#store(runtime_id, entry, { status: "completed", duration_ms: result.duration_ms, session_id: parsed.session_id, usage: parsed.usage, output: parsed.text });
  }
  #store(runtime_id, entry, result) { updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, providers: { ...next.providers, [entry.id]: { ...next.providers[entry.id], provider: entry.id, tier: entry.tier, ...result, completed_at_ms: Date.now() } } })); return { provider: entry.id, tier: entry.tier, ...result }; }
  #finish(runtime_id, input, providers, selected_tier) { const state = updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, round: next.round + 1, last_prompt_bytes: Buffer.byteLength(input.prompt, "utf8"), last_selected_tier: selected_tier, last_completed_at_ms: Date.now() })); return { version: 4, runtime_id, round: state.round, host_provider: state.host_provider, selected_tier, providers }; }
}
