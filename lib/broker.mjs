import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { adapter } from "./adapters/index.mjs";
import { execute } from "./process.mjs";
import { cancellationRequested, cancellationSource, claimProvider, createRuntime, cleanup, currentOwnerIdentity, ensureRuntimeGuardian, INVALID_CANCELLATION_SOURCE, ownerConfirmedDead, processIdentity, readRuntime, releaseProviderClaim, removeRuntimeDirectory, requestCancellation, runtimeDirectory, terminateProcessTree, updateRunningProvider, updateRuntime, workerIdentityMatches } from "./runtime.mjs";
import { fail, publicError } from "./errors.mjs";
import { adapterForProviderId, parseProviderId, providerRuntimeKey } from "./provider-ids.mjs";
import { canonicalDeliveryManifestHash, canonicalJson, canonicalMaterialManifestHash, discardManagedAttachments, freezeManagedAttachments, planDelivery, prepareCheckedAttachments, prepareWritableAttachmentView, probeAttachmentWorkspace, refreshWritableAttachmentView, renderProviderPrompt, validateAttachmentRoot, validateAttachments, validateContinuationTriad, validateFileOnlyTriad, verifyFrozenAttachments, verifyWritableAttachmentView } from "./attachments.mjs";
import { lastProviderMaterial, providerHasContinuationPredecessor, recordContinuationMaterial, releaseContinuationMaterial, reserveContinuationMaterial } from "./continuation-materials.mjs";

