import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { adapter } from "./adapters/index.mjs";
import { execute } from "./process.mjs";
import { cancellationRequested, cancellationSource, claimProvider, createRuntime, cleanup, INVALID_CANCELLATION_SOURCE, isAlive, readRuntime, releaseProviderClaim, requestCancellation, runtimeDirectory, terminateProcessTree, updateRunningProvider, updateRuntime } from "./runtime.mjs";
import { fail, publicError } from "./errors.mjs";
import { canonicalDeliveryManifestHash, canonicalMaterialManifestHash, enforcePromptBudget, planDelivery, prepareCheckedAttachments, prepareWritableAttachmentView, probeAttachmentWorkspace, refreshWritableAttachmentView, renderProviderPrompt, validateAttachmentRoot, validateAttachments, validateContinuationTriad, validateFileOnlyTriad, verifyFrozenAttachments, verifyWritableAttachmentView } from "./attachments.mjs";
import { lastProviderMaterial, providerHasContinuationPredecessor, recordContinuationMaterial, releaseContinuationMaterial, reserveContinuationMaterial } from "./continuation-materials.mjs";

const providers = new Set(["claude-code", "kimi", "codex", "opencode"]);
const fallbackEligibleCodes = new Set(["PROCESS_START_FAILED"]);
const retryableTerminationCodes = new Set(["PROCESS_DEAD", "PROCESS_TIMEOUT"]);
const MATERIAL_PROTOCOL_VERSION = 5;
const timeoutMaterialFields = ["sequence", "bundle_id", "manifest_hash", "delivery_manifest_hash", "initial_material_manifest_hash", "previous_delivery_manifest_hash"];
function hasSession(item) { return typeof item?.session_id === "string" && item.session_id.length > 0; }
function noSemanticResult(item) { return item?.output === undefined && item?.semantic_verdict === undefined && item?.verdict === undefined && item?.published_verdict === undefined; }
function timeoutRetryCandidate(item) {
  return item?.status === "failed" && retryableTerminationCodes.has(item.error?.code) && hasSession(item)
    && !item.cancellation_source && !item.error?.source && noSemanticResult(item) && item.timeout_retry?.version === 1;
}
function sameTimeoutMaterial(left, right) { return timeoutMaterialFields.every((field) => left?.[field] === right?.[field]); }
function timeoutRetryEligible(item, material) {
  if (!timeoutRetryCandidate(item)) return false;
  return material ? sameTimeoutMaterial(item.timeout_retry.material, material) : item.timeout_retry.attachment_free === true;
}
function continuationEligible(item, material, candidateOnly = false) { return item?.status === "completed" || (item?.status === "running" && isAlive(item.pid)) || (candidateOnly ? timeoutRetryCandidate(item) : timeoutRetryEligible(item, material)); }
function frozenDescriptor(runtime, key, binding, deliveryMode, visible = null) {
  let stored; try { stored = JSON.parse(fs.readFileSync(path.join(runtime, "workspace", key, "attachments-manifest.json"), "utf8")); }
  catch { fail("ATTACHMENT_IMMUTABLE", "frozen attachment manifest is unavailable"); }
  if (stored.bundle_id !== binding.bundle_id || stored.manifest_hash !== binding.manifest_hash || canonicalMaterialManifestHash(stored.bundle_id, stored.files) !== binding.manifest_hash || canonicalDeliveryManifestHash(stored.bundle_id, stored.files, deliveryMode) !== binding.delivery_manifest_hash) fail("MATERIAL_INCOMPLETE", "frozen attachment workspace does not match its material chain");
  if (visible) {
    const files = stored.files.map(({ target: destination, sha256, size }) => ({ destination, sha256, size }));
    if (!isDeepStrictEqual(files, visible)) fail("MATERIAL_INCOMPLETE", "frozen provider workspace does not match its delivery receipt");
  }
  return stored;
}
function request(value) {
  if (!value || value.version !== 4 || typeof value.prompt !== "string" || value.prompt.length === 0 || !providers.has(value.host_provider)) fail("REQUEST_INVALID", "request needs version:4, a non-empty prompt, and a supported host_provider");
  if (value.continuation !== null && value.continuation !== undefined && (typeof value.continuation !== "object" || typeof value.continuation.runtime_id !== "string")) fail("REQUEST_INVALID", "continuation must be null or contain runtime_id");
  if (value.provider_allowlist !== undefined) {
    if (!Array.isArray(value.provider_allowlist) || value.provider_allowlist.length === 0 || value.provider_allowlist.some((provider) => !providers.has(provider) || provider === value.host_provider) || new Set(value.provider_allowlist).size !== value.provider_allowlist.length) fail("REQUEST_INVALID", "provider_allowlist must contain unique supported heterologous providers");
  }
  const reuseFrozenMaterial = value.continuation?.reuse_frozen_material;
  if (reuseFrozenMaterial !== undefined && reuseFrozenMaterial !== true) fail("REQUEST_INVALID", "continuation.reuse_frozen_material must be true when present");
  if (reuseFrozenMaterial === true && (value.attachments || value.provider_allowlist?.length !== 1)) fail("REQUEST_INVALID", "reuse_frozen_material requires no attachments and exactly one provider_allowlist entry");
  return value;
}
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

