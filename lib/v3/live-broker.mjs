import fs from "node:fs";
import path from "node:path";
import { canonicalConfigHash, createRuntimeId, ProtocolError, validateRequest } from "./protocol.mjs";
import { getAdapter } from "./adapters/index.mjs";
import { JobStore } from "./job-store.mjs";
import { cancelPersistedAttempt } from "./supervisor.mjs";
import { RecoveryLedger } from "./recovery.mjs";
import { routeProviders } from "./router.mjs";

function absolute(value, name) {
  if (typeof value !== "string" || !value.startsWith("/")) throw new ProtocolError("CONFIG_INVALID", `${name} must be an absolute path`);
  return value;
}

function providerContext(provider, request, runtimeId, options) {
  const profile = options.profiles?.[provider.id] ?? {};
  return {
    command: absolute(provider.command, `providers.${provider.id}.command`),
    cwd: absolute(profile.cwd ?? options.cwd, "review cwd"),
    model: provider.model,
    effort: provider.effort,
    thinking: provider.thinking,
    auth_env: provider.auth_env,
    env: options.env ?? process.env,
    input: request.material.text,
    profile_path: profile.profile_path ?? provider.profile,
    profile_name: profile.profile_name ?? provider.profile,
    codex_isolation_verified: profile.codex_isolation_verified === true,
    runtime_id: runtimeId,
  };
}

function profileHash(provider, id = provider.id) {
  return canonicalConfigHash({ id, command: provider.command, model: provider.model ?? null, effort: provider.effort ?? null, thinking: provider.thinking ?? null, profile: provider.profile ?? null, backend: provider.backend ?? null, auth_mode: provider.auth_mode ?? null }).hash;
}

function redact(value, secrets) {
  let output = value;
  for (const secret of secrets ?? []) if (secret.length > 0) output = output.split(secret).join("[REDACTED]");
  return output;
}

export class LiveBroker {
  constructor({ supervisor, adapters = { get: getAdapter }, recovery = new RecoveryLedger(), store = null } = {}) {
    if (!supervisor || typeof supervisor.run !== "function") throw new TypeError("supervisor.run is required");
    this.supervisor = supervisor;
    this.adapters = adapters;
    this.recovery = recovery;
    this.store = store;
  }

  async run({ request, config, host_provider = null, host_verified = true, options = {} }) {
    if (!config?.config) throw new ProtocolError("REQUEST_INVALID", "validated config is required");
    const validated = validateRequest(request, { maxInputBytes: config.config.defaults.max_input_bytes ?? 524_288 });
    const store = this.store ??= new JobStore({ runtimeRoot: this.supervisor.runtimeRoot });
    store.gcExpired();
    const started = store.begin({ request: validated, config_hash: config.config_hash, config_snapshot: config.config_snapshot ?? canonicalConfigHash(config.config).canonical_json });
    if (started.existing) return structuredClone(started.job.result);
    const durableRequest = started.request;
    const runtimeId = durableRequest.runtime_id;
    const execute = async (provider) => this.#execute(provider, durableRequest, runtimeId, config, options, store);
    const routed = await routeProviders({ config, host_provider, host_verified, force_tier: validated.force_tier, execute });
    const result = { ...routed, protocol_version: 3, request_id: durableRequest.request_id, nonce: durableRequest.nonce, runtime_id: runtimeId, config_hash: config.config_hash };
    store.complete(runtimeId, result);
    return result;
  }

  async resume({ runtime_id, provider_id, session_id, material_hash, resume_input, nonce = null, config, options = {} }) {
    return this.#continue("resume", { runtime_id, provider_id, session_id, material_hash, resume_input, nonce, config, options });
  }

  async repair({ runtime_id, provider_id, session_id, material_hash, resume_input, nonce = null, config, options = {} }) {
    return this.#continue("repair", { runtime_id, provider_id, session_id, material_hash, resume_input, nonce, config, options });
  }

  readPrivate(input) { return (this.store ??= new JobStore({ runtimeRoot: this.supervisor.runtimeRoot })).readPrivate(input); }

  status(runtime_id) {
    const store = this.store ??= new JobStore({ runtimeRoot: this.supervisor.runtimeRoot });
    const job = store.readJob(runtime_id);
    const active = store.listActive(runtime_id);
    return job.result ?? { protocol_version: 3, request_id: job.request_id, nonce: job.nonce, runtime_id: job.runtime_id, status: job.status, active, providers: Object.values(job.providers).map((entry) => entry.result) };
  }

  cancel({ runtime_id, provider_id, attempt_id, nonce }) {
    const store = this.store ??= new JobStore({ runtimeRoot: this.supervisor.runtimeRoot });
    const job = store.readJob(runtime_id);
    if (job.nonce !== nonce) throw new ProtocolError("BINDING_MISMATCH", "cancel nonce does not match runtime");
    return cancelPersistedAttempt({ active_path: store.activePath(runtime_id, provider_id), attempt_id });
  }

