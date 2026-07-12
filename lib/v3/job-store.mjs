import fs from "node:fs";
import path from "node:path";
import { createRuntimeId, ProtocolError, receiptHash, RUNTIME_TTL_MS, sha256, validateProviderId, validateRuntimeId } from "./protocol.mjs";

const JOB_FILE = ".3rd-review-job.json";
const PROVIDER_RECEIPT = ".3rd-review-provider-receipt.json";
const ROUND_RECEIPT = (round) => `.3rd-review-provider-receipt-r${round}.json`;
const ROUND_RESULT = (round) => `.3rd-review-provider-result-r${round}.json`;
const ROUND_LOCK = ".3rd-review-round.lock";

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
function reserveIndex(file) {
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ creating: true, pid: process.pid, created_at_ms: Date.now() })}\n`, { encoding: "utf8" });
    fs.fchmodSync(fd, 0o600);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw new ProtocolError("RUNTIME_UNAVAILABLE", "request index cannot be reserved", { cause: error.code ?? error.message });
  } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* reservation cannot be safely recovered here */ } }
}
function reserveRoundLock(file, request) {
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ request_id: request.request_id, round: request.round, pid: process.pid, created_at_ms: Date.now() })}\n`, { encoding: "utf8" });
    fs.fchmodSync(fd, 0o600);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw new ProtocolError("RUNTIME_UNAVAILABLE", "continuation lock cannot be reserved", { cause: error.code ?? error.message });
    return false;
  } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* durable lock remains until terminal completion */ } }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function ref(runtime_id, provider, name, round = null) {
  return `private://${runtime_id}/${provider}/${name}${round === null ? "" : `?round=${round}`}`;
}
function requestKey(request_id) { return sha256(request_id).slice("sha256:".length); }
function canonicalProvider(result, runtime_id, provider, receipt_ref, diagnostic_ref, result_ref = null) {
  return {
    id: provider,
    status: result.execution_eligible ? "completed" : "failed",
    execution_eligible: result.execution_eligible === true,
    session_id: result.execution_eligible && typeof result.session_id === "string" ? result.session_id : null,
    runtime_id,
    receipt_ref,
    result_ref,
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
    let indexed = privateJson(indexFile, null);
    if (indexed === null && !reserveIndex(indexFile)) indexed = privateJson(indexFile, null);
    if (indexed) {
      if (indexed.creating === true) {
        if (processAlive(indexed.pid)) throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", "request creation is already active");
        fs.unlinkSync(indexFile);
        return this.begin({ request, config_hash, config_snapshot });
      }
      if (request.nonce === null) throw new ProtocolError("NONCE_REQUIRED", "existing request_id requires its original nonce");
      if (request.nonce !== indexed.nonce) throw new ProtocolError("REPLAY_DETECTED", "request_id is already bound to a different nonce");
      if (indexed.expired === true) throw new ProtocolError("NONCE_EXPIRED", "terminal request nonce expired; create a new request_id");
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
      rounds: { 1: { request_id: request.request_id, material_hash: request.material.input_hash, contract_ref: request.contract_ref, previous_receipts: null, providers: {} } },
    };
    privateDirectory(this.runtimePath(runtime_id));
    writeJson(this.jobPath(runtime_id), job);
    writeJson(indexFile, { request_id: request.request_id, nonce, runtime_id });
    return { existing: false, request: { ...request, nonce, runtime_id }, job };
  }

  beginContinuation({ request, config_hash }) {
    validateRuntimeId(request.runtime_id);
    const job = this.readJob(request.runtime_id);
    if (job.nonce !== request.nonce || job.owner_uid !== ownerUid()) {
      throw new ProtocolError("BINDING_MISMATCH", "continuation request does not match its runtime");
    }
    if (job.config_hash !== config_hash) throw new ProtocolError("CONFIG_SNAPSHOT_CHANGED", "continuation config changed");
    if (request.contract_ref !== job.contract_ref) throw new ProtocolError("BINDING_MISMATCH", "continuation contract reference changed");
    if (request.round !== job.round + 1) throw new ProtocolError("CONTINUATION_FAILED", "continuation round must immediately follow the latest round");
    const previous = job.rounds?.[job.round];
    if (!previous) throw new ProtocolError("BINDING_MISMATCH", "latest round history is missing");
    const expected = Object.fromEntries(Object.entries(previous.providers)
      .filter(([, state]) => state.status === "completed" && typeof state.session_id === "string")
      .map(([provider, state]) => [provider, state.receipt_hash]));
    const supplied = request.previous_receipts ?? {};
    if (JSON.stringify(Object.keys(supplied).sort()) !== JSON.stringify(Object.keys(expected).sort())) {
      throw new ProtocolError("BINDING_MISMATCH", "continuation providers must exactly match prior successful native sessions");
    }
    for (const [provider, digest] of Object.entries(expected)) {
      if (supplied[provider] !== digest) throw new ProtocolError("BINDING_MISMATCH", "continuation previous receipt does not match provider history");
    }
    const indexFile = path.join(this.indexRoot, `${requestKey(request.request_id)}.json`);
    let indexed = privateJson(indexFile, null);
    if (indexed !== null) {
      if (indexed.creating === true) {
        if (processAlive(indexed.pid)) throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", "continuation request creation is already active");
        fs.unlinkSync(indexFile);
        return this.beginContinuation({ request, config_hash });
      }
      if (indexed.runtime_id !== request.runtime_id || indexed.nonce !== request.nonce || indexed.round !== request.round) {
        throw new ProtocolError("REPLAY_DETECTED", "continuation request_id is already bound to another request");
      }
      return { existing: true, job };
    }
    if (!reserveIndex(indexFile)) throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", "continuation request creation is already active");
    const roundLock = path.join(this.runtimePath(request.runtime_id), ROUND_LOCK);
    if (!reserveRoundLock(roundLock, request)) {
      const held = privateJson(roundLock, null);
      if (held && !processAlive(held.pid)) {
        fs.unlinkSync(roundLock);
        fs.unlinkSync(indexFile);
        return this.beginContinuation({ request, config_hash });
      }
      throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", "a continuation round is already active");
    }
    if (job.active_round !== undefined) {
      try { fs.unlinkSync(roundLock); } catch { /* stale reservation remains explicitly diagnosable */ }
      try { fs.unlinkSync(indexFile); } catch { /* a failed cleanup is reclaimed by pid on the next call */ }
      throw new ProtocolError("DUPLICATE_ACTIVE_REQUEST", "a continuation round is already active");
    }
    const updated = {
      ...job,
      status: "running",
      active_round: request.round,
      rounds: {
        ...job.rounds,
        [request.round]: {
          request_id: request.request_id,
          material_hash: request.material.input_hash,
          contract_ref: request.contract_ref,
          previous_receipts: request.previous_receipts,
          providers: {},
        },
      },
    };
    writeJson(this.jobPath(request.runtime_id), updated);
    writeJson(indexFile, { request_id: request.request_id, nonce: request.nonce, runtime_id: request.runtime_id, round: request.round });
    return { existing: false, job: updated };
  }

  complete(runtime_id, result) {
    const job = this.readJob(runtime_id);
    const { active_round, ...stable } = job;
    const terminal = { ...stable, status: "completed", result, expires_at_ms: this.now() + RUNTIME_TTL_MS };
    writeJson(this.jobPath(runtime_id), terminal);
    if (active_round !== undefined) {
      const lock = path.join(this.runtimePath(runtime_id), ROUND_LOCK);
      const held = privateJson(lock, null);
      if (held?.request_id === result?.request_id && held?.round === active_round) fs.unlinkSync(lock);
    }
    return terminal;
  }

  commitProvider({ runtime_id, provider, request, config_hash, config_snapshot, profile_hash, result }) {
    validateRuntimeId(runtime_id); validateProviderId(provider);
    const job = this.readJob(runtime_id);
    if (job.nonce !== request.nonce || job.owner_uid !== ownerUid()) throw new ProtocolError("BINDING_MISMATCH", "job binding does not match this owner/request");
    const root = privateDirectory(path.join(this.runtimePath(runtime_id), provider));
    const resultFile = typeof result.result_text === "string" ? ROUND_RESULT(request.round) : null;
    if (resultFile !== null) writeJson(path.join(root, resultFile), { text: result.result_text });
    const receipt = {
      protocol_version: 3, request_id: request.request_id, nonce: request.nonce, owner_uid: ownerUid(), runtime_id, provider,
      round: request.round, config_hash, config_snapshot, provider_profile_hash: profile_hash,
      material_hash: request.material.input_hash, initial_material_hash: job.material_hash,
      parent_receipt_hash: request.round === 1 ? null : request.previous_receipts[provider] ?? null,
      contract_ref: request.contract_ref, session_id: result.session_id ?? null,
      status: result.execution_eligible ? "completed" : "failed", persisted: result.persisted === true,
      error_code: result.error_code ?? null, raw_file: result.raw_ref ? path.basename(result.raw_ref) : null,
      diagnostic_file: result.diagnostic_ref ? path.basename(result.diagnostic_ref) : null,
      result_file: resultFile,
      created_at_ms: this.now(), expires_at_ms: this.now() + RUNTIME_TTL_MS,
    };
    const digest = receiptHash(receipt).hash;
    const fullReceipt = { ...receipt, receipt_hash: digest };
    writeJson(path.join(root, ROUND_RECEIPT(request.round)), fullReceipt);
    writeJson(path.join(root, PROVIDER_RECEIPT), fullReceipt);
    const publicResult = canonicalProvider(
      result, runtime_id, provider, ref(runtime_id, provider, "receipt", request.round),
      result.diagnostic_ref ? ref(runtime_id, provider, "diagnostic", request.round) : null,
      resultFile === null ? null : ref(runtime_id, provider, "result", request.round),
    );
    const previous = job.providers[provider] ?? { rounds: {} };
    const roundState = job.rounds?.[request.round];
    if (!roundState || roundState.request_id !== request.request_id) throw new ProtocolError("BINDING_MISMATCH", "provider receipt is not part of the active request round");
    const updated = {
      ...job,
      round: Math.max(job.round, request.round),
      expires_at_ms: this.now() + RUNTIME_TTL_MS,
      providers: {
        ...job.providers,
        [provider]: {
          ...previous,
          latest_round: request.round,
          latest_receipt_hash: digest,
          receipt_hash: digest,
          rounds: { ...(previous.rounds ?? {}), [request.round]: { receipt_hash: digest, result: publicResult } },
          result: publicResult,
        },
      },
      rounds: {
        ...job.rounds,
        [request.round]: {
          ...roundState,
          providers: {
            ...roundState.providers,
            [provider]: { receipt_hash: digest, session_id: publicResult.session_id, status: publicResult.status },
          },
        },
      },
    };
    writeJson(this.jobPath(runtime_id), updated);
    return publicResult;
  }

  readPrivate({ runtime_id, provider, nonce, ref: requested, round = null }) {
    validateRuntimeId(runtime_id); validateProviderId(provider);
    if (!["raw", "diagnostic", "receipt", "result"].includes(requested)) throw new ProtocolError("REQUEST_INVALID", "ref must be raw, diagnostic, receipt, or result");
    const job = this.readJob(runtime_id);
    if (job.owner_uid !== ownerUid() || job.nonce !== nonce) throw new ProtocolError("BINDING_MISMATCH", "private payload binding does not match runtime/provider/nonce");
    if (this.now() > job.expires_at_ms) throw new ProtocolError("NONCE_EXPIRED", "terminal request nonce expired");
    const providerState = job.providers[provider];
    if (!providerState) throw new ProtocolError("BINDING_MISMATCH", "provider has no committed private receipt for this job");
    const selectedRound = round ?? providerState.latest_round;
    if (!Number.isSafeInteger(selectedRound) || selectedRound < 1 || !providerState.rounds?.[selectedRound]) {
      throw new ProtocolError("BINDING_MISMATCH", "requested provider round does not exist");
    }
    const root = path.join(this.runtimePath(runtime_id), provider);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) throw new ProtocolError("BINDING_MISMATCH", "provider private directory is invalid");
    const receipt = privateJson(path.join(root, ROUND_RECEIPT(selectedRound)));
    if (!receipt || receipt.runtime_id !== runtime_id || receipt.provider !== provider || receipt.nonce !== nonce) throw new ProtocolError("BINDING_MISMATCH", "provider receipt binding does not match");
    if (requested === "receipt") return structuredClone(receipt);
    const basename = requested === "raw" ? receipt.raw_file : requested === "diagnostic" ? receipt.diagnostic_file : receipt.result_file;
    if (!basename) return null;
    if (basename !== path.basename(basename)) throw new ProtocolError("BINDING_MISMATCH", "private payload path is invalid");
    const target = path.join(root, basename);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new ProtocolError("BINDING_MISMATCH", "private payload is not an owner-only real file");
    const value = fs.readFileSync(target, "utf8");
    return requested === "result" ? JSON.parse(value).text : value;
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

  gcExpired() {
    const removed = [];
    for (const entry of fs.readdirSync(this.indexRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
      const indexPath = path.join(this.indexRoot, entry.name);
      const indexed = privateJson(indexPath, null);
      if (!indexed?.runtime_id || indexed.expired === true) continue;
      let job;
      try { job = this.readJob(indexed.runtime_id); } catch (error) {
        if (error.code === "BINDING_MISMATCH") {
          writeJson(indexPath, { ...indexed, expired: true, expired_at_ms: this.now() });
          continue;
        }
        throw error;
      }
      if (this.now() <= job.expires_at_ms || this.listActive(job.runtime_id).some((attempt) => attempt.terminal !== true)) continue;
      fs.rmSync(this.runtimePath(job.runtime_id), { recursive: true, force: true });
      for (const sibling of fs.readdirSync(this.indexRoot, { withFileTypes: true })) {
        if (!sibling.isFile() || sibling.isSymbolicLink() || !sibling.name.endsWith(".json")) continue;
        const siblingPath = path.join(this.indexRoot, sibling.name);
        const siblingIndex = privateJson(siblingPath, null);
        if (siblingIndex?.runtime_id === job.runtime_id) writeJson(siblingPath, { ...siblingIndex, expired: true, expired_at_ms: this.now() });
      }
      removed.push(job.runtime_id);
    }
    return removed;
  }

  runtimePath(runtime_id) { validateRuntimeId(runtime_id); return path.join(this.runtimeRoot, runtime_id); }
  jobPath(runtime_id) { return path.join(this.runtimePath(runtime_id), JOB_FILE); }
  activePath(runtime_id, provider) { validateRuntimeId(runtime_id); validateProviderId(provider); return path.join(this.runtimePath(runtime_id), provider, ".3rd-review-active.json"); }
}