export class Broker {
  constructor(config, options = {}) { this.config = config; this.processOptions = options; this.active = new Map(); this.shuttingDown = false; cleanup(config.runtime.root, config.runtime.ttl_hours); }

  async doctor({ attachmentRoot = null } = {}) {
    let attachmentRootStatus = this.#attachmentRootStatus(attachmentRoot);
    const attachmentProbe = new Map();
    if (attachmentRootStatus.status === "ready") {
      for (const provider of Object.values(this.config.providers)) {
        if (!provider.enabled) continue;
        try { probeAttachmentWorkspace(this.config.runtime.root, provider.id, this.config.runtime.max_attachment_bytes); attachmentProbe.set(provider.id, true); }
        catch { attachmentProbe.set(provider.id, false); }
      }
      if ([...attachmentProbe.values()].some((ready) => !ready)) attachmentRootStatus = { status: "unavailable", error: { code: "ATTACHMENT_PROBE_FAILED" } };
    }
    const orderedProviderIds = [...new Set(this.config.tiers.flat())];
    const output = await Promise.all(orderedProviderIds.map(async (id) => { const provider = this.config.providers[id];
      const capabilities = adapter(provider.id).capabilities;
      const probeFailed = attachmentProbe.get(provider.id) === false;
      const readyCapabilities = probeFailed ? { ...capabilities, attachment_delivery: [] } : capabilities;
      if (!provider.enabled) return { provider: provider.id, status: "disabled", capabilities: readyCapabilities };
      const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
      if (missing.length) return { provider: provider.id, status: "unavailable", capabilities: readyCapabilities, error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } };
      if (probeFailed) return { provider: provider.id, status: "unavailable", capabilities: readyCapabilities, error: { code: "ATTACHMENT_PROBE_FAILED", message: "attachment workspace probe failed" } };
      const work = fs.mkdtempSync(path.join(this.config.runtime.root, "doctor-"));
      try { const result = await execute(adapter(provider.id).doctor(provider, work), { maxOutputBytes: 65536 }); return result.ok ? { provider: provider.id, status: "ready", verification: "executable_only", capabilities: readyCapabilities } : { provider: provider.id, status: "unavailable", capabilities: readyCapabilities, error: result.error }; }
      finally { fs.rmSync(work, { recursive: true, force: true }); }
    }));
    const attachmentVerification = attachmentRoot ? "workspace_copy_only" : "unverified";
    return { version: 4, capabilities: { attachments: attachmentRootStatus.status !== "unavailable", cancel_source: true }, attachment_root: attachmentRootStatus, verification: attachmentVerification, note: "doctor does not verify model authentication or a real review", providers: output };
  }

  #attachmentRootStatus(attachmentRoot) {
    if (this.config.attachment_roots.length === 0) return { status: "unavailable", error: { code: "ATTACHMENT_ROOT_UNCONFIGURED" } };
    if (!attachmentRoot) return { status: "unverified" };
    try { validateAttachmentRoot(attachmentRoot, this.config.attachment_roots); return { status: "ready" }; }
    catch (error) { return { status: "unavailable", error: { code: publicError(error).code } }; }
  }

  status(runtime_id) { cleanup(this.config.runtime.root, this.config.runtime.ttl_hours); return projectStatus(readRuntime(this.config.runtime.root, runtime_id)); }

  shutdown() {
    this.shuttingDown = true;
    const cancelled = [];
    for (const { runtime_id, provider, pid } of this.active.values()) {
      requestCancellation(this.config.runtime.root, runtime_id, provider, "workflow_shutdown");
      if (terminateProcessTree(pid, "SIGTERM")) cancelled.push({ runtime_id, provider });
    }
    return cancelled;
  }

  cancel(runtime_id, provider, source = "user") {
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
    const input = request(raw); const promptBytes = Buffer.byteLength(input.prompt, "utf8"); if (promptBytes > this.config.runtime.max_prompt_bytes && input.attachments?.delivery !== "always_embed") fail("PROMPT_TOO_LARGE", `prompt exceeds ${this.config.runtime.max_prompt_bytes} bytes`);
    const continuing = input.continuation?.runtime_id; const reuseFrozenMaterial = input.continuation?.reuse_frozen_material === true;
    let state = continuing ? readRuntime(this.config.runtime.root, continuing) : null;
    if (continuing && state.attachments && state.attachments.protocol_version !== MATERIAL_PROTOCOL_VERSION) fail("MATERIAL_PROTOCOL_MISMATCH", "attachment runtime uses an incompatible material protocol");
    const initialChecked = !continuing && input.attachments ? validateAttachments(input.attachments, this.config.runtime.max_attachment_bytes, this.config.attachment_roots) : null;
    if (initialChecked) validateFileOnlyTriad(initialChecked);
    let deliveryChecked = initialChecked;
    state ??= createRuntime(this.config.runtime.root, this.config.runtime.ttl_hours, input.host_provider, this.config.runtime.orphan_timeout_ms);
    if (continuing && state.expires_at_ms <= Date.now()) fail("RUNTIME_EXPIRED", "runtime has expired and cannot be continued");
    if (state.host_provider !== input.host_provider) fail("HOST_MISMATCH", "continuation host_provider must match its first round");
    let continuationMaterial = null;
    if (continuing) {
      const hasContinuableSession = Object.values(state.providers ?? {}).some((item) => continuationEligible(item, null, true) && hasSession(item));
      if (reuseFrozenMaterial && !state.attachments) fail("MATERIAL_INCOMPLETE", "reuse_frozen_material requires frozen initial material");
      if (state.attachments && !input.attachments && hasContinuableSession && !reuseFrozenMaterial) fail("MATERIAL_INCOMPLETE", "continuation requires an independent delta attachment triad");
      if (!state.attachments && input.attachments) fail("MATERIAL_INCOMPLETE", "continuation cannot add attachments to an attachment-free initial round");
      if (state.attachments && input.attachments) {
        if (input.attachments.delivery !== state.attachments.requested_delivery) fail("MATERIAL_INCOMPLETE", "continuation attachment delivery must match the initial delivery mode");
        const checked = validateAttachments(input.attachments, this.config.runtime.max_attachment_bytes, this.config.attachment_roots); const binding = validateContinuationTriad(checked, state);
        deliveryChecked = checked;
        const previous = state.continuation_materials ?? [];
        continuationMaterial = { sequence: binding.sequence, workspace_round: state.round + 1, bundle_id: checked.bundle_id, manifest_hash: checked.manifest_hash, delivery_manifest_hash: binding.delivery_manifest_hash, initial_material_manifest_hash: state.attachments.manifest_hash,
          previous_delivery_manifest_hash: previous.length ? previous.at(-1).delivery_manifest_hash : null };
      }
    } else if (input.attachments) {
      const checked = initialChecked;
      state = updateRuntime(this.config.runtime.root, state.runtime_id, (next) => ({ ...next, attachments: { protocol_version: MATERIAL_PROTOCOL_VERSION, requested_delivery: checked.requested_delivery, bundle_id: checked.bundle_id, manifest_hash: checked.manifest_hash, files: checked.files } }));
    }
    const allowlist = input.provider_allowlist ? new Set(input.provider_allowlist) : null;
    const selected = continuing ? Object.keys(state.providers).filter((id) => id !== input.host_provider && (!allowlist || allowlist.has(id)) && continuationEligible(state.providers[id], continuationMaterial) && hasSession(state.providers[id]) && (!continuationMaterial || providerHasContinuationPredecessor(state, id, state.providers[id].session_id, continuationMaterial.sequence))) : null;
    const entries = continuing ? selected.map((id) => ({ id, tier: null, continuation: true })) : this.#route(input.host_provider, allowlist);
    const output = []; if (continuing && entries.length === 0) return this.#finish(state.runtime_id, input, [{ provider: null, status: "failed", error: { code: "NO_CONTINUABLE_SESSION", message: "no successful provider session is available" } }], null);
    if (continuing) output.push(...await Promise.all(entries.map((entry) => this.#runProvider(state.runtime_id, input, entry, continuationMaterial, deliveryChecked))));
    else {
      for (const tier of entries) {
        const results = await Promise.all(tier.map((entry) => this.#runProvider(state.runtime_id, input, entry, null, deliveryChecked))); output.push(...results);
        if (results.some((result) => result.status === "completed")) return this.#finish(state.runtime_id, input, output, tier[0]?.tier ?? null);
        if (!results.every((result) => fallbackEligibleCodes.has(result.error?.code))) return this.#finish(state.runtime_id, input, output, null);
      }
    }
    return this.#finish(state.runtime_id, input, output, null);
  }

  #route(host, allowlist = null) {
    return this.config.tiers.map((tier, index) => {
      const entries = tier.filter((id) => !allowlist || allowlist.has(id)).map((id) => id === host ? { id, tier: index, skip: "SAME_SOURCE" } : { id, tier: index });
      return allowlist ? entries : entries.filter((entry) => !entry.skip).slice(0, 1);
    });
  }
  async #runProvider(runtime_id, input, entry, continuationMaterial, deliveryChecked) {
    if (this.shuttingDown) return { provider: entry.id, tier: entry.tier, status: "cancelled", cancellation_source: "workflow_shutdown", error: { code: "CANCELLED", message: "broker is shutting down", source: "workflow_shutdown" } };
    if (entry.skip) return { provider: entry.id, tier: entry.tier, status: "skipped", error: { code: entry.skip, message: "host provider cannot review itself" } };
    const provider = this.config.providers[entry.id];
    if (!provider) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED", message: "provider is absent from the current config" } };
    if (!provider.enabled) return { provider: entry.id, tier: entry.tier, status: "skipped", error: { code: "PROVIDER_DISABLED", message: "disabled in config" } };
    const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
    if (missing.length) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } };
    const claim = claimProvider(this.config.runtime.root, runtime_id, entry.id, this.config.runtime.orphan_timeout_ms);
    if (!claim) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_BUSY", message: "provider is claimed by another broker" } };
    try { return await this.#runClaimedProvider(runtime_id, input, entry, provider, continuationMaterial, deliveryChecked); }
    finally { releaseProviderClaim(claim); }
  }
  async #runClaimedProvider(runtime_id, input, entry, provider, continuationMaterial, deliveryChecked) {
    const prompt = input.prompt;
    const state = readRuntime(this.config.runtime.root, runtime_id); const prior = state.providers[entry.id]; if (prior?.status === "running" && isAlive(prior.pid)) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_BUSY", message: "provider has an active process" } };
    const runtime = runtimeDirectory(this.config.runtime.root, runtime_id); const worker = adapter(entry.id); let cwd; let providerPrompt = renderProviderPrompt(worker, prompt); let deliveryUsed = prior?.delivery_used ?? null; let delivery = prior?.delivery ?? null; let attachmentKey = entry.id; let attachmentStored = null;
    try {
      if (!input.attachments) enforcePromptBudget(providerPrompt, this.config.runtime.max_prompt_bytes);
      if (input.attachments) {
        // Decide delivery before a provider workspace or prompt is rendered.
        // file_only never materializes the packet into a request string.
        if (!deliveryChecked) fail("MATERIAL_INCOMPLETE", "validated sealed material is unavailable");
        const checked = deliveryChecked;
        attachmentKey = entry.continuation ? `${entry.id}-delta-${state.round + 1}` : entry.id;
        deliveryUsed = input.attachments.delivery;
        if (deliveryUsed === "file_only") validateFileOnlyTriad(checked);
        const planned = planDelivery(worker, checked, prompt, this.config.runtime.max_prompt_bytes);
        deliveryUsed = planned.delivery_mode;
        delivery = { delivery_mode: planned.delivery_mode, sealed_manifest_hash: checked.manifest_hash, provider_visible_manifest_hash: planned.material_manifest_hash, material_total_bytes: planned.material_total_bytes, ...(planned.rendered_prompt_bytes !== undefined ? { rendered_prompt_bytes: planned.rendered_prompt_bytes } : {}), provider_visible_attachment_manifest: planned.provider_visible_attachment_manifest };
        if (entry.continuation) {
          verifyFrozenAttachments(runtime, entry.id, state.attachments);
          if (timeoutRetryEligible(prior, continuationMaterial)) {
            if (prior.delivery?.delivery_mode !== delivery.delivery_mode || prior.delivery?.sealed_manifest_hash !== delivery.sealed_manifest_hash || prior.delivery?.provider_visible_manifest_hash !== delivery.provider_visible_manifest_hash) fail("MATERIAL_INCOMPLETE", "timeout retry delivery does not match its unpublished material");
          } else {
            const priorMaterial = lastProviderMaterial(state, entry.id, prior?.session_id);
            const expectedMaterialHash = priorMaterial?.manifest_hash ?? state.attachments.manifest_hash;
            if (prior?.delivery?.provider_visible_manifest_hash !== expectedMaterialHash) fail("MATERIAL_INCOMPLETE", "continuation delivery record does not match its provider/session material chain");
          }
          this.#reserveContinuationMaterial(runtime_id, continuationMaterial, entry.id, prior?.session_id);
        }
        const prepared = prepareCheckedAttachments(checked, runtime, attachmentKey);
        verifyFrozenAttachments(runtime, attachmentKey, prepared);
        attachmentStored = prepared; delivery = { ...delivery, byte_identity: "verified" };
        providerPrompt = planned.provider_prompt;
        if (deliveryUsed === "always_embed") { cwd = path.join(runtime, "embed", entry.id); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); }
        else cwd = prepared.cwd;
      } else if (entry.continuation && state.attachments) {
        deliveryUsed = prior?.delivery_used; delivery = prior?.delivery ?? null; let frozenKey = entry.id; let providerStored = state.attachments;
        if (input.continuation?.reuse_frozen_material) {
          const latest = lastProviderMaterial(state, entry.id, prior?.session_id);
          if (latest) {
            if (delivery?.sealed_manifest_hash !== latest.manifest_hash || delivery?.provider_visible_manifest_hash !== latest.manifest_hash) fail("MATERIAL_INCOMPLETE", "continuation delivery record does not match the latest provider/session material");
            frozenKey = `${entry.id}-delta-${latest.workspace_round ?? latest.sequence + 1}`;
            providerStored = frozenDescriptor(runtime, frozenKey, latest, deliveryUsed, delivery.provider_visible_attachment_manifest);
          } else if (delivery?.sealed_manifest_hash !== state.attachments.manifest_hash || delivery?.provider_visible_manifest_hash !== state.attachments.manifest_hash) fail("MATERIAL_INCOMPLETE", "continuation delivery record does not match initial material");
        }
        const frozen = verifyFrozenAttachments(runtime, frozenKey, providerStored); attachmentKey = frozenKey; attachmentStored = providerStored;
        if (!worker.capabilities?.attachment_delivery?.includes(deliveryUsed)) fail("ATTACHMENT_DELIVERY_UNSUPPORTED", "provider attachment capability changed since the first round");
        if (!delivery || delivery.delivery_mode !== deliveryUsed || delivery.provider_visible_manifest_hash !== providerStored.manifest_hash || delivery.byte_identity !== "verified" || !Array.isArray(delivery.provider_visible_attachment_manifest)) fail("MATERIAL_INCOMPLETE", "continuation delivery record does not match frozen material");
        if (deliveryUsed === "always_embed") { cwd = path.join(runtime, "embed", entry.id); if (!fs.existsSync(cwd)) fail("ATTACHMENT_IMMUTABLE", "embedded provider workspace is unavailable"); }
        else cwd = frozen.cwd;
      } else { cwd = path.join(runtime, "workspace", entry.id); fs.mkdirSync(path.join(cwd, "skills"), { recursive: true, mode: 0o700 }); }
      if (worker.requiresWritableCwd && worker.stableContinuationCwd && attachmentStored) cwd = refreshWritableAttachmentView(runtime, entry.id, attachmentKey, attachmentStored).cwd;
      else if (worker.requiresWritableCwd && attachmentStored) cwd = prepareWritableAttachmentView(runtime, attachmentKey, attachmentStored).cwd;
      else if (worker.requiresWritableCwd && worker.stableContinuationCwd && state.attachments) cwd = refreshWritableAttachmentView(runtime, entry.id, attachmentKey, attachmentStored ?? state.attachments).cwd;
      else if (worker.requiresWritableCwd && state.attachments) cwd = prepareWritableAttachmentView(runtime, entry.id, state.attachments).cwd;
    } catch (error) { return this.#setupFailure(runtime_id, entry, deliveryUsed, delivery, error, entry.continuation && prior?.status === "completed", continuationMaterial, prior?.session_id); }
    let plan;
    try {
      const bundle = deliveryUsed === "file_only" ? (fs.existsSync(path.join(cwd, "bundle")) ? path.join(cwd, "bundle") : cwd) : null;
      // file_only has no provider-visible file except the frozen bundle. The
      // prompt is delivered by stdin; legacy review-input.md stays host-only.
      if (!worker.promptViaStdin && deliveryUsed !== "file_only") fs.writeFileSync(path.join(cwd, "review-input.md"), providerPrompt, { mode: 0o600 });
      const providerCwd = worker.runFromWritableRoot ? cwd : worker.requiresWritableCwd && worker.stableContinuationCwd ? (bundle ?? cwd) : worker.requiresWritableCwd ? cwd : (bundle ?? cwd);
      plan = entry.continuation ? worker.resume(provider, providerCwd, prior.session_id, providerPrompt, runtime) : worker.start(provider, providerCwd, providerPrompt, runtime);
      if (typeof worker.probeSession === "function") plan = { ...plan, probeSession: (ctx) => worker.probeSession({ ...ctx, provider, cwd: providerCwd, runtime }) };
      if (bundle && worker.requiresWritableCwd) verifyWritableAttachmentView(runtime, worker.stableContinuationCwd ? entry.id : attachmentKey, attachmentStored ?? state.attachments);
      else if (bundle) verifyFrozenAttachments(runtime, attachmentKey, attachmentStored ?? state.attachments);
    }
    catch (error) { return this.#setupFailure(runtime_id, entry, deliveryUsed, delivery, error, entry.continuation && prior?.status === "completed", continuationMaterial, prior?.session_id); }
    const touch = (patch) => updateRunningProvider(this.config.runtime.root, runtime_id, entry.id, patch);
    const result = await execute(plan, {
      ...this.processOptions,
      maxOutputBytes: this.config.runtime.max_output_bytes,
      maxWallClockMs: this.config.runtime.max_wall_clock_ms,
      livenessIntervalMs: this.config.runtime.liveness_interval_ms,
      isCancelled: () => cancellationRequested(this.config.runtime.root, runtime_id, entry.id),
      validateCompleted: (raw) => worker.parse(raw.stdout, raw.stderr).ok,
      onStart: (pid) => { const current = Date.now(); this.active.set(`${runtime_id}:${entry.id}`, { runtime_id, provider: entry.id, pid }); updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, owner: { pid: process.pid, started_at_ms: current }, providers: { ...next.providers, [entry.id]: { provider: entry.id, tier: entry.tier, status: "running", pid, started_at_ms: current, process_alive_at_ms: current, last_progress_at_ms: null, session_id: prior?.session_id ?? null, ...(deliveryUsed ? { delivery_used: deliveryUsed } : {}), ...(delivery ? { delivery } : {}) } } })); if (this.shuttingDown) { requestCancellation(this.config.runtime.root, runtime_id, entry.id, "workflow_shutdown"); terminateProcessTree(pid, "SIGTERM"); } },
      onLiveness: () => touch({ process_alive_at_ms: Date.now() }),
      onProgress: ({ at_ms }) => touch({ last_progress_at_ms: at_ms }),
    });
    this.active.delete(`${runtime_id}:${entry.id}`);
    const rawRefs = this.#storeRaw(runtime, entry.id, result.stdout, result.stderr);
    const cancelled = cancellationRequested(this.config.runtime.root, runtime_id, entry.id);
    const telemetry = { retry_count: result.retry_count, api_empty_response_count: result.retry_count, progress_events: result.progress_events, last_progress_at_ms: result.last_progress_at_ms };
    const deliveryOutcome = deliveryUsed ? { delivery_used: deliveryUsed, ...(delivery ? { delivery } : {}) } : {};
    if (cancelled) { this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id); const source = cancellationSource(this.config.runtime.root, runtime_id, entry.id); const invalidSource = source === INVALID_CANCELLATION_SOURCE; return this.#store(runtime_id, entry, { status: "cancelled", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, cancellation_source: source, error: invalidSource ? { code: "CANCEL_SOURCE_INVALID", message: "cancel marker source is invalid", source } : { code: "CANCELLED", message: `cancel was requested by ${source}`, source } }); }
    if (!result.ok) {
      this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id);
      const timeout_retry = retryableTerminationCodes.has(result.error?.code) && entry.continuation ? { version: 1, ...(continuationMaterial ? { material: continuationMaterial } : { attachment_free: true }) } : null;
      return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: result.error, diagnostic: short(`${result.stdout}\n${result.stderr}`) }, timeout_retry ? { timeout_retry } : null);
    }
    const parsed = worker.parse(result.stdout, result.stderr);
    if (!parsed.ok) { this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id); return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: parsed.error, diagnostic: short(`${result.stdout}\n${result.stderr}`) }); }
    if (entry.continuation && (input.attachments || input.continuation?.reuse_frozen_material) && parsed.session_id !== prior.session_id) { this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id); return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: { code: "MATERIAL_INCOMPLETE", message: "continuation provider did not preserve its native session" } }); }
    if (entry.continuation && input.attachments) this.#recordContinuationMaterial(runtime_id, continuationMaterial, entry.id, prior.session_id);
    return this.#store(runtime_id, entry, { status: "completed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, session_id: parsed.session_id, usage: parsed.usage, output: parsed.text }, { timeout_retry: undefined });
  }
  #storeRaw(runtime, provider, stdout, stderr) {
    const directory = path.join(runtime, "raw", provider); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const suffix = `${Date.now()}-${process.pid}-${process.hrtime.bigint()}`; const refs = {};
    for (const [stream, value] of [["stdout", stdout], ["stderr", stderr]]) { const target = path.join(directory, `round-${suffix}.${stream}`); fs.writeFileSync(target, value, { mode: 0o400, flag: "wx" }); refs[`raw_${stream}_ref`] = path.relative(runtime, target); refs[`raw_${stream}_sha256`] = createHash("sha256").update(value).digest("hex"); }
    return refs;
  }
  #setupFailure(runtime_id, entry, deliveryUsed, delivery, error, preservePrior = false, material = null, session_id = null) {
    this.#releaseContinuationReservation(runtime_id, material, entry.id, session_id);
    const result = { status: "failed", ...(deliveryUsed ? { delivery_used: deliveryUsed } : {}), ...(delivery ? { delivery } : {}), error: publicError(error) };
    return deliveryUsed && !preservePrior ? this.#store(runtime_id, entry, result) : { provider: entry.id, tier: entry.tier, ...result };
  }
  #recordContinuationMaterial(runtime_id, material, provider, session_id) {
    updateRuntime(this.config.runtime.root, runtime_id, (next) => recordContinuationMaterial(next, material, provider, session_id));
  }
  #reserveContinuationMaterial(runtime_id, material, provider, session_id) {
    updateRuntime(this.config.runtime.root, runtime_id, (next) => reserveContinuationMaterial(next, material, provider, session_id));
  }
  #releaseContinuationReservation(runtime_id, material, provider, session_id) {
    updateRuntime(this.config.runtime.root, runtime_id, (next) => releaseContinuationMaterial(next, material, provider, session_id));
  }
  #store(runtime_id, entry, result, privateResult = null) { updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, providers: { ...next.providers, [entry.id]: { ...next.providers[entry.id], provider: entry.id, tier: entry.tier, ...result, ...(privateResult ?? {}), completed_at_ms: Date.now() } } })); const { raw_stdout_ref, raw_stderr_ref, ...publicResult } = result; return { provider: entry.id, tier: entry.tier, ...publicResult }; }
  #finish(runtime_id, input, providers, selected_tier) {
    const state = updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, round: next.round + 1, last_prompt_bytes: Buffer.byteLength(input.prompt, "utf8"), last_selected_tier: selected_tier, last_completed_at_ms: Date.now() }));
    const codes = new Set(providers.map((item) => item.error?.code).filter(Boolean));
    const outcome = providers.some((item) => item.status === "completed") ? "completed"
      : providers.length > 0 && providers.every((item) => fallbackEligibleCodes.has(item.error?.code)) ? "unavailable"
        : providers.some((item) => item.status === "cancelled") ? "cancelled"
          : codes.has("PROCESS_STALLED") ? "stalled"
            : [...codes].some((code) => ["HEALTH_UNVERIFIABLE", "PROBE_DEADLINE", "PROBE_ABORT_FAILED", "PROBE_FAILED"].includes(code)) ? "unverifiable"
              : "invalid_output";
    return { version: 4, outcome, runtime_id, round: state.round, host_provider: state.host_provider, selected_tier, providers };
  }
}