  async #continue(kind, { runtime_id, provider_id, session_id, material_hash, resume_input, nonce, config, options }) {
    if (!config?.config) throw new ProtocolError("REQUEST_INVALID", "validated config is required");
    const provider = config.config.providers[provider_id];
    if (!provider) throw new ProtocolError("REQUEST_INVALID", "provider is not configured");
    const adapter = this.adapters.get(provider_id);
    const store = this.store ??= new JobStore({ runtimeRoot: this.supervisor.runtimeRoot });
    const job = store.readJob(runtime_id);
    if (nonce !== null && job.nonce !== nonce) throw new ProtocolError("BINDING_MISMATCH", "continuation nonce does not match runtime");
    const context = providerContext(provider, { material: { text: "" } }, runtime_id, options);
    this.recovery.restore({ runtime_id, provider: provider_id, runtime_path: path.join(this.supervisor.runtimeRoot, runtime_id) });
    const operation = kind === "repair" ? "repairOnce" : "resumeOnce";
    const result = await this.recovery[operation]({ runtime_id, provider: provider_id, session_id, material_hash, config_hash: config.config_hash, profile_hash: profileHash(provider, provider_id), resume_input, ...(kind === "repair" ? { error_code: "INVALID_JSON" } : {}) }, async (continuation) => {
      let plan;
      try { plan = adapter.buildResume({ ...context, session_id: continuation.session_id, resume_input: continuation.resume_input }); } catch (error) {
        return { execution_eligible: false, session_id: null, error_code: error instanceof ProtocolError ? error.code : "ADAPTER_FAILED", persisted: true };
      }
      return this.#runPlan(adapter, plan, provider_id, runtime_id, config, 0);
    });
    const request = { request_id: job.request_id, nonce: job.nonce, round: job.round, material: { input_hash: material_hash }, contract_ref: job.contract_ref };
    return store.commitProvider({ runtime_id, provider: provider_id, request, config_hash: config.config_hash, config_snapshot: config.config_snapshot ?? canonicalConfigHash(config.config).canonical_json, profile_hash: profileHash(provider, provider_id), result });
  }

  async #execute(provider, request, runtimeId, config, options, store) {
    const adapter = this.adapters.get(provider.id);
    const context = providerContext(provider, request, runtimeId, options);
    let plan;
    try { plan = adapter.buildStart(context); } catch (error) {
      return { execution_eligible: false, session_id: null, error_code: error instanceof ProtocolError ? error.code : "ADAPTER_FAILED", persisted: true };
    }
    const result = await this.#runPlan(adapter, plan, provider.id, runtimeId, config, request.material.bytes);
    if (result.execution_eligible && result.session_id) {
      try {
        this.recovery.record({
          runtime_id: runtimeId, provider: provider.id, session_id: result.session_id,
          config_hash: config.config_hash, profile_hash: profileHash(provider), material_hash: request.material.input_hash,
          runtime_path: path.join(this.supervisor.runtimeRoot, runtimeId),
        });
      } catch (error) {
        return { ...result, execution_eligible: false, session_id: null, error_code: error instanceof ProtocolError ? error.code : "RUNTIME_UNAVAILABLE", persisted: false };
      }
    }
    try {
      return store.commitProvider({ runtime_id: runtimeId, provider: provider.id, request, config_hash: config.config_hash, config_snapshot: config.config_snapshot ?? canonicalConfigHash(config.config).canonical_json, profile_hash: profileHash(provider), result });
    } catch (error) {
      return { execution_eligible: false, session_id: null, error_code: error instanceof ProtocolError ? error.code : "RUNTIME_UNAVAILABLE", persisted: false };
    }
  }

  async #runPlan(adapter, plan, providerId, runtimeId, config, inputBytes) {
    const attempt = await this.supervisor.run({
      ...plan, attempt_id: createRuntimeId(), runtime_id: runtimeId, provider: providerId,
      active_path: path.join(this.supervisor.runtimeRoot, runtimeId, providerId, ".3rd-review-active.json"),
      deadline_seconds: config.config.defaults.deadline_seconds ?? null,
      max_output_bytes: config.config.defaults.max_output_bytes ?? 10 * 1024 * 1024,
    });
    if (attempt.status !== "completed" || attempt.persisted !== true || !attempt.stdout_path) {
      return {
        execution_eligible: false, session_id: null, error_code: attempt.error_code ?? "PROCESS_DIED", persisted: attempt.persisted === true,
        raw_ref: attempt.stdout_path ?? null, diagnostic_ref: attempt.stderr_path ?? null,
        metrics: { elapsed_ms: attempt.finished_at_ms - attempt.started_at_ms, input_bytes: inputBytes, output_bytes: attempt.output_bytes ?? 0 },
      };
    }
    let parsed;
    try {
      const stdout = redact(fs.readFileSync(attempt.stdout_path, "utf8"), plan.redact_values);
      const stderr = attempt.stderr_path ? redact(fs.readFileSync(attempt.stderr_path, "utf8"), plan.redact_values) : "";
      fs.writeFileSync(attempt.stdout_path, stdout, { mode: 0o600 });
      if (attempt.stderr_path) fs.writeFileSync(attempt.stderr_path, stderr, { mode: 0o600 });
      parsed = adapter.parse(`${stdout}\n${stderr}`);
    } catch (error) {
      return { execution_eligible: false, session_id: null, error_code: error instanceof ProtocolError ? error.code : "PROVIDER_PROTOCOL_INCOMPLETE", persisted: true };
    }
    const result = {
      execution_eligible: parsed.error_code === null && typeof parsed.text === "string",
      session_id: parsed.session_id,
      error_code: parsed.error_code,
      persisted: true,
      raw_ref: attempt.stdout_path,
      diagnostic_ref: attempt.stderr_path,
      metrics: { elapsed_ms: attempt.finished_at_ms - attempt.started_at_ms, input_bytes: inputBytes, output_bytes: attempt.output_bytes },
    };
    return result;
  }
}
