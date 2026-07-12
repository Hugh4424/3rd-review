import fs from "node:fs";
import path from "node:path";
import { createRuntimeId, ProtocolError, receiptHash, RUNTIME_TTL_MS, sha256, validateProviderId, validateRuntimeId } from "./protocol.mjs";

const JOB_FILE = ".3rd-review-job.json";
const PROVIDER_RECEIPT = ".3rd-review-provider-receipt.json";

function ownerUid() { return typeof process.getuid === "function" ? process.getuid() : null; }
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProtocolError("BINDING_MISMATCH", "private runtime path must be a real directory");
  fs.chmodSync(directory, 0o700);
  return directory;
}
function privateJson(file, absent = null) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new ProtocolError("BINDING_MISMATCH", "private state must be an owner-only real file");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return absent;
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("RUNTIME_UNAVAILABLE", "private state cannot be read", { cause: error.code ?? error.message });
  }
}
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    throw new ProtocolError("RUNTIME_UNAVAILABLE", "private state cannot be persisted", { cause: error.code ?? error.message });
  } finally { try { fs.unlinkSync(temporary); } catch { /* atomically renamed */ } }
}
function ref(runtime_id, provider, name) { return `private://${runtime_id}/${provider}/${name}`; }
function requestKey(request_id) { return sha256(request_id).slice("sha256:".length); }
function canonicalProvider(result, runtime_id, provider, receipt_ref, diagnostic_ref) {
  return {
    id: provider,
    status: result.execution_eligible ? "completed" : "failed",
    execution_eligible: result.execution_eligible === true,
    session_id: result.execution_eligible && typeof result.session_id === "string" ? result.session_id : null,
    runtime_id,
    receipt_ref,
    diagnostic_ref,
    metrics: result.metrics ?? { elapsed_ms: 0, turns: 0, input_bytes: 0, output_bytes: 0, retry_count: 0 },
    error_code: result.execution_eligible ? null : (result.error_code ?? "PROVIDER_PROTOCOL_INCOMPLETE"),
    persisted: result.persisted === true,
  };
}

export class JobStore {
  constructor({ runtimeRoot, now = () => Date.now() } = {}) {
    if (!path.isAbsolute(runtimeRoot ?? "")) throw new TypeError("runtimeRoot must be absolute");
    this.runtimeRoot = privateDirectory(runtimeRoot);
    this.now = now;
    this.indexRoot = privateDirectory(path.join(this.runtimeRoot, ".3rd-review-requests"));
  }

  begin({ request, config_hash, config_snapshot }) {
    const indexFile = path.join(this.indexRoot, `${requestKey(request.request_id)}.json`);
    const indexed = privateJson(indexFile, null);
    if (indexed) {
      if (request.nonce === null) throw new ProtocolError("NONCE_REQUIRED", "existing request_id requires its original nonce");
      if (request.nonce !== indexed.nonce) throw new ProtocolError("REPLAY_DETECTED", "request_id is already bound to a different nonce");
      const job = this.readJob(indexed.runtime_id);
      if (this.now() > job.expires_at_ms) throw new ProtocolError("NONCE_EXPIRED", "terminal request nonce expired; create a new request_id");
      return { existing: true, request: { ...request, nonce: indexed.nonce }, job };
    }
    if (request.round !== 1 || request.runtime_id !== null) throw new ProtocolError("CONTINUATION_FAILED", "new durable jobs must begin at round 1");
    const runtime_id = createRuntimeId();
    const nonce = request.nonce ?? createRuntimeId();
    const now = this.now();
    const job = {
      protocol_version: 3, request_id: request.request_id, nonce, owner_uid: ownerUid(), runtime_id,
      round: 1, config_hash, config_snapshot, material_hash: request.material.input_hash,
      contract_ref: request.contract_ref, created_at_ms: now, expires_at_ms: now + RUNTIME_TTL_MS,
      status: "running", result: null, providers: {},
    };
    privateDirectory(this.runtimePath(runtime_id));
    writeJson(this.jobPath(runtime_id), job);
    writeJson(indexFile, { request_id: request.request_id, nonce, runtime_id });
    return { existing: false, request: { ...request, nonce, runtime_id }, job };
  }

  complete(runtime_id, result) {
    const job = this.readJob(runtime_id);
    const terminal = { ...job, status: "completed", result, expires_at_ms: this.now() + RUNTIME_TTL_MS };
    writeJson(this.jobPath(runtime_id), terminal);
    return terminal;
  }

