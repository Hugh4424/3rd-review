import fs from "node:fs";
import path from "node:path";
import { adapter } from "./adapters/index.mjs";
import { execute } from "./process.mjs";
import { cancellationRequested, cancellationSource, claimProvider, createRuntime, cleanup, isAlive, readRuntime, releaseProviderClaim, requestCancellation, runtimeDirectory, terminateProcessTree, updateRunningProvider, updateRuntime } from "./runtime.mjs";
import { fail, publicError } from "./errors.mjs";
import { appendEmbedded, prepareAttachments, validateAttachments, verifyFrozenAttachments } from "./attachments.mjs";

const providers = new Set(["claude-code", "kimi", "codex", "opencode"]);
function request(value) { if (!value || value.version !== 4 || typeof value.prompt !== "string" || value.prompt.length === 0 || !providers.has(value.host_provider)) fail("REQUEST_INVALID", "request needs version:4, a non-empty prompt, and a supported host_provider"); if (value.continuation !== null && value.continuation !== undefined && (typeof value.continuation !== "object" || typeof value.continuation.runtime_id !== "string")) fail("REQUEST_INVALID", "continuation must be null or contain runtime_id"); return value; }
function short(text, max = 500) { return text.length <= max ? text : `${text.slice(0, max)}…`; }
function projectStatus(state) {
  const providerStates = Object.fromEntries(Object.entries(state.providers ?? {}).map(([id, item]) => [id, {
    provider: item.provider, tier: item.tier, status: item.status, started_at_ms: item.started_at_ms, completed_at_ms: item.completed_at_ms,
    process_alive_at_ms: item.process_alive_at_ms, last_progress_at_ms: item.last_progress_at_ms, duration_ms: item.duration_ms,
    retry_count: item.retry_count, progress_events: item.progress_events,
    ...(item.error ? { error: { code: item.error.code, ...(item.error.source ? { source: item.error.source } : {}) } } : {}),
  }]));
  return { version: state.version, runtime_id: state.runtime_id, host_provider: state.host_provider, created_at_ms: state.created_at_ms, expires_at_ms: state.expires_at_ms, round: state.round, last_selected_tier: state.last_selected_tier ?? null, last_completed_at_ms: state.last_completed_at_ms, providers: providerStates };
}
function negotiateDelivery(worker, requested, embeddedText) {
  const supported = worker.capabilities?.attachment_delivery ?? [];
  if (supported.includes(requested)) return requested;
  if (supported.includes("always_embed") && embeddedText !== null) return "always_embed";
  if (supported.includes("file_only")) return "file_only";
  fail("ATTACHMENT_DELIVERY_UNSUPPORTED", `provider cannot accept requested attachment delivery ${requested}`);
}

export class Broker {
  constructor(config) { this.config = config; this.active = new Map(); this.shuttingDown = false; cleanup(config.runtime.root, config.runtime.ttl_hours); }