const fallbackEligibleCodes = new Set(["PROCESS_START_FAILED"]);
const retryableTerminationCodes = new Set(["PROCESS_DEAD", "PROCESS_TIMEOUT"]);
const MATERIAL_PROTOCOL_VERSION = 5;
const MATERIAL_PROTOCOL = Object.freeze({ version: MATERIAL_PROTOCOL_VERSION, delivery_attestation: "sealed-exact-copy.v1" });
const WORKFLOWHUB_RESULT_PROTOCOL_V1 = "workflowhub-result.v1";
const WORKFLOWHUB_RESULT_PROTOCOL_V2 = "workflowhub-result.v2";
const WORKFLOWHUB_RESULT_PROTOCOLS = new Set([WORKFLOWHUB_RESULT_PROTOCOL_V1, WORKFLOWHUB_RESULT_PROTOCOL_V2]);
const managedManagerProgram = fileURLToPath(new URL("./managed-session-manager.mjs", import.meta.url));
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
function continuationEligible(item, material, candidateOnly = false) { return item?.status === "completed" || (item?.status === "running" && workerIdentityMatches(item.worker)) || (candidateOnly ? timeoutRetryCandidate(item) : timeoutRetryEligible(item, material)); }
function frozenDescriptor(runtime, key, binding, deliveryMode, visible = null) {
  const runtimeKey = providerRuntimeKey(key) ?? key;
  let stored; try { stored = JSON.parse(fs.readFileSync(path.join(runtime, "workspace", runtimeKey, "attachments-manifest.json"), "utf8")); }
  catch { fail("ATTACHMENT_IMMUTABLE", "frozen attachment manifest is unavailable"); }
  if (stored.bundle_id !== binding.bundle_id || stored.manifest_hash !== binding.manifest_hash || canonicalMaterialManifestHash(stored.bundle_id, stored.files) !== binding.manifest_hash || canonicalDeliveryManifestHash(stored.bundle_id, stored.files, deliveryMode) !== binding.delivery_manifest_hash) fail("MATERIAL_INCOMPLETE", "frozen attachment workspace does not match its material chain");
  if (visible) {
    const files = stored.files.map(({ target: destination, sha256, size }) => ({ destination, sha256, size }));
    if (!isDeepStrictEqual(files, visible)) fail("MATERIAL_INCOMPLETE", "frozen provider workspace does not match its delivery receipt");
  }
  return stored;
}
function isWorkflowHubResultProtocol(value) { return WORKFLOWHUB_RESULT_PROTOCOLS.has(value); }
function workflowHubResultV1(value, checked) {
  const result = {
    provider: value.provider ?? null,
    status: value.status === "skipped" ? "failed" : value.status,
    result_protocol: WORKFLOWHUB_RESULT_PROTOCOL_V1,
    material_id: checked?.material_id,
    session_id: value.session_id ?? null,
    output: value.output ?? null,
    error: value.error ?? null,
  };
  return containsPrivatePathDeep(result) ? publicInvalidV1Result(value, checked) : result;
}
function integerOrNull(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
const workflowHubV2ProviderFields = Object.freeze([
  "adapter", "continuable", "effort", "error", "material_id", "model", "output", "provider",
  "raw_output_ref", "result_protocol", "retry", "runtime_id", "session_file_path", "session_id",
  "status", "thinking", "timing", "unavailable_diagnostics", "usage",
].sort());
const workflowHubV2GroupFields = Object.freeze(["host_provider", "outcome", "providers", "round", "runtime_id", "selected_tier", "version"].sort());
const workflowHubV2Outcomes = new Set(["completed", "unavailable", "cancelled", "stalled", "unverifiable", "invalid_output"]);
const workflowHubV2TimingFields = Object.freeze(["completed_at_ms", "duration_ms", "started_at_ms"].sort());
const workflowHubV2RetryFields = Object.freeze(["count", "progress_events"].sort());
const workflowHubV2OutputRefFields = Object.freeze(["provider", "runtime_id", "stderr_sha256", "stdout_sha256", "version"].sort());
const workflowHubV2DiagnosticFields = Object.freeze(["code", "message"].sort());
const absolutePathPattern = /(?:^|[^A-Za-z0-9._~/%-])(?:\/[A-Za-z0-9._-]+(?:\/|$)|[A-Za-z]:[\\/])/;
const fileUriPathPattern = /\bfile:\/\/\/(?:[A-Za-z0-9._~%-]|%[A-Fa-f0-9]{2})/i;
function containsPrivatePath(value) { return typeof value === "string" && (absolutePathPattern.test(value) || fileUriPathPattern.test(value)); }
function containsPrivatePathDeep(value) {
  if (containsPrivatePath(value)) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsPrivatePathDeep(item));
  return Object.values(value).some((item) => containsPrivatePathDeep(item));
}
function managedPublicPath(root, runtime_id) { return path.join(root, runtime_id, "managed", "public.json"); }
function managedJobPath(root, runtime_id, operation_id) { return path.join(root, runtime_id, "managed", "operations", `${operation_id}.json`); }
function managedRequestPath(root, request_id) { return path.join(root, "managed-requests", createHash("sha256").update(request_id, "utf8").digest("hex"), "binding.json"); }
function writePrivateJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, target);
}
function readPrivateJson(target, code, message) {
  try { return JSON.parse(fs.readFileSync(target, "utf8")); }
  catch { fail(code, message); }
}
function opaqueRequestId(value) {
  if (typeof value !== "string" || value.length === 0 || containsPrivatePath(value) || /[\u0000-\u001f]/.test(value)) fail("REQUEST_INVALID", "request_id must be a non-empty opaque public identifier");
  return value;
}
function managedPublic(operation, runtime_id) {
  // Status is projected from the current operation, rather than the last
  // published snapshot.  A snapshot written by `start` is necessarily
  // `starting`; reusing it after the manager advanced to `running` (or
  // `terminal`) makes a healthy managed review appear permanently stuck.
  const state = operation.state === "terminal" ? "terminal" : operation.state === "running" ? "running" : "starting";
  const value = { version: "workflowhub-run.v1", request_id: operation.request_id, runtime_id, state, material_id: operation.material_id };
  return state === "terminal" ? { ...value, group: operation.group } : value;
}
function assertManagedPublic(value) {
  assertNoPrivatePaths(value, "managed public result");
  if (!value || value.version !== "workflowhub-run.v1" || typeof value.request_id !== "string" || typeof value.runtime_id !== "string" || !["starting", "running", "terminal"].includes(value.state) || typeof value.material_id !== "string") fail("PUBLIC_RESULT_INVALID", "managed result has an invalid public schema");
  if (value.state === "terminal") assertWorkflowHubV2Group(value.group, value.runtime_id, value.material_id);
  else if (Object.hasOwn(value, "group")) fail("PUBLIC_RESULT_INVALID", "non-terminal managed result must not include a provider group");
  return value;
}
function assertWorkflowHubV2Group(value, expectedRuntimeId = null, expectedMaterialId = null) {
  exactKeys(value, workflowHubV2GroupFields, "managed terminal group");
  if (value.version !== 4 || !workflowHubV2Outcomes.has(value.outcome) || typeof value.runtime_id !== "string" || !Number.isSafeInteger(value.round) || value.round < 0 || typeof value.host_provider !== "string" || !(value.selected_tier === null || (Number.isSafeInteger(value.selected_tier) && value.selected_tier >= 0)) || !Array.isArray(value.providers) || value.providers.length === 0) {
    fail("PUBLIC_RESULT_INVALID", "managed terminal result has invalid workflowhub-result.v2 group facts");
  }
  if (expectedRuntimeId !== null && value.runtime_id !== expectedRuntimeId) fail("PUBLIC_RESULT_INVALID", "managed terminal group runtime does not match its operation");
  value.providers.forEach((provider) => {
    assertWorkflowHubV2ProviderSchema(provider);
    if (expectedRuntimeId !== null && provider.runtime_id !== expectedRuntimeId) fail("PUBLIC_RESULT_INVALID", "managed terminal provider runtime does not match its operation");
    if (expectedMaterialId !== null && provider.material_id !== expectedMaterialId) fail("PUBLIC_RESULT_INVALID", "managed terminal provider material does not match its operation");
  });
  assertNoPrivatePaths(value, "managed terminal group"); return value;
}
function managedTerminalGroup(value, expectedRuntimeId, expectedMaterialId) {
  const group = structuredClone(value);
  // A managed status is a polling protocol, not a raw transcript lookup.
  // Keep the semantic V2 output while withholding even logical raw-output
  // references so callers never acquire an artifact-discovery side channel.
  group.providers = group.providers.map((provider) => ({ ...provider, raw_output_ref: null, session_file_path: null }));
  return assertWorkflowHubV2Group(group, expectedRuntimeId, expectedMaterialId);
}
function managedFailureProvider(profile, material_id, runtime_id, code, status = "failed") {
  const error = { code, message: code === "CANCELLED" ? "managed review was cancelled" : "managed session manager is unavailable" };
  const result = {
    provider: safeProviderId(profile?.id) ?? "unknown", adapter: safePublicString(profile?.adapter) ?? "unknown", model: safePublicString(profile?.model), effort: safePublicString(profile?.effort), thinking: typeof profile?.thinking === "boolean" ? profile.thinking : null,
    status, result_protocol: WORKFLOWHUB_RESULT_PROTOCOL_V2, material_id: safePublicString(material_id), runtime_id, session_id: null, session_file_path: null, continuable: false,
    timing: { started_at_ms: null, completed_at_ms: Date.now(), duration_ms: null }, usage: null, retry: { count: 0, progress_events: 0 }, raw_output_ref: null,
    unavailable_diagnostics: error, output: null, error,
  };
  assertWorkflowHubV2ProviderSchema(result); return result;
}
function managedFailureGroup(state, operation, code) {
  const providers = operation.providers.map((profile) => managedFailureProvider(profile, operation.material_id, state.runtime_id, code, code === "CANCELLED" ? "cancelled" : "failed"));
  const group = { version: 4, outcome: code === "CANCELLED" ? "cancelled" : "unavailable", runtime_id: state.runtime_id, round: state.round, host_provider: state.host_provider, selected_tier: null, providers };
  return assertWorkflowHubV2Group(group, state.runtime_id, operation.material_id);
}
function managedBinding(input, checked, config) {
  // `source` is only a host-side staging location. WorkflowHub can rebuild an
  // identical sealed packet in a new temporary directory while reconnecting.
  // Bind the provider-visible destinations and exact bytes instead.
  const manifest = {
    version: 1,
    bundle_id: checked.bundle_id,
    entries: checked.files.map(({ target: destination, size, sha256, embed }) => ({ destination, size, sha256, embed })),
  };
  const requestValue = structuredClone(input); requestValue.attachments = { delivery: checked.requested_delivery, manifest };
  const route = input.provider_allowlist.map((id) => {
    const provider = config.providers[id]; return { id, adapter: provider.adapter, enabled: provider.enabled, model: provider.model, effort: provider.effort, thinking: provider.thinking };
  });
  return createHash("sha256").update(canonicalJson({ request: requestValue, material: { bundle_id: checked.bundle_id, manifest_hash: checked.manifest_hash, material_id: checked.material_id, delivery: checked.requested_delivery, files: checked.files }, route }), "utf8").digest("hex");
}
function publicInvalidError() { return { code: "PUBLIC_RESULT_INVALID", message: "provider result omitted because it contained a private absolute path" }; }
function safePublicString(value, fallback = null) { return typeof value === "string" && !containsPrivatePath(value) ? value : fallback; }
function safeProviderId(value) { return parseProviderId(value)?.id ?? null; }
function publicInvalidV1Result(value, checked) {
  return {
    provider: safeProviderId(value.provider),
    status: "failed",
    result_protocol: WORKFLOWHUB_RESULT_PROTOCOL_V1,
    material_id: safePublicString(checked?.material_id),
    session_id: null,
    output: null,
    error: publicInvalidError(),
  };
}
function exactKeys(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isDeepStrictEqual(Object.keys(value).sort(), fields)) {
    fail("PUBLIC_RESULT_INVALID", `${label} does not match the workflowhub-result.v2 public schema`);
  }
}
function assertNoPrivatePaths(value, label = "result") {
  if (typeof value === "string") {
    if (containsPrivatePath(value)) fail("PUBLIC_RESULT_INVALID", `${label} contains a private absolute path`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoPrivatePaths(item, `${label}[${index}]`)); return; }
  for (const [key, child] of Object.entries(value)) assertNoPrivatePaths(child, `${label}.${key}`);
}
export function publicV2Error(value) {
  const code = typeof value?.code === "string" && value.code.length > 0 ? value.code : "RESULT_UNAVAILABLE";
  const message = typeof value?.message === "string" && value.message.trim().length > 0
    ? value.message
    : "provider error message is unavailable";
  // Spawn and adapter errors can carry a host path. Preserve the stable code,
  // but never export that path through the public protocol.
  return containsPrivatePath(message) ? { code, message: "provider error message omitted because it contained a private absolute path" } : { code, message };
}
function assertPublicV2Diagnostic(value, label) {
  exactKeys(value, workflowHubV2DiagnosticFields, label);
  if (typeof value.code !== "string" || value.code.trim().length === 0 || typeof value.message !== "string" || value.message.trim().length === 0) {
    fail("PUBLIC_RESULT_INVALID", `${label} must contain non-empty public code and message strings`);
  }
}
function assertWorkflowHubV2ProviderSchema(value) {
  exactKeys(value, workflowHubV2ProviderFields, "provider result");
  if (value.result_protocol !== WORKFLOWHUB_RESULT_PROTOCOL_V2 || typeof value.provider !== "string" || typeof value.adapter !== "string" || typeof value.runtime_id !== "string" || typeof value.continuable !== "boolean" || value.session_file_path !== null) {
    fail("PUBLIC_RESULT_INVALID", "provider result has invalid required workflowhub-result.v2 facts");
  }
  exactKeys(value.timing, workflowHubV2TimingFields, "provider timing");
  exactKeys(value.retry, workflowHubV2RetryFields, "provider retry");
  if (![value.timing.started_at_ms, value.timing.completed_at_ms, value.timing.duration_ms].every((item) => item === null || (Number.isSafeInteger(item) && item >= 0)) || ![value.retry.count, value.retry.progress_events].every((item) => Number.isSafeInteger(item) && item >= 0)) {
    fail("PUBLIC_RESULT_INVALID", "provider result has invalid timing or retry facts");
  }
  if (value.raw_output_ref !== null) exactKeys(value.raw_output_ref, workflowHubV2OutputRefFields, "provider raw output reference");
  if (!["completed", "failed", "cancelled"].includes(value.status)) fail("PUBLIC_RESULT_INVALID", "provider result has an invalid status");
  if (value.unavailable_diagnostics !== null) assertPublicV2Diagnostic(value.unavailable_diagnostics, "provider unavailable diagnostics");
  if (value.error !== null) assertPublicV2Diagnostic(value.error, "provider error");
  if (value.status === "completed" && (value.unavailable_diagnostics !== null || value.error !== null)) {
    fail("PUBLIC_RESULT_INVALID", "completed provider result must not contain public error diagnostics");
  }
  if (value.status !== "completed") {
    if (value.unavailable_diagnostics === null || value.error === null) {
      fail("PUBLIC_RESULT_INVALID", "non-completed provider result requires public error diagnostics");
    }
    if (value.unavailable_diagnostics.code !== value.error.code || value.unavailable_diagnostics.message !== value.error.message) {
      fail("PUBLIC_RESULT_INVALID", "non-completed provider diagnostics must match the public error");
    }
  }
  assertNoPrivatePaths(value);
}
function publicOutputRef(value, runtime_id, provider) {
  if (!value?.raw_stdout_sha256 && !value?.raw_stderr_sha256) return null;
  return {
    version: "broker-output-ref.v1",
    runtime_id,
    provider: provider ?? null,
    stdout_sha256: value.raw_stdout_sha256 ?? null,
    stderr_sha256: value.raw_stderr_sha256 ?? null,
  };
}
function workflowHubResultV2(value, checked, profile, runtime_id, persisted = null) {
  const facts = persisted ?? value;
  const provider = value.provider ?? profile?.id ?? null;
  const status = value.status === "skipped" ? "failed" : value.status;
  const sourceError = value.error ?? facts.error ?? null;
  const error = status === "completed" && sourceError === null ? null : publicV2Error(sourceError);
  const result = {
    provider,
    adapter: profile?.adapter ?? adapterForProviderId(provider),
    model: profile?.model ?? null,
    effort: profile?.effort ?? null,
    thinking: profile?.thinking ?? null,
    status,
    result_protocol: WORKFLOWHUB_RESULT_PROTOCOL_V2,
    material_id: checked?.material_id,
    runtime_id,
    session_id: value.session_id ?? facts.session_id ?? null,
    session_file_path: null,
    continuable: hasSession(value) || hasSession(facts),
    timing: {
      started_at_ms: integerOrNull(facts.started_at_ms),
      completed_at_ms: integerOrNull(facts.completed_at_ms),
      duration_ms: integerOrNull(value.duration_ms ?? facts.duration_ms),
    },
    usage: value.usage ?? facts.usage ?? null,
    retry: {
      count: integerOrNull(value.retry_count ?? facts.retry_count) ?? 0,
      progress_events: integerOrNull(value.progress_events ?? facts.progress_events) ?? 0,
    },
    raw_output_ref: publicOutputRef(value, runtime_id, provider),
    unavailable_diagnostics: status === "completed" ? null : { code: error.code, message: error.message },
    output: value.output ?? null,
    error,
  };
  assertWorkflowHubV2ProviderSchema(result);
  return result;
}
function publicInvalidV2Result(value, checked, providerId, runtime_id, persisted = null) {
  const facts = persisted ?? value;
  const provider = safeProviderId(providerId) ?? safeProviderId(value.provider) ?? "unknown";
  const result = {
    provider,
    adapter: adapterForProviderId(provider) ?? "unknown",
    model: null,
    effort: null,
    thinking: null,
    status: "failed",
    result_protocol: WORKFLOWHUB_RESULT_PROTOCOL_V2,
    material_id: safePublicString(checked?.material_id),
    runtime_id: safePublicString(runtime_id, "invalid-runtime"),
    session_id: null,
    session_file_path: null,
    continuable: false,
    timing: {
      started_at_ms: integerOrNull(facts?.started_at_ms),
      completed_at_ms: integerOrNull(facts?.completed_at_ms),
      duration_ms: integerOrNull(value?.duration_ms ?? facts?.duration_ms),
    },
    usage: null,
    retry: {
      count: integerOrNull(value?.retry_count ?? facts?.retry_count) ?? 0,
      progress_events: integerOrNull(value?.progress_events ?? facts?.progress_events) ?? 0,
    },
    raw_output_ref: null,
    unavailable_diagnostics: publicInvalidError(),
    output: null,
    error: publicInvalidError(),
  };
  assertWorkflowHubV2ProviderSchema(result);
  return result;
}
function workflowHubResult(protocol, value, checked, profile, runtime_id, persisted = null) {
  if (protocol === WORKFLOWHUB_RESULT_PROTOCOL_V1) return workflowHubResultV1(value, checked);
  return workflowHubResultV2(value, checked, profile, runtime_id, persisted);
}
function projectWorkflowHubResult(protocol, value, checked, profile, runtime_id, persisted = null, providerId = null) {
  try { return workflowHubResult(protocol, value, checked, profile, runtime_id, persisted); }
  catch (error) {
    if (error?.code !== "PUBLIC_RESULT_INVALID") throw error;
    return protocol === WORKFLOWHUB_RESULT_PROTOCOL_V1
      ? publicInvalidV1Result(value, checked)
      : publicInvalidV2Result(value, checked, providerId, runtime_id, persisted);
  }
}
function sourceAdapter(value, config) { return config.providers[value]?.adapter ?? adapterForProviderId(value); }
function sameSource(left, right, config) { return sourceAdapter(left, config) === sourceAdapter(right, config); }
function workflowHubV2GroupEntries(providerIds, host, config, selected = null) {
  const selectedAdapters = new Set();
  return providerIds.map((id) => {
    if (sameSource(id, host, config)) return { id, tier: null, skip: "SAME_SOURCE", skip_message: "host provider cannot review itself" };
    const providerAdapter = sourceAdapter(id, config);
    if (selectedAdapters.has(providerAdapter)) return { id, tier: null, skip: "SAME_SOURCE", skip_message: "an earlier candidate already uses this adapter" };
    selectedAdapters.add(providerAdapter);
    if (selected && !selected.includes(id)) return { id, tier: null, unavailable: "NO_CONTINUABLE_SESSION" };
    return { id, tier: null, ...(selected ? { continuation: true } : {}) };
  });
}
function request(value, config) {
  if (!value || value.version !== 4 || typeof value.prompt !== "string" || value.prompt.length === 0 || !sourceAdapter(value.host_provider, config)) fail("REQUEST_INVALID", "request needs version:4, a non-empty prompt, and a supported host_provider");
  if (value.required_result_protocol !== undefined && !isWorkflowHubResultProtocol(value.required_result_protocol)) fail("PROTOCOL_INCOMPATIBLE", "required result protocol is not supported");
  if (isWorkflowHubResultProtocol(value.required_result_protocol) && !value.attachments) fail("REQUEST_INVALID", "workflowhub result protocols require complete attachments on every round");
  if (value.required_result_protocol === WORKFLOWHUB_RESULT_PROTOCOL_V2 && (!Array.isArray(value.provider_allowlist) || value.provider_allowlist.length === 0)) fail("REQUEST_INVALID", "workflowhub-result.v2 requires a non-empty configured provider_allowlist candidate group");
  if (value.continuation !== null && value.continuation !== undefined && (typeof value.continuation !== "object" || typeof value.continuation.runtime_id !== "string")) fail("REQUEST_INVALID", "continuation must be null or contain runtime_id");
  if (value.provider_allowlist !== undefined) {
    if (!Array.isArray(value.provider_allowlist) || value.provider_allowlist.length === 0 || value.provider_allowlist.some((provider) => !config.providers[provider]) || new Set(value.provider_allowlist).size !== value.provider_allowlist.length) fail("REQUEST_INVALID", "provider_allowlist must contain unique configured providers");
    if (value.required_result_protocol !== WORKFLOWHUB_RESULT_PROTOCOL_V2 && value.provider_allowlist.some((provider) => sameSource(provider, value.host_provider, config))) fail("REQUEST_INVALID", "provider_allowlist must contain unique configured heterologous providers");
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
        try { probeAttachmentWorkspace(this.config.runtime.root, provider.id, Infinity); attachmentProbe.set(provider.id, true); }
        catch { attachmentProbe.set(provider.id, false); }
      }
      if ([...attachmentProbe.values()].some((ready) => !ready)) attachmentRootStatus = { status: "unavailable", error: { code: "ATTACHMENT_PROBE_FAILED" } };
    }
    const orderedProviderIds = [...new Set(this.config.tiers.flat())];
    const output = await Promise.all(orderedProviderIds.map(async (id) => { const provider = this.config.providers[id];
      const capabilities = adapter(provider.adapter).capabilities;
      const probeFailed = attachmentProbe.get(provider.id) === false;
      const readyCapabilities = probeFailed ? { ...capabilities, attachment_delivery: [] } : capabilities;
      if (!provider.enabled) return { provider: provider.id, status: "disabled", capabilities: readyCapabilities };
      const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
      if (missing.length) return { provider: provider.id, status: "unavailable", capabilities: readyCapabilities, error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } };
      if (probeFailed) return { provider: provider.id, status: "unavailable", capabilities: readyCapabilities, error: { code: "ATTACHMENT_PROBE_FAILED", message: "attachment workspace probe failed" } };
      const work = fs.mkdtempSync(path.join(this.config.runtime.root, "doctor-"));
      try { const result = await execute(adapter(provider.adapter).doctor(provider, work), { maxOutputBytes: 65536 }); return result.ok ? { provider: provider.id, status: "ready", verification: "executable_only", capabilities: readyCapabilities } : { provider: provider.id, status: "unavailable", capabilities: readyCapabilities, error: result.error }; }
      finally { fs.rmSync(work, { recursive: true, force: true }); }
    }));
    const attachmentVerification = attachmentRoot ? "workspace_copy_only" : "unverified";
    return { version: 4, material_protocol: MATERIAL_PROTOCOL, result_protocols: [...WORKFLOWHUB_RESULT_PROTOCOLS], capabilities: { attachments: attachmentRootStatus.status !== "unavailable", cancel_source: true }, attachment_root: attachmentRootStatus, verification: attachmentVerification, note: "doctor does not verify model authentication or a real review", providers: output };
  }

  #attachmentRootStatus(attachmentRoot) {
    if (this.config.attachment_roots.length === 0) return { status: "unavailable", error: { code: "ATTACHMENT_ROOT_UNCONFIGURED" } };
    if (!attachmentRoot) return { status: "unverified" };
    try { validateAttachmentRoot(attachmentRoot, this.config.attachment_roots); return { status: "ready" }; }
    catch (error) { return { status: "unavailable", error: { code: publicError(error).code } }; }
  }

  status(runtime_id) { cleanup(this.config.runtime.root, this.config.runtime.ttl_hours); return projectStatus(readRuntime(this.config.runtime.root, runtime_id)); }

  startManaged(raw, request_id) {
    const input = request(raw, this.config); const requestId = opaqueRequestId(request_id);
    if (input.required_result_protocol !== WORKFLOWHUB_RESULT_PROTOCOL_V2) fail("PROTOCOL_INCOMPATIBLE", "managed sessions require workflowhub-result.v2");
    const checked = validateAttachments(input.attachments, this.config.runtime.max_attachment_bytes, this.config.attachment_roots);
    const binding_sha256 = managedBinding(input, checked, this.config); const bindingPath = managedRequestPath(this.config.runtime.root, requestId);
    if (fs.existsSync(bindingPath)) {
      const binding = readPrivateJson(bindingPath, "REQUEST_ID_CONFLICT", "request_id binding is unavailable");
      if (binding.request_id !== requestId || binding.binding_sha256 !== binding_sha256) fail("REQUEST_ID_CONFLICT", "request_id is already bound to a different immutable review request");
      return this.managedStatus(binding.runtime_id, binding.operation_id);
    }
    const continuing = input.continuation?.runtime_id; const createdRuntime = !continuing;
    let state = continuing ? readRuntime(this.config.runtime.root, continuing) : createRuntime(this.config.runtime.root, this.config.runtime.ttl_hours, input.host_provider, this.config.runtime.orphan_timeout_ms);
    if (state.host_provider !== input.host_provider) fail("HOST_MISMATCH", "continuation host_provider must match its first round");
    if (continuing && (!state.managed || state.managed.version !== 1)) fail("RUNTIME_INVALID", "managed continuation requires a managed runtime");
    const operation_id = randomUUID(); const runtime = runtimeDirectory(this.config.runtime.root, state.runtime_id);
    const frozen = freezeManagedAttachments(checked, runtime, operation_id);
    const privateRequest = structuredClone(input); privateRequest.attachments = frozen;
    const config_snapshot = structuredClone(this.config);
    config_snapshot.attachment_roots = [...config_snapshot.attachment_roots, { root: frozen.root, sources: frozen.manifest.entries.map((entry) => entry.source) }];
    const providers = input.provider_allowlist.map((id) => {
      const profile = this.config.providers[id]; return { id, adapter: profile.adapter, model: profile.model, effort: profile.effort, thinking: profile.thinking };
    });
    const operation = { version: 1, operation_id, request_id: requestId, binding_sha256, material_id: checked.material_id, state: "starting", providers, cancel_requested: false, manager: null, group: null, created_at_ms: Date.now() };
    let existingOperation = null;
    try {
      state = updateRuntime(this.config.runtime.root, state.runtime_id, (next) => {
        const active = next.managed?.operations?.find((item) => item.state !== "terminal");
        if (active) {
          if (active.request_id === requestId && active.binding_sha256 === binding_sha256) { existingOperation = active; return next; }
          if (active.request_id === requestId) fail("REQUEST_ID_CONFLICT", "request_id is already bound to a different immutable review request");
          fail("OPERATION_ACTIVE", "a managed operation is already active for this runtime");
        }
        return { ...next, managed: { version: 1, operations: [...(next.managed?.operations ?? []), operation] } };
      });
    } catch (error) {
      discardManagedAttachments(runtime, operation_id); if (createdRuntime) removeRuntimeDirectory(this.config.runtime.root, state.runtime_id); throw error;
    }
    if (existingOperation) { discardManagedAttachments(runtime, operation_id); return this.managedStatus(state.runtime_id, existingOperation.operation_id); }
    writePrivateJson(managedJobPath(this.config.runtime.root, state.runtime_id, operation_id), { version: 1, runtime_id: state.runtime_id, operation_id, request: privateRequest, config_snapshot });
    try {
      fs.mkdirSync(path.dirname(bindingPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(bindingPath, `${JSON.stringify({ version: 1, request_id: requestId, binding_sha256, runtime_id: state.runtime_id, operation_id })}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") {
        // A concurrent identical start may have won after this caller froze
        // material but before it claimed the request ID. Nothing has been
        // dispatched yet, so remove only this exact unlaunched operation.
        if (createdRuntime) removeRuntimeDirectory(this.config.runtime.root, state.runtime_id);
        else {
          updateRuntime(this.config.runtime.root, state.runtime_id, (next) => ({ ...next, managed: { ...next.managed, operations: next.managed.operations.filter((item) => item.operation_id !== operation_id) } }));
          discardManagedAttachments(runtime, operation_id); fs.rmSync(managedJobPath(this.config.runtime.root, state.runtime_id, operation_id), { force: true });
        }
        const binding = readPrivateJson(bindingPath, "REQUEST_ID_CONFLICT", "request_id binding is unavailable");
        if (binding.request_id === requestId && binding.binding_sha256 === binding_sha256) return this.managedStatus(binding.runtime_id, binding.operation_id);
        fail("REQUEST_ID_CONFLICT", "request_id is already bound to a different immutable review request");
      }
      throw error;
    }
    let manager;
    try { manager = spawn(process.execPath, [managedManagerProgram, this.config.runtime.root, state.runtime_id, operation_id], { detached: true, stdio: "ignore" }); }
    catch { manager = null; }
    const managerIdentity = manager ? processIdentity(manager.pid) : null;
    let latest = readRuntime(this.config.runtime.root, state.runtime_id); let latestOperation = latest.managed.operations.find((item) => item.operation_id === operation_id);
    if (latestOperation?.state === "terminal") {
      manager?.unref();
      const snapshot = assertManagedPublic(managedPublic(latestOperation, latest.runtime_id)); writePrivateJson(managedPublicPath(this.config.runtime.root, latest.runtime_id), snapshot); return snapshot;
    }
    if (!managerIdentity) {
      if (manager?.pid) terminateProcessTree(manager.pid, "SIGTERM");
      const group = managedFailureGroup(latest, latestOperation, "SESSION_MANAGER_LOST");
      state = updateRuntime(this.config.runtime.root, latest.runtime_id, (next) => ({ ...next, managed: { ...next.managed, operations: next.managed.operations.map((item) => item.operation_id === operation_id && item.state !== "terminal" ? { ...item, state: "terminal", group, completed_at_ms: Date.now() } : item) } }));
    } else {
      manager.unref(); state = updateRuntime(this.config.runtime.root, latest.runtime_id, (next) => ({ ...next, managed: { ...next.managed, operations: next.managed.operations.map((item) => item.operation_id === operation_id && item.state !== "terminal" ? { ...item, manager: managerIdentity } : item) } }));
    }
    const published = state.managed.operations.find((item) => item.operation_id === operation_id); const snapshot = assertManagedPublic(managedPublic(published, state.runtime_id)); writePrivateJson(managedPublicPath(this.config.runtime.root, state.runtime_id), snapshot); return snapshot;
  }

  managedStatus(runtime_id, operation_id = null) {
    const state = readRuntime(this.config.runtime.root, runtime_id); const operations = state.managed?.operations;
    if (!Array.isArray(operations) || operations.length === 0) fail("RUNTIME_NOT_MANAGED", "runtime is not a managed session");
    const operation = operation_id ? operations.find((item) => item.operation_id === operation_id) : operations.at(-1);
    if (!operation) fail("RUNTIME_INVALID", "managed operation is unavailable");
    if (operation.state !== "terminal" && operation.manager && ownerConfirmedDead(operation.manager)) {
      const group = managedFailureGroup(state, operation, operation.cancel_requested ? "CANCELLED" : "SESSION_MANAGER_LOST");
      const updated = updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, managed: { ...next.managed, operations: next.managed.operations.map((item) => item.operation_id === operation.operation_id && item.state !== "terminal" ? { ...item, state: "terminal", group, completed_at_ms: Date.now() } : item) } }));
      const terminal = updated.managed.operations.find((item) => item.operation_id === operation.operation_id); const snapshot = assertManagedPublic(managedPublic(terminal, runtime_id)); writePrivateJson(managedPublicPath(this.config.runtime.root, runtime_id), snapshot); return snapshot;
    }
    return assertManagedPublic(managedPublic(operation, runtime_id));
  }

  cancelManaged(runtime_id) {
    const state = readRuntime(this.config.runtime.root, runtime_id); const operation = state.managed?.operations?.at(-1);
    if (!operation) fail("RUNTIME_NOT_MANAGED", "runtime is not a managed session");
    if (operation.state === "terminal") {
      if (operation.group?.providers?.some((item) => item.error?.code === "SESSION_MANAGER_LOST")) {
        for (const [provider, item] of Object.entries(state.providers ?? {})) if (item.status === "running" && workerIdentityMatches(item.worker)) this.cancel(runtime_id, provider, "user", { managed: true });
        const group = managedFailureGroup(state, operation, "CANCELLED");
        const updated = updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, managed: { ...next.managed, operations: next.managed.operations.map((item) => item.operation_id === operation.operation_id ? { ...item, group } : item) } }));
        const terminal = updated.managed.operations.find((item) => item.operation_id === operation.operation_id); const snapshot = assertManagedPublic(managedPublic(terminal, runtime_id)); writePrivateJson(managedPublicPath(this.config.runtime.root, runtime_id), snapshot); return snapshot;
      }
      return this.managedStatus(runtime_id, operation.operation_id);
    }
    const updated = updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, managed: { ...next.managed, operations: next.managed.operations.map((item) => item.operation_id === operation.operation_id ? { ...item, cancel_requested: true } : item) } }));
    for (const profile of operation.providers) requestCancellation(this.config.runtime.root, runtime_id, profile.id, "user");
    for (const [provider, item] of Object.entries(updated.providers ?? {})) if (item.status === "running" && workerIdentityMatches(item.worker)) this.cancel(runtime_id, provider, "user", { managed: true });
    return this.managedStatus(runtime_id, operation.operation_id);
  }

  async runManagedOperation(runtime_id, operation_id, job) {
    const state = readRuntime(this.config.runtime.root, runtime_id); const operation = state.managed?.operations?.find((item) => item.operation_id === operation_id);
    if (!operation) fail("RUNTIME_INVALID", "managed operation is unavailable");
    if (operation.state === "terminal") return operation.group;
    const manager = { ...currentOwnerIdentity(), started_at_ms: Date.now() };
    updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, owner: manager, managed: { ...next.managed, operations: next.managed.operations.map((item) => item.operation_id === operation_id ? { ...item, state: "running", manager } : item) } }));
    const current = readRuntime(this.config.runtime.root, runtime_id).managed.operations.find((item) => item.operation_id === operation_id);
    let group;
    try {
      if (current.cancel_requested) group = managedFailureGroup(readRuntime(this.config.runtime.root, runtime_id), current, "CANCELLED");
      else group = await this.run(job.request, { managed_runtime_id: runtime_id });
    } catch { group = managedFailureGroup(readRuntime(this.config.runtime.root, runtime_id), current, "SESSION_MANAGER_LOST"); }
    group = managedTerminalGroup(group, runtime_id, current.material_id);
    const completed = updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, managed: { ...next.managed, operations: next.managed.operations.map((item) => item.operation_id === operation_id ? { ...item, state: "terminal", group, completed_at_ms: Date.now() } : item) } }));
    const terminal = completed.managed.operations.find((item) => item.operation_id === operation_id); const snapshot = assertManagedPublic(managedPublic(terminal, runtime_id)); writePrivateJson(managedPublicPath(this.config.runtime.root, runtime_id), snapshot); return group;
  }

  shutdown() {
    this.shuttingDown = true;
    const cancelled = [];
    for (const { runtime_id, provider, pid } of this.active.values()) {
      requestCancellation(this.config.runtime.root, runtime_id, provider, "workflow_shutdown");
      if (terminateProcessTree(pid, "SIGTERM")) cancelled.push({ runtime_id, provider });
    }
    return cancelled;
  }

  cancel(runtime_id, provider, source = "user", { managed = false } = {}) {
    const exposeSource = arguments.length >= 3;
    const state = readRuntime(this.config.runtime.root, runtime_id); const item = state.providers?.[provider];
    if (!managed && state.managed?.version === 1) fail("MANAGED_CANCEL_REQUIRED", "managed runtimes may be cancelled only without --provider");
    if (!item || item.status !== "running" || !workerIdentityMatches(item.worker)) return { cancelled: false, reason: "NOT_ACTIVE" };
    // Keep cancellation separate from heartbeat state, so another broker
    // process cannot erase this intent with a read-modify-write race.
    requestCancellation(this.config.runtime.root, runtime_id, provider, source);
    const cancelled = terminateProcessTree(item.pid, "SIGTERM");
    if (cancelled) setTimeout(() => { terminateProcessTree(item.pid, "SIGKILL"); }, 5_000).unref();
    return { cancelled, ...(exposeSource ? { source } : {}) };
  }

  async run(raw, { managed_runtime_id = null } = {}) {
    const input = request(raw, this.config);
    const continuing = input.continuation?.runtime_id; const reuseFrozenMaterial = input.continuation?.reuse_frozen_material === true;
    let state = continuing ? readRuntime(this.config.runtime.root, continuing) : null;
    if (continuing && state.attachments && state.attachments.protocol_version !== MATERIAL_PROTOCOL_VERSION) fail("MATERIAL_PROTOCOL_MISMATCH", "attachment runtime uses an incompatible material protocol");
    const initialChecked = !continuing && input.attachments ? validateAttachments(input.attachments, this.config.runtime.max_attachment_bytes, this.config.attachment_roots) : null;
    if (initialChecked && !isWorkflowHubResultProtocol(input.required_result_protocol)) validateFileOnlyTriad(initialChecked);
    let deliveryChecked = initialChecked;
    state ??= managed_runtime_id ? readRuntime(this.config.runtime.root, managed_runtime_id) : createRuntime(this.config.runtime.root, this.config.runtime.ttl_hours, input.host_provider, this.config.runtime.orphan_timeout_ms);
    if (managed_runtime_id && continuing && continuing !== managed_runtime_id) fail("RUNTIME_INVALID", "managed continuation runtime does not match its operation runtime");
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
        const checked = validateAttachments(input.attachments, this.config.runtime.max_attachment_bytes, this.config.attachment_roots);
        const binding = isWorkflowHubResultProtocol(input.required_result_protocol)
          ? { sequence: (state.continuation_materials ?? []).length + 1, delivery_manifest_hash: canonicalDeliveryManifestHash(checked.bundle_id, checked.files, checked.requested_delivery) }
          : validateContinuationTriad(checked, state);
        deliveryChecked = checked;
        const previous = state.continuation_materials ?? [];
        continuationMaterial = { sequence: binding.sequence, workspace_round: state.round + 1, bundle_id: checked.bundle_id, manifest_hash: checked.manifest_hash, material_id: checked.material_id, delivery_manifest_hash: binding.delivery_manifest_hash, initial_material_manifest_hash: state.attachments.manifest_hash,
          previous_delivery_manifest_hash: previous.length ? previous.at(-1).delivery_manifest_hash : null };
      }
    } else if (input.attachments) {
      const checked = initialChecked;
      state = updateRuntime(this.config.runtime.root, state.runtime_id, (next) => ({ ...next, attachments: { protocol_version: MATERIAL_PROTOCOL_VERSION, requested_delivery: checked.requested_delivery, bundle_id: checked.bundle_id, manifest_hash: checked.manifest_hash, files: checked.files } }));
    }
    const allowlist = input.provider_allowlist ? new Set(input.provider_allowlist) : null;
    const selected = continuing ? Object.keys(state.providers).filter((id) => !sameSource(id, input.host_provider, this.config) && (!allowlist || allowlist.has(id)) && continuationEligible(state.providers[id], continuationMaterial) && hasSession(state.providers[id]) && (!continuationMaterial || providerHasContinuationPredecessor(state, id, state.providers[id].session_id, continuationMaterial.sequence))) : null;
    const entries = continuing
      ? input.required_result_protocol === WORKFLOWHUB_RESULT_PROTOCOL_V2
        ? workflowHubV2GroupEntries(input.provider_allowlist, input.host_provider, this.config, selected)
        : selected.map((id) => ({ id, tier: null, continuation: true }))
      : this.#route(input.host_provider, allowlist, input.required_result_protocol);
    const output = []; if (continuing && entries.length === 0) { const unavailableProvider = input.required_result_protocol === WORKFLOWHUB_RESULT_PROTOCOL_V2 ? input.provider_allowlist[0] : input.required_result_protocol === WORKFLOWHUB_RESULT_PROTOCOL_V1 && input.provider_allowlist?.length === 1 ? input.provider_allowlist[0] : null; const result = { provider: unavailableProvider, status: "failed", error: { code: "NO_CONTINUABLE_SESSION", message: "no successful provider session is available" } }; return this.#finish(state.runtime_id, input, [isWorkflowHubResultProtocol(input.required_result_protocol) ? projectWorkflowHubResult(input.required_result_protocol, result, deliveryChecked, this.config.providers[unavailableProvider], state.runtime_id, null, unavailableProvider) : result], null); }
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

  #route(host, allowlist = null, protocol = null) {
    // WorkflowHub v2 sends an explicit candidate group. Retain caller order,
    // but execute at most one profile per CLI adapter. A same-host candidate
    // and each later duplicate adapter remain public SAME_SOURCE results.
    if (protocol === WORKFLOWHUB_RESULT_PROTOCOL_V2 && allowlist) return [workflowHubV2GroupEntries([...allowlist], host, this.config)];
    return this.config.tiers.map((tier, index) => {
      const entries = tier.filter((id) => !allowlist || allowlist.has(id)).map((id) => sameSource(id, host, this.config) ? { id, tier: index, skip: "SAME_SOURCE" } : { id, tier: index });
      return allowlist ? entries : entries.filter((entry) => !entry.skip).slice(0, 1);
    });
  }
  async #runProvider(runtime_id, input, entry, continuationMaterial, deliveryChecked) {
    const profile = this.config.providers[entry.id] ?? null;
    const project = (value) => {
      if (!isWorkflowHubResultProtocol(input.required_result_protocol)) return value;
      const persisted = value.provider ? readRuntime(this.config.runtime.root, runtime_id).providers?.[value.provider] ?? null : null;
      return projectWorkflowHubResult(input.required_result_protocol, value, deliveryChecked, profile, runtime_id, persisted, entry.id);
    };
    if (cancellationRequested(this.config.runtime.root, runtime_id, entry.id)) {
      const source = cancellationSource(this.config.runtime.root, runtime_id, entry.id);
      return project({ provider: entry.id, tier: entry.tier, status: "cancelled", cancellation_source: source, error: { code: "CANCELLED", message: "cancel was requested before provider dispatch", source } });
    }
    if (this.shuttingDown) return project({ provider: entry.id, tier: entry.tier, status: "cancelled", cancellation_source: "workflow_shutdown", error: { code: "CANCELLED", message: "broker is shutting down", source: "workflow_shutdown" } });
    if (entry.skip) return project({ provider: entry.id, tier: entry.tier, status: "skipped", error: { code: entry.skip, message: entry.skip_message ?? "host provider cannot review itself" } });
    if (entry.unavailable) return project({ provider: entry.id, tier: entry.tier, status: "failed", error: { code: entry.unavailable, message: "no successful provider session is available" } });
    const provider = this.config.providers[entry.id];
    if (!provider) return project({ provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_NOT_CONFIGURED", message: "provider is absent from the current config" } });
    if (!provider.enabled) return project({ provider: entry.id, tier: entry.tier, status: "skipped", error: { code: "PROVIDER_DISABLED", message: "disabled in config" } });
    const missing = provider.auth.type === "env" ? provider.auth.env.filter((name) => !process.env[name]) : [];
    if (missing.length) return project({ provider: entry.id, tier: entry.tier, status: "failed", error: { code: "AUTH_ENV_MISSING", message: missing.join(", ") } });
    const claim = claimProvider(this.config.runtime.root, runtime_id, entry.id, this.config.runtime.orphan_timeout_ms);
    if (!claim) return project({ provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_BUSY", message: "provider is claimed by another broker" } });
    try { return project(await this.#runClaimedProvider(runtime_id, input, entry, provider, continuationMaterial, deliveryChecked)); }
    finally { releaseProviderClaim(claim); }
  }
  async #runClaimedProvider(runtime_id, input, entry, provider, continuationMaterial, deliveryChecked) {
    const prompt = input.prompt;
    const state = readRuntime(this.config.runtime.root, runtime_id); const prior = state.providers[entry.id]; if (prior?.status === "running" && workerIdentityMatches(prior.worker)) return { provider: entry.id, tier: entry.tier, status: "failed", error: { code: "PROVIDER_BUSY", message: "provider has an active process" } };
    const runtime = runtimeDirectory(this.config.runtime.root, runtime_id); const worker = adapter(provider.adapter); let cwd; let providerPrompt = renderProviderPrompt(worker, prompt); let deliveryUsed = prior?.delivery_used ?? null; let delivery = prior?.delivery ?? null; let attachmentKey = entry.id; let attachmentStored = null;
    try {
      if (input.attachments) {
        // Decide delivery before a provider workspace or prompt is rendered.
        // file_only never materializes the packet into a request string.
        if (!deliveryChecked) fail("MATERIAL_INCOMPLETE", "validated sealed material is unavailable");
        const checked = deliveryChecked;
        attachmentKey = entry.continuation ? `${entry.id}-delta-${state.round + 1}` : entry.id;
        deliveryUsed = input.attachments.delivery;
        if (deliveryUsed === "file_only" && !isWorkflowHubResultProtocol(input.required_result_protocol)) validateFileOnlyTriad(checked);
        const planned = planDelivery(worker, checked, prompt, this.config.runtime.max_prompt_bytes, { requireTriad: !isWorkflowHubResultProtocol(input.required_result_protocol) });
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
        if (deliveryUsed === "always_embed") { cwd = path.join(runtime, "embed", provider.runtime_key); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); }
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
        if (deliveryUsed === "always_embed") { cwd = path.join(runtime, "embed", provider.runtime_key); if (!fs.existsSync(cwd)) fail("ATTACHMENT_IMMUTABLE", "embedded provider workspace is unavailable"); }
        else cwd = frozen.cwd;
      } else { cwd = path.join(runtime, "workspace", provider.runtime_key); fs.mkdirSync(path.join(cwd, "skills"), { recursive: true, mode: 0o700 }); }
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
    const rawCapture = this.#openRawCapture(runtime, provider.runtime_key);
    const parseOutput = (stdout, stderr) => plan.parseLive?.() ?? worker.parse(stdout, stderr, plan.expectedSession);
    const result = await execute({ ...plan, onOutput: rawCapture.write, onHealthDiagnostic: (diagnostic) => touch({ last_health_diagnostic: diagnostic }) }, {
      ...this.processOptions,
      maxOutputBytes: this.config.runtime.max_output_bytes,
      acceptSemanticOutputAfterStdinClose: true,
      livenessIntervalMs: this.config.runtime.liveness_interval_ms,
      isCancelled: () => cancellationRequested(this.config.runtime.root, runtime_id, entry.id),
      validateCompleted: (raw) => parseOutput(raw.stdout, raw.stderr).ok,
      onStart: (pid) => { this.processOptions.onStart?.(pid); const current = Date.now(); this.active.set(`${runtime_id}:${entry.id}`, { runtime_id, provider: entry.id, pid }); updateRuntime(this.config.runtime.root, runtime_id, (next) => ({ ...next, owner: { ...currentOwnerIdentity(), started_at_ms: current }, providers: { ...next.providers, [entry.id]: { provider: entry.id, tier: entry.tier, status: "running", pid, worker: processIdentity(pid), started_at_ms: current, process_alive_at_ms: current, last_progress_at_ms: null, session_id: prior?.session_id ?? null, ...(deliveryUsed ? { delivery_used: deliveryUsed } : {}), ...(delivery ? { delivery } : {}) } } })); if (!this.processOptions.managedSession) ensureRuntimeGuardian(this.config.runtime.root, runtime_id); if (this.shuttingDown || cancellationRequested(this.config.runtime.root, runtime_id, entry.id)) { if (this.shuttingDown) requestCancellation(this.config.runtime.root, runtime_id, entry.id, "workflow_shutdown"); terminateProcessTree(pid, "SIGTERM"); } },
      onLiveness: () => touch({ process_alive_at_ms: Date.now() }),
      onProgress: ({ at_ms }) => touch({ last_progress_at_ms: at_ms }),
    });
    this.active.delete(`${runtime_id}:${entry.id}`);
    const { refs: rawRefs, error: rawCaptureError } = rawCapture.finish();
    const cancelled = cancellationRequested(this.config.runtime.root, runtime_id, entry.id);
    const telemetry = { retry_count: result.retry_count, api_empty_response_count: result.retry_count, progress_events: result.progress_events, last_progress_at_ms: result.last_progress_at_ms };
    const deliveryOutcome = deliveryUsed ? { delivery_used: deliveryUsed, ...(delivery ? { delivery } : {}) } : {};
    if (rawCaptureError) return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: { code: "RAW_OUTPUT_WRITE_FAILED", message: "broker could not persist provider raw output" } });
    if (cancelled) { this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id); const source = cancellationSource(this.config.runtime.root, runtime_id, entry.id); const invalidSource = source === INVALID_CANCELLATION_SOURCE; return this.#store(runtime_id, entry, { status: "cancelled", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, cancellation_source: source, error: invalidSource ? { code: "CANCEL_SOURCE_INVALID", message: "cancel marker source is invalid", source } : { code: "CANCELLED", message: `cancel was requested by ${source}`, source } }); }
    if (!result.ok) {
      this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id);
      const timeout_retry = retryableTerminationCodes.has(result.error?.code) && entry.continuation ? { version: 1, ...(continuationMaterial ? { material: continuationMaterial } : { attachment_free: true }) } : null;
      return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: result.error, diagnostic: result.stdout_truncated || result.stderr_truncated ? "provider output summary truncated; inspect private raw output" : short(`${result.stdout}\n${result.stderr}`) }, timeout_retry ? { timeout_retry } : null);
    }
    // The in-memory streams are a bounded diagnostic summary only. Parse a
    // truncated provider result from its sealed raw files, so an oversized
    // JSONL terminal record remains one complete record and cannot be cut at
    // max_output_bytes.
    const captured = result.stdout_truncated || result.stderr_truncated ? rawCapture.read() : null;
    if ((result.stdout_truncated || result.stderr_truncated) && !captured) return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: { code: "RAW_OUTPUT_READ_FAILED", message: "broker could not read provider raw output for parsing" } });
    const parsed = parseOutput(captured?.stdout ?? result.stdout, captured?.stderr ?? result.stderr);
    if (!parsed.ok) { this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id); return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: result.stdin_error ?? parsed.error, diagnostic: result.stdout_truncated || result.stderr_truncated ? "provider output summary truncated; inspect private raw output" : short(`${result.stdout}\n${result.stderr}`) }); }
    if (entry.continuation && (input.attachments || input.continuation?.reuse_frozen_material) && parsed.session_id !== prior.session_id) { this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id); return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: { code: "MATERIAL_INCOMPLETE", message: "continuation provider did not preserve its native session" } }); }
    // The raw transcript remains in the broker-private raw store, but a model
    // response that names a host path is not a valid public review result.
    // Persist it as a failed provider so a single invalid result cannot abort
    // a WorkflowHub v2 candidate group or fabricate a semantic success.
    if (containsPrivatePath(parsed.text)) {
      this.#releaseContinuationReservation(runtime_id, continuationMaterial, entry.id, prior?.session_id);
      return this.#store(runtime_id, entry, { status: "failed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, error: { code: "PUBLIC_RESULT_INVALID", message: "provider output omitted because it contained a private absolute path" } });
    }
    if (entry.continuation && input.attachments) this.#recordContinuationMaterial(runtime_id, continuationMaterial, entry.id, prior.session_id);
    return this.#store(runtime_id, entry, { status: "completed", duration_ms: result.duration_ms, ...telemetry, ...rawRefs, ...deliveryOutcome, session_id: parsed.session_id, usage: parsed.usage, output: parsed.text }, { timeout_retry: undefined });
  }
  #openRawCapture(runtime, provider) {
    const directory = path.join(runtime, "raw", provider); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const suffix = `${Date.now()}-${process.pid}-${process.hrtime.bigint()}`;
    const files = Object.fromEntries(["stdout", "stderr"].map((stream) => {
      const target = path.join(directory, `round-${suffix}.${stream}`);
      return [stream, { target, fd: fs.openSync(target, "wx", 0o600), hash: createHash("sha256") }];
    }));
    let finished = false; let writeError = null;
    return {
      write: ({ stream, chunk }) => {
        const file = files[stream]; if (!file || finished || typeof chunk !== "string" || writeError) return;
        try { fs.writeSync(file.fd, chunk, null, "utf8"); file.hash.update(chunk, "utf8"); }
        catch { writeError = "RAW_OUTPUT_WRITE_FAILED"; }
      },
      finish: () => {
        if (finished) return { refs: {}, error: writeError };
        finished = true; const refs = {};
        for (const [stream, file] of Object.entries(files)) {
          try { fs.closeSync(file.fd); fs.chmodSync(file.target, 0o400); }
          catch { writeError ??= "RAW_OUTPUT_WRITE_FAILED"; }
          refs[`raw_${stream}_ref`] = path.relative(runtime, file.target);
          refs[`raw_${stream}_sha256`] = file.hash.digest("hex");
        }
        return { refs, error: writeError };
      },
      read: () => {
        if (!finished || writeError) return null;
        try { return { stdout: fs.readFileSync(files.stdout.target, "utf8"), stderr: fs.readFileSync(files.stderr.target, "utf8") }; }
        catch { return null; }
      },
    };
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
