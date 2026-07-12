import { createHash, randomBytes, randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 3;
export const RUNTIME_TTL_MS = 24 * 60 * 60 * 1_000;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export class ProtocolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}

function invalid(message, details) {
  return new ProtocolError("REQUEST_INVALID", message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertUnicodeScalars(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw invalid(`${label} contains an unpaired UTF-16 high surrogate`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw invalid(`${label} contains an unpaired UTF-16 low surrogate`);
    }
  }
}

function compareCodePoints(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function canonicalize(value, path = "$") {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertUnicodeScalars(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new ProtocolError("CONFIG_INVALID", `${path} must be a finite non-negative-zero IEEE-754 number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
  if (!isPlainObject(value)) throw new ProtocolError("CONFIG_INVALID", `${path} must be a JSON value`);
  const keys = Object.keys(value).sort(compareCodePoints);
  return `{${keys.map((key) => {
    assertUnicodeScalars(key, `${path} key`);
    return `${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`)}`;
  }).join(",")}}`;
}

export function sha256(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("sha256 accepts only UTF-8 text or bytes");
  }
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalConfigHash(config) {
  if (!isPlainObject(config)) throw new ProtocolError("CONFIG_INVALID", "config must be a JSON object");
  const canonical_json = canonicalize(config);
  return { canonical_json, hash: sha256(Buffer.from(canonical_json, "utf8")) };
}

export function createNonce() {
  return randomBytes(16).toString("base64url");
}

export function createRuntimeId() {
  return randomBytes(16).toString("base64url");
}

export function createRequestId() {
  return randomUUID();
}

function assertOpaqueId(value, label) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw invalid(`${label} must match [A-Za-z0-9_-]{1,128}`);
  return value;
}

export function createMaterial(text) {
  if (typeof text !== "string") throw invalid("material.text must be a string");
  assertUnicodeScalars(text, "material.text");
  const bytes = Buffer.byteLength(text, "utf8");
  return { encoding: "text", text, input_hash: sha256(Buffer.from(text, "utf8")), bytes };
}

function validateMaterial(material, maxInputBytes) {
  if (!isPlainObject(material) || material.encoding !== "text") throw invalid("material.encoding must be text");
  const expected = createMaterial(material.text);
  if (!Number.isSafeInteger(material.bytes) || material.bytes !== expected.bytes) throw invalid("material.bytes does not match strict UTF-8 bytes");
  if (material.input_hash !== expected.input_hash) throw invalid("material.input_hash does not match strict UTF-8 bytes");
  if (expected.bytes > maxInputBytes) {
    throw new ProtocolError("INPUT_TOO_LARGE", `material bytes ${expected.bytes} exceed max_input_bytes ${maxInputBytes}`);
  }
  return expected;
}

function validateHostHint(value) {
  if (!isPlainObject(value)) throw invalid("host_hint must be an object");
  for (const field of ["provider", "backend", "wrapper_hash"]) {
    if (typeof value[field] !== "string" || value[field].length === 0 || Buffer.byteLength(value[field], "utf8") > 512) {
      throw invalid(`host_hint.${field} must be a non-empty string no longer than 512 bytes`);
    }
    assertUnicodeScalars(value[field], `host_hint.${field}`);
  }
  return { provider: value.provider, backend: value.backend, wrapper_hash: value.wrapper_hash };
}

function validatePreviousReceipts(value) {
  if (!isPlainObject(value)) throw invalid("round 2+ previous_receipts must be an object");
  const entries = Object.entries(value);
  if (entries.length === 0) throw invalid("round 2+ previous_receipts must not be empty");
  const normalized = {};
  for (const [provider, receipt] of entries) {
    assertOpaqueId(provider, "previous_receipts provider");
    if (typeof receipt !== "string" || !SHA256.test(receipt)) {
      throw invalid("previous_receipts values must be sha256:<hex>");
    }
    normalized[provider] = receipt;
  }
  return normalized;
}

export function validateRequest(request, { maxInputBytes = 524_288 } = {}) {
  if (!isPlainObject(request)) throw invalid("request must be an object");
  if (request.protocol_version !== PROTOCOL_VERSION) throw invalid(`protocol_version must be ${PROTOCOL_VERSION}`);
  if (typeof request.request_id !== "string" || !UUID_V4.test(request.request_id)) throw invalid("request_id must be a UUIDv4");
  if (request.nonce !== null && request.nonce !== undefined) assertOpaqueId(request.nonce, "nonce");
  if (!Number.isSafeInteger(request.round) || request.round < 1) throw invalid("round must be a positive safe integer");
  if (request.round === 1) {
    if (request.runtime_id !== null) throw invalid("round 1 runtime_id must be null");
    if (request.previous_receipt_hash !== null) throw invalid("round 1 previous_receipt_hash must be null");
    if (request.previous_receipts !== null && request.previous_receipts !== undefined) throw invalid("round 1 previous_receipts must be null");
  } else {
    assertOpaqueId(request.runtime_id, "runtime_id");
    if (request.previous_receipt_hash !== undefined && request.previous_receipt_hash !== null) throw invalid("round 2+ previous_receipt_hash is replaced by previous_receipts");
  }
  if (typeof request.contract_ref !== "string" || !request.contract_ref.startsWith("opaque://") || Buffer.byteLength(request.contract_ref, "utf8") > 512) {
    throw invalid("contract_ref must be an opaque:// string no longer than 512 bytes");
  }
  assertUnicodeScalars(request.contract_ref, "contract_ref");
  if (request.force_tier !== null && (!Number.isSafeInteger(request.force_tier) || request.force_tier < 0)) {
    throw invalid("force_tier must be null or a non-negative safe integer");
  }
  if (!isPlainObject(request.overrides ?? {})) throw invalid("overrides must be an object");
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0) throw new ProtocolError("CONFIG_INVALID", "max_input_bytes must be a non-negative safe integer");
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: request.request_id,
    nonce: request.nonce ?? null,
    runtime_id: request.runtime_id,
    round: request.round,
    host_hint: validateHostHint(request.host_hint),
    material: validateMaterial(request.material, maxInputBytes),
    contract_ref: request.contract_ref,
    previous_receipts: request.round === 1 ? null : validatePreviousReceipts(request.previous_receipts),
    force_tier: request.force_tier,
    overrides: structuredClone(request.overrides ?? {}),
  };
}

export function validateProviderId(value) {
  return assertOpaqueId(value, "provider");
}

export function validateRuntimeId(value) {
  return assertOpaqueId(value, "runtime_id");
}

export function assertPrivateRef(value) {
  if (value !== "raw" && value !== "diagnostic" && value !== "receipt" && value !== "result") throw invalid("ref must be raw, diagnostic, receipt, or result");
  return value;
}

export function receiptHash(receipt) {
  const { canonical_json, hash } = canonicalConfigHash(receipt);
  return { canonical_json, hash };
}