  async doctor() {
    const output = await Promise.all(Object.values(this.config.providers).map(async (provider) => {
      const capabilities = adapter(provider.id).capabilities;
      if (!provider.enabled) return { provider: provider.id, status: "disabled", capabilities };
      const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
      if (missing.length) return { provider: provider.id, status: "unavailable", capabilities, error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } };
      const work = fs.mkdtempSync(path.join(this.config.runtime.root, "doctor-"));
      try { const result = await execute(adapter(provider.id).doctor(provider, work), { maxOutputBytes: 65536 }); return result.ok ? { provider: provider.id, status: "ready", verification: "executable_only", capabilities } : { provider: provider.id, status: "unavailable", capabilities, error: result.error }; }
      finally { fs.rmSync(work, { recursive: true, force: true }); }
    }));
    return { version: 4, capabilities: { attachments: true, cancel_source: true }, verification: "executable_only", note: "doctor does not verify model authentication or a real review", providers: output };
  }

  status(runtime_id) { cleanup(this.config.runtime.root, this.config.runtime.ttl_hours); return projectStatus(readRuntime(this.config.runtime.root, runtime_id)); }

  shutdown() {
    this.shuttingDown = true;
    const cancelled = [];
    for (const { runtime_id, provider, pid } of this.active.values()) {
      requestCancellation(this.config.runtime.root, runtime_id, provider, "broker_shutdown");
      if (terminateProcessTree(pid, "SIGTERM")) cancelled.push({ runtime_id, provider });
    }
    return cancelled;
  }

  cancel(runtime_id, provider, source = "caller") {
    const exposeSource = arguments.length >= 3;
    const state = readRuntime(this.config.runtime.root, runtime_id); const item = state.providers?.[provider];
    if (!item || item.status !== "running" || !isAlive(item.pid)) return { cancelled: false, reason: "NOT_ACTIVE" };
    // Keep cancellation separate from heartbeat state, so another broker
    // process cannot erase this intent with a read-modify-write race.
    requestCancellation(this.config.runtime.root, runtime_id, provider, source);
    const cancelled = terminateProcessTree(item.pid, "SIGTERM");
    if (cancelled) setTimeout(() => { terminateProcessTree(item.pid, "SIGKILL"); }, 5_000).unref();
    return { cancelled, ...(exposeSource ? { source } : {}) };
  }

  async run(raw) {
    const input = request(raw); const promptBytes = Buffer.byteLength(input.prompt, "utf8"); if (promptBytes > this.config.runtime.max_prompt_bytes) fail("PROMPT_TOO_LARGE", `prompt exceeds ${this.config.runtime.max_prompt_bytes} bytes`);
    const continuing = input.continuation?.runtime_id;
    let state = continuing ? readRuntime(this.config.runtime.root, continuing) : createRuntime(this.config.runtime.root, this.config.runtime.ttl_hours, input.host_provider, this.config.runtime.orphan_timeout_ms);
    if (continuing && state.expires_at_ms <= Date.now()) fail("RUNTIME_EXPIRED", "runtime has expired and cannot be continued");
    if (state.host_provider !== input.host_provider) fail("HOST_MISMATCH", "continuation host_provider must match its first round");
    if (continuing) {
      if (input.attachments) fail("ATTACHMENT_IMMUTABLE", "continuation must not retransmit attachments");
    } else if (input.attachments) {
      const checked = validateAttachments(input.attachments, this.config.runtime.max_attachment_bytes, this.config.attachment_roots);
      state = updateRuntime(this.config.runtime.root, state.runtime_id, (next) => ({ ...next, attachments: { requested_delivery: checked.requested_delivery, bundle_id: checked.bundle_id, manifest_hash: checked.manifest_hash, files: checked.files } }));
    }
    const selected = continuing ? Object.keys(state.providers).filter((id) => id !== input.host_provider && ["completed", "running"].includes(state.providers[id].status) && typeof state.providers[id].session_id === "string" && state.providers[id].session_id.length > 0) : null;
    const entries = continuing ? selected.map((id) => ({ id, tier: null, continuation: true })) : this.#route(input.host_provider);
    const output = []; if (continuing && entries.length === 0) return this.#finish(state.runtime_id, input, [{ provider: null, status: "failed", error: { code: "NO_CONTINUABLE_SESSION", message: "no successful provider session is available" } }], null);
    if (continuing) output.push(...await Promise.all(entries.map((entry) => this.#runProvider(state.runtime_id, input, entry))));
    else {
      for (const tier of entries) {
        const results = await Promise.all(tier.map((entry) => this.#runProvider(state.runtime_id, input, entry))); output.push(...results);
        if (results.some((result) => result.status === "completed")) return this.#finish(state.runtime_id, input, output, tier[0]?.tier ?? null);
      }
    }
    return this.#finish(state.runtime_id, input, output, null);
  }

  #route(host) { return this.config.tiers.map((tier, index) => tier.map((id) => id === host ? { id, tier: index, skip: "SAME_SOURCE" } : { id, tier: index })); }
  async #runProvider(runtime_id, input, entry) {
    if (this.shuttingDown) return { provider: entry.id, tier: entry.tier, status: "cancelled", cancellation_source: "broker_shutdown", error: { code: "CANCELLED", message: "broker is shutting down", source: "broker_shutdown" } };
    if (entry.skip) return { provider: entry.id, tier: entry.tier, status: "skipped", error: { code: entry.skip, message: "host provider cannot review itself" } };
    const provider = this.config.providers[entry.id];
    if (!provider) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED", message: "provider is absent from the current config" } };
    if (!provider.enabled) return { provider: entry.id, tier: entry.tier, status: "skipped", error: { code: "PROVIDER_DISABLED", message: "disabled in config" } };
    const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
    if (missing.length) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } };
    const claim = claimProvider(this.config.runtime.root, runtime_id, entry.id, this.config.runtime.orphan_timeout_ms);
    if (!claim) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_BUSY", message: "provider is claimed by another broker" } };
    try { return await this.#runClaimedProvider(runtime_id, input, entry, provider); }
    finally { releaseProviderClaim(claim); }
  }
  async #runClaimedProvider(runtime_id, input, entry, provider) {
    const prompt = input.prompt;
    const state = readRuntime(this.config.runtime.root, runtime_id); const prior = state.providers[entry.id]; if (prior?.status === "running" && isAlive(prior.pid)) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_BUSY", message: "provider has an active process" } };
    const runtime = runtimeDirectory(this.config.runtime.root, runtime_id); const worker = adapter(entry.id); let cwd; let providerPrompt = prompt; let attachmentDelivery = prior?.attachment_delivery ?? null;
    try {
      if (input.attachments) {
        const prepared = prepareAttachments(input.attachments, runtime, entry.id, this.config.runtime.max_attachment_bytes, this.config.attachment_roots);
        attachmentDelivery = negotiateDelivery(worker, input.attachments.delivery, prepared.embedded_text);
        if (attachmentDelivery === "always_embed") { if (prepared.embedded_text === null) fail("ATTACHMENT_DELIVERY_UNSUPPORTED", "provider requires embedding but the manifest forbids it"); cwd = path.join(runtime, "embed", entry.id); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); providerPrompt = appendEmbedded(prompt, prepared.embedded_text, this.config.runtime.max_prompt_bytes); }
        else cwd = prepared.cwd;
      } else if (entry.continuation && state.attachments) {
        const frozen = verifyFrozenAttachments(runtime, entry.id, state.attachments); attachmentDelivery = prior?.attachment_delivery;
        if (!worker.capabilities?.attachment_delivery?.includes(attachmentDelivery)) fail("ATTACHMENT_DELIVERY_UNSUPPORTED", "provider attachment capability changed since the first round");
        if (attachmentDelivery === "always_embed") { if (frozen.embedded_text === null) fail("ATTACHMENT_IMMUTABLE", "frozen attachments are not embeddable"); cwd = path.join(runtime, "embed", entry.id); if (!fs.existsSync(cwd)) fail("ATTACHMENT_IMMUTABLE", "embedded provider workspace is unavailable"); providerPrompt = appendEmbedded(prompt, frozen.embedded_text, this.config.runtime.max_prompt_bytes); }
        else cwd = frozen.cwd;
      } else { cwd = path.join(runtime, "workspace", entry.id); fs.mkdirSync(path.join(cwd, "skills"), { recursive: true, mode: 0o700 }); }
      if (worker.requiresWritableCwd && state.attachments) { cwd = path.join(runtime, "work", entry.id); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); }
    } catch (error) { return { provider: entry.id, tier: entry.tier, status: "failed", error: publicError(error) }; }
    let plan;
    try { fs.writeFileSync(path.join(cwd, "review-input.md"), providerPrompt, { mode: 0o600 }); plan = entry.continuation ? worker.resume(provider, cwd, prior.session_id, providerPrompt, runtime) : worker.start(provider, cwd, providerPrompt, runtime); }
    catch (error) { return { provider: entry.id, tier: entry.tier, status: "failed", error: publicError(error) }; }
    const touch = (patch) => updateRunningProvider(this.config.runtime.root, runtime_id, entry.id, patch);
    const result = await execute(plan, {
      maxOutputBytes: this.config.runtime.max_output_bytes,
      idleTimeoutMs: this.config.runtime.idle_timeout_ms,
      maxDurationMs: this.config.runtime.max_duration_ms,
      livenessIntervalMs: this.config.runtime.liveness_interval_ms,
      onStart: (pid) => { const current = Date.now(); this.active.set(`${runtime_id}:${entry.id}`, { runtime_id, provider: entry.id, pid }); updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, owner: { pid: process.pid, started_at_ms: current }, providers: { ...next.providers, [entry.id]: { provider: entry.id, tier: entry.tier, status: "running", pid, started_at_ms: current, process_alive_at_ms: current, last_progress_at_ms: null, session_id: prior?.session_id ?? null, attachment_delivery: attachmentDelivery } } })); if (this.shuttingDown) { requestCancellation(this.config.runtime.root, runtime_id, entry.id, "broker_shutdown"); terminateProcessTree(pid, "SIGTERM"); } },
      onLiveness: () => touch({ process_alive_at_ms: Date.now() }),
      onProgress: ({ at_ms }) => touch({ last_progress_at_ms: at_ms }),
    });
    this.active.delete(`${runtime_id}:${entry.id}`);
    const rawRefs = this.#storeRaw(runtime, entry.id, result.stdout, result.stderr);
    const cancelled = cancellationRequested(this.config.runtime.root, runtime_id, entry.id);
    const telemetry = { retry_count: result.retry_count, api_empty_response_count: result.retry_count, progress_events: result.progress_events, last_progress_at_ms: result.last_progress_at_ms };
    if (cancelled) { const source = cancellationSource(this.config.runtime.root, runtime_id, entry.id); return this.#store(runtime_id, entry, { status: "cancelled", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, cancellation_source: source, error: { code: "CANCELLED", message: `cancel was requested by ${source}`, source } }); }
    if (!result.ok) return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, error: result.error, diagnostic: short(`${result.stdout}\n${result.stderr}`) });
    const parsed = worker.parse(result.stdout, result.stderr);
    if (!parsed.ok) return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, error: parsed.error, diagnostic: short(`${result.stdout}\n${result.stderr}`) });
    return this.#store(runtime_id, entry, { status: "completed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, session_id: parsed.session_id, usage: parsed.usage, output: parsed.text });
  }
  #storeRaw(runtime, provider, stdout, stderr) {
    const directory = path.join(runtime, "raw", provider); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const suffix = `${Date.now()}-${process.pid}-${process.hrtime.bigint()}`; const refs = {};
    for (const [stream, value] of [["stdout", stdout], ["stderr", stderr]]) { const target = path.join(directory, `round-${suffix}.${stream}`); fs.writeFileSync(target, value, { mode: 0o400, flag: "wx" }); refs[`raw_${stream}_ref`] = path.relative(runtime, target); }
    return refs;
  }
  #store(runtime_id, entry, result) { updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, providers: { ...next.providers, [entry.id]: { ...next.providers[entry.id], provider: entry.id, tier: entry.tier, ...result, completed_at_ms: Date.now() } } })); const { raw_stdout_ref, raw_stderr_ref, ...publicResult } = result; return { provider: entry.id, tier: entry.tier, ...publicResult }; }
  #finish(runtime_id, input, providers, selected_tier) { const state = updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, round: next.round + 1, last_prompt_bytes: Buffer.byteLength(input.prompt, "utf8"), last_selected_tier: selected_tier, last_completed_at_ms: Date.now() })); return { version: 4, runtime_id, round: state.round, host_provider: state.host_provider, selected_tier, providers }; }
}