  commitProvider({ runtime_id, provider, request, config_hash, config_snapshot, profile_hash, result }) {
    validateRuntimeId(runtime_id); validateProviderId(provider);
    const job = this.readJob(runtime_id);
    if (job.nonce !== request.nonce || job.request_id !== request.request_id || job.owner_uid !== ownerUid()) throw new ProtocolError("BINDING_MISMATCH", "job binding does not match this owner/request");
    const root = privateDirectory(path.join(this.runtimePath(runtime_id), provider));
    const receipt = {
      protocol_version: 3, request_id: request.request_id, nonce: request.nonce, owner_uid: ownerUid(), runtime_id, provider,
      round: request.round, config_hash, config_snapshot, provider_profile_hash: profile_hash,
      material_hash: request.material.input_hash, contract_ref: request.contract_ref, session_id: result.session_id ?? null,
      status: result.execution_eligible ? "completed" : "failed", persisted: result.persisted === true,
      error_code: result.error_code ?? null, raw_file: result.raw_ref ? path.basename(result.raw_ref) : null,
      diagnostic_file: result.diagnostic_ref ? path.basename(result.diagnostic_ref) : null,
      created_at_ms: this.now(), expires_at_ms: this.now() + RUNTIME_TTL_MS,
    };
    const digest = receiptHash(receipt).hash;
    writeJson(path.join(root, PROVIDER_RECEIPT), { ...receipt, receipt_hash: digest });
    const publicResult = canonicalProvider(result, runtime_id, provider, ref(runtime_id, provider, "receipt"), result.diagnostic_ref ? ref(runtime_id, provider, "diagnostic") : null);
    const updated = { ...job, providers: { ...job.providers, [provider]: { receipt_hash: digest, result: publicResult } } };
    writeJson(this.jobPath(runtime_id), updated);
    return publicResult;
  }

  readPrivate({ runtime_id, provider, nonce, ref: requested }) {
    validateRuntimeId(runtime_id); validateProviderId(provider);
    if (!["raw", "diagnostic", "receipt"].includes(requested)) throw new ProtocolError("REQUEST_INVALID", "ref must be raw, diagnostic, or receipt");
    const job = this.readJob(runtime_id);
    if (job.owner_uid !== ownerUid() || job.nonce !== nonce) throw new ProtocolError("BINDING_MISMATCH", "private payload binding does not match runtime/provider/nonce");
    if (this.now() > job.expires_at_ms) throw new ProtocolError("NONCE_EXPIRED", "terminal request nonce expired");
    const root = privateDirectory(path.join(this.runtimePath(runtime_id), provider));
    const receipt = privateJson(path.join(root, PROVIDER_RECEIPT));
    if (!receipt || receipt.runtime_id !== runtime_id || receipt.provider !== provider || receipt.nonce !== nonce) throw new ProtocolError("BINDING_MISMATCH", "provider receipt binding does not match");
    if (requested === "receipt") return structuredClone(receipt);
    const basename = requested === "raw" ? receipt.raw_file : receipt.diagnostic_file;
    if (!basename) return null;
    if (basename !== path.basename(basename)) throw new ProtocolError("BINDING_MISMATCH", "private payload path is invalid");
    const target = path.join(root, basename);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new ProtocolError("BINDING_MISMATCH", "private payload is not an owner-only real file");
    return fs.readFileSync(target, "utf8");
  }

  readJob(runtime_id) {
    validateRuntimeId(runtime_id);
    const job = privateJson(this.jobPath(runtime_id));
    if (!job || job.runtime_id !== runtime_id || job.owner_uid !== ownerUid()) throw new ProtocolError("BINDING_MISMATCH", "runtime job is not owned by this process user");
    return job;
  }

  readActive({ runtime_id, provider }) {
    validateRuntimeId(runtime_id); validateProviderId(provider);
    return privateJson(this.activePath(runtime_id, provider), null);
  }

  listActive(runtime_id) {
    const root = this.runtimePath(runtime_id);
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[A-Za-z0-9_-]{1,128}$/.test(entry.name))
      .map((entry) => this.readActive({ runtime_id, provider: entry.name })).filter(Boolean);
  }

  runtimePath(runtime_id) { validateRuntimeId(runtime_id); return path.join(this.runtimeRoot, runtime_id); }
  jobPath(runtime_id) { return path.join(this.runtimePath(runtime_id), JOB_FILE); }
  activePath(runtime_id, provider) { validateRuntimeId(runtime_id); validateProviderId(provider); return path.join(this.runtimePath(runtime_id), provider, ".3rd-review-active.json"); }
}
