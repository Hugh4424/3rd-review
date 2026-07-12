import {
  PROTOCOL_VERSION,
  ProtocolError,
  RUNTIME_TTL_MS,
  assertPrivateRef,
  canonicalConfigHash,
  createNonce,
  createRuntimeId,
  receiptHash,
  validateProviderId,
  validateRequest,
  validateRuntimeId,
} from "./protocol.mjs";

function normalizeMetrics(value, material) {
  const source = value && typeof value === "object" ? value : {};
  const integer = (name, fallback = 0) => Number.isSafeInteger(source[name]) && source[name] >= 0 ? source[name] : fallback;
  return {
    elapsed_ms: integer("elapsed_ms"),
    turns: integer("turns"),
    input_bytes: integer("input_bytes", material.bytes),
    output_bytes: integer("output_bytes"),
    retry_count: integer("retry_count"),
  };
}

function clone(value) {
  return structuredClone(value);
}

export function createMockAdapter({ id = "mock", profile = {}, execute } = {}) {
  validateProviderId(id);
  if (typeof execute !== "function") throw new TypeError("mock adapter execute must be a function");
  const normalizedProfile = profile && typeof profile === "object" && !Array.isArray(profile) ? structuredClone(profile) : null;
  if (!normalizedProfile) throw new TypeError("mock adapter profile must be an object");
  return { id, profile: normalizedProfile, execute };
}

export class MockBroker {
  #jobs = new Map();
  #private = new Map();

  constructor({ now = () => Date.now(), maxInputBytes = 524_288 } = {}) {
    this.now = now;
    this.maxInputBytes = maxInputBytes;
  }

  async run(input, { config, adapter }) {
    if (!adapter || typeof adapter.execute !== "function") throw new TypeError("adapter.execute is required");
    validateProviderId(adapter.id);
    const validated = validateRequest(input, { maxInputBytes: this.maxInputBytes });
    const existing = this.#jobs.get(validated.request_id);
    if (existing) return this.#replay(existing, input);

    const nonce = validated.nonce ?? createNonce();
    const request = { ...validated, nonce };
    const configSnapshot = canonicalConfigHash(config);
    const providerProfile = canonicalConfigHash(adapter.profile ?? {});
    const runtimeId = createRuntimeId();
    const startedAt = this.now();
    const execution = await this.#execute(adapter, request, runtimeId, configSnapshot.hash);
    const { raw, diagnostic, ...provider } = execution;
    const receipt = {
      protocol_version: PROTOCOL_VERSION,
      request_id: request.request_id,
      nonce,
      owner_uid: typeof process.getuid === "function" ? process.getuid() : null,
      runtime_id: runtimeId,
      provider: adapter.id,
      round: request.round,
      config_hash: configSnapshot.hash,
      config_snapshot: configSnapshot.canonical_json,
      provider_profile_hash: providerProfile.hash,
      provider_profile: providerProfile.canonical_json,
      material_hash: request.material.input_hash,
      contract_ref: request.contract_ref,
      session_id: provider.session_id,
      status: provider.status,
      persisted: provider.persisted,
      created_at_ms: startedAt,
      expires_at_ms: startedAt + RUNTIME_TTL_MS,
    };
    const receiptDigest = receiptHash(receipt).hash;
    const receiptRef = `private://${runtimeId}/${adapter.id}/receipt`;
    provider.receipt_ref = receiptRef;
    provider.runtime_id = runtimeId;
    const result = {
      protocol_version: PROTOCOL_VERSION,
      request_id: request.request_id,
      nonce,
      config_hash: configSnapshot.hash,
      selected_tier: 0,
      stop_reason: provider.execution_eligible ? "execution_eligible" : "all_failed",
      providers: [provider],
    };
    const job = {
      nonce,
      result,
      terminal: true,
      expiresAt: receipt.expires_at_ms,
      runtimeId,
      provider: adapter.id,
      configHash: configSnapshot.hash,
      providerProfileHash: providerProfile.hash,
    };
    this.#jobs.set(request.request_id, job);
    this.#private.set(`${runtimeId}:${adapter.id}`, {
      nonce,
      expiresAt: receipt.expires_at_ms,
      raw,
      diagnostic,
      receipt: { ...receipt, receipt_hash: receiptDigest },
    });
    return clone(result);
  }

  #replay(existing, input) {
    if (input?.nonce === null || input?.nonce === undefined) {
      throw new ProtocolError("NONCE_REQUIRED", "existing request_id requires its original nonce");
    }
    if (input.nonce !== existing.nonce) throw new ProtocolError("REPLAY_DETECTED", "request_id is already bound to a different nonce");
    if (existing.terminal && this.now() > existing.expiresAt) throw new ProtocolError("NONCE_EXPIRED", "terminal request nonce expired; create a new request_id");
    return clone(existing.result);
  }

  async #execute(adapter, request, runtimeId, configHash) {
    try {
      const output = await adapter.execute({ request: clone(request), material: clone(request.material), runtime_id: runtimeId, config_hash: configHash });
      const raw = typeof output?.raw === "string" ? output.raw : "";
      const executionEligible = output?.execution_eligible === true && raw.length > 0;
      return {
        id: adapter.id,
        status: executionEligible ? "completed" : "failed",
        execution_eligible: executionEligible,
        session_id: typeof output?.session_id === "string" ? output.session_id : null,
        runtime_id: null,
        receipt_ref: null,
        diagnostic_ref: output?.diagnostic ? `private://${runtimeId}/${adapter.id}/diagnostic` : null,
        metrics: normalizeMetrics(output?.metrics, request.material),
        error_code: executionEligible ? null : (typeof output?.error_code === "string" ? output.error_code : "ADAPTER_OUTPUT_INVALID"),
        persisted: true,
        raw,
        diagnostic: typeof output?.diagnostic === "string" ? output.diagnostic : null,
      };
    } catch (error) {
      return {
        id: adapter.id,
        status: "failed",
        execution_eligible: false,
        session_id: null,
        runtime_id: null,
        receipt_ref: null,
        diagnostic_ref: `private://${runtimeId}/${adapter.id}/diagnostic`,
        metrics: normalizeMetrics({}, request.material),
        error_code: "ADAPTER_FAILED",
        persisted: true,
        raw: "",
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }

  readPrivate({ runtime_id, provider, nonce, ref }) {
    validateRuntimeId(runtime_id);
    validateProviderId(provider);
    assertPrivateRef(ref);
    const entry = this.#private.get(`${runtime_id}:${provider}`);
    if (!entry || entry.nonce !== nonce) throw new ProtocolError("BINDING_MISMATCH", "private payload binding does not match runtime/provider/nonce");
    if (this.now() > entry.expiresAt) throw new ProtocolError("NONCE_EXPIRED", "terminal request nonce expired; create a new request_id");
    return clone(entry[ref]);
  }
}
