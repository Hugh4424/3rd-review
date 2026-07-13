import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.mjs";

export const EMBED_BUDGET = 512 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function safe(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("~") || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) fail("ATTACHMENT_INVALID", `${label} must be a relative POSIX path`);
  return value;
}
function parseManifest(value) {
  if (!value || typeof value !== "object" || value.version !== 1 || typeof value.bundle_id !== "string" || !value.bundle_id || !Array.isArray(value.entries) || value.entries.length === 0) fail("ATTACHMENT_INVALID", "attachments manifest needs version, bundle_id, and entries");
  const destinations = new Set();
  return { bundle_id: value.bundle_id, entries: value.entries.map((entry) => {
    if (!entry || typeof entry !== "object") fail("ATTACHMENT_INVALID", "attachment entry must be an object");
    const source = safe(entry.source, "attachment source"); const target = safe(entry.destination, "attachment destination");
    if (destinations.has(target)) fail("ATTACHMENT_INVALID", `duplicate attachment destination: ${target}`); destinations.add(target);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256) || typeof entry.embed !== "boolean") fail("ATTACHMENT_INVALID", `attachment ${target} needs size, sha256, and embed`);
    return { source, target, size: entry.size, sha256: entry.sha256.toLowerCase(), embed: entry.embed };
  }) };
}
function allowedRoot(input, roots) {
  if (typeof input !== "string" || !path.isAbsolute(input)) fail("ATTACHMENT_ROOT_FORBIDDEN", "attachments root must be an allowlisted absolute directory");
  let canonical;
  try { const stat = fs.lstatSync(input); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("ATTACHMENT_ROOT_FORBIDDEN", "attachments root must be a real directory"); canonical = fs.realpathSync(input); }
  catch (error) { if (error?.code === "ATTACHMENT_ROOT_FORBIDDEN") throw error; fail("ATTACHMENT_ROOT_FORBIDDEN", "attachments root is unavailable"); }
  const policy = roots.find((item) => { try { return fs.realpathSync(item.root) === canonical; } catch { return false; } });
  if (!policy) fail("ATTACHMENT_ROOT_FORBIDDEN", "attachments root is not allowlisted");
  return { canonical, policy };
}
export function validateAttachmentRoot(input, roots) { return allowedRoot(input, roots); }
function allowedSource(source, policy) { if (!policy.sources.some((prefix) => source === prefix || source.startsWith(`${prefix}/`))) fail("ATTACHMENT_SOURCE_FORBIDDEN", `attachment source is not allowed: ${source}`); }
function contents(root, entry, limit) {
  const parts = entry.source.split("/"); let file = root;
  try {
    for (let index = 0; index < parts.length; index += 1) { file = path.join(file, parts[index]); const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) fail("ATTACHMENT_INVALID", `unsafe attachment source: ${entry.source}`); }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) fail("ATTACHMENT_INVALID", `attachment source must be a single-link regular file: ${entry.source}`); if (stat.size !== entry.size || stat.size > limit) fail(stat.size > limit ? "ATTACHMENT_TOO_LARGE" : "ATTACHMENT_HASH_MISMATCH", `attachment size differs: ${entry.target}`); const value = fs.readFileSync(fd); if (digest(value) !== entry.sha256) fail("ATTACHMENT_HASH_MISMATCH", `attachment hash differs: ${entry.target}`); return value; } finally { fs.closeSync(fd); }
  } catch (error) { if (error?.code?.startsWith("ATTACHMENT_")) throw error; fail("ATTACHMENT_INVALID", `attachment source is unreadable: ${entry.source}`); }
}
const records = (entries) => entries.map(({ target, sha256, size, embed }) => ({ target, sha256, size, embed }));
const manifestHash = (bundle_id, files) => digest(JSON.stringify({ version: 1, bundle_id, files }));
function renderEmbedded(items) { return items.map((entry) => `<attachment destination="${entry.target}" sha256="${entry.sha256}">\n${entry.contents}\n</attachment>`).join("\n"); }
function json(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { fail("MATERIAL_INCOMPLETE", `${label} must be valid JSON`); } }
function digestField(value, field, label) { if (typeof value?.[field] !== "string" || !/^[a-f0-9]{64}$/i.test(value[field])) fail("MATERIAL_INCOMPLETE", `${label} has no valid ${field}`); return value[field].toLowerCase(); }
function sameFiles(expected, actual) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalized = actual.map((item) => item && typeof item === "object" ? { destination: item.destination, sha256: item.sha256?.toLowerCase(), size: item.size } : null);
  return JSON.stringify(normalized) === JSON.stringify(expected);
}
export function validateFileOnlyTriad(checked) {
  const byTarget = new Map(checked.content_entries.map((entry) => [entry.target, entry]));
  for (const target of ["review-packet.v1.json", "changes.diff", "manifest.json"]) if (!byTarget.has(target)) fail("MATERIAL_INCOMPLETE", `file_only bundle is missing ${target}`);
  const packet = json(byTarget.get("review-packet.v1.json").contents, "review-packet.v1.json"); const inner = json(byTarget.get("manifest.json").contents, "manifest.json");
  if (packet.version !== "review-packet.v1") fail("MATERIAL_INCOMPLETE", "review-packet.v1.json has an unsupported version");
  const packetHash = digestField(packet, "packet_hash", "review-packet.v1.json"); const manifestHash = digestField(packet, "manifest_hash", "review-packet.v1.json"); const diffHash = digestField(packet, "diff_sha256", "review-packet.v1.json");
  if (packetHash !== digestField(inner, "packet_hash", "manifest.json") || manifestHash !== digestField(inner, "manifest_hash", "manifest.json") || diffHash !== digestField(inner, "diff_sha256", "manifest.json")) fail("MATERIAL_INCOMPLETE", "packet and manifest hashes disagree");
  if (digest(byTarget.get("changes.diff").contents) !== diffHash) fail("MATERIAL_INCOMPLETE", "changes.diff hash does not match packet");
  const expected = checked.files.filter((item) => item.target !== "manifest.json").map(({ target, sha256, size }) => ({ destination: target, sha256, size }));
  if (!sameFiles(expected, inner.attachments)) fail("MATERIAL_INCOMPLETE", "manifest attachment coverage does not match delivered bundle");
  return { packet_hash: packetHash, manifest_hash: manifestHash, diff_sha256: diffHash };
}
export function validateAttachments(input, maxBytes, roots) {
  if (!input || typeof input !== "object" || !["file_only", "always_embed"].includes(input.delivery)) fail("ATTACHMENT_DELIVERY_UNSUPPORTED", "attachment delivery must be file_only or always_embed");
  const { canonical, policy } = allowedRoot(input.root, roots); const parsed = parseManifest(input.manifest); let total = 0; const values = [];
  for (const entry of parsed.entries) { allowedSource(entry.source, policy); total += entry.size; if (total > maxBytes) fail("ATTACHMENT_TOO_LARGE", `attachments exceed ${maxBytes} bytes`); values.push({ ...entry, contents: contents(canonical, entry, maxBytes) }); }
  const files = records(parsed.entries);
  return { root: canonical, requested_delivery: input.delivery, bundle_id: parsed.bundle_id, entries: parsed.entries, files, manifest_hash: manifestHash(parsed.bundle_id, files), total_bytes: total, content_entries: values };
}
export function planDelivery(worker, checked, prompt, maxPromptBytes) {
  const supported = worker.capabilities?.attachment_delivery ?? [];
  if (!supported.includes(checked.requested_delivery)) fail("ATTACHMENT_DELIVERY_UNSUPPORTED", `provider cannot accept requested attachment delivery ${checked.requested_delivery}`);
  const provider_visible_attachment_manifest = checked.files.map(({ target: destination, sha256, size }) => ({ destination, sha256, size }));
  if (checked.requested_delivery === "file_only") {
    validateFileOnlyTriad(checked);
    return { delivery_mode: "file_only", provider_prompt: prompt, material_manifest_hash: checked.manifest_hash, total_bytes: checked.total_bytes, provider_visible_attachment_manifest };
  }
  if (!checked.entries.every((entry) => entry.embed)) fail("ATTACHMENT_DELIVERY_UNSUPPORTED", "always_embed requires every attachment to allow embedding");
  const embedded = renderEmbedded(checked.content_entries.map((entry) => ({ ...entry, contents: entry.contents.toString("utf8") })));
  const provider_prompt = `${prompt}\n\n<attachments mode="always_embed">\n${embedded}\n</attachments>`;
  const bytes = Buffer.byteLength(provider_prompt, "utf8");
  if (bytes > EMBED_BUDGET) fail("MATERIAL_TOO_LARGE", `final always_embed prompt exceeds ${EMBED_BUDGET} bytes`);
  if (bytes > maxPromptBytes) fail("PROMPT_TOO_LARGE", `prompt and embedded attachments exceed ${maxPromptBytes} bytes`);
  return { delivery_mode: "always_embed", provider_prompt, material_manifest_hash: checked.manifest_hash, total_bytes: bytes, provider_visible_attachment_manifest };
}
function writeManifest(directory, stored) { fs.writeFileSync(path.join(directory, "attachments-manifest.json"), `${JSON.stringify({ version: 1, bundle_id: stored.bundle_id, manifest_hash: stored.manifest_hash, files: stored.files })}\n`, { mode: 0o400, flag: "wx" }); }
function lockTree(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, item.name); if (item.isDirectory()) { lockTree(target); fs.chmodSync(target, 0o500); } else fs.chmodSync(target, 0o400); } fs.chmodSync(directory, 0o500); }
function unlockTree(directory) { try { for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) unlockTree(path.join(directory, item.name)); fs.chmodSync(directory, 0o700); } catch { /* probe cleanup is best effort */ } }
function verifyTree(directory, stored) {
  const manifest = path.join(directory, "attachments-manifest.json");
  const root = fs.lstatSync(directory); if (!root.isDirectory() || root.isSymbolicLink()) fail("ATTACHMENT_IMMUTABLE", "frozen attachment root changed");
  const saved = JSON.parse(fs.readFileSync(manifest, "utf8")); if (saved.bundle_id !== stored.bundle_id || saved.manifest_hash !== stored.manifest_hash || JSON.stringify(saved.files) !== JSON.stringify(stored.files)) fail("ATTACHMENT_IMMUTABLE", "frozen attachment manifest changed");
  for (const item of stored.files) { const file = path.join(directory, ...item.target.split("/")); const stat = fs.lstatSync(file); const value = fs.readFileSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== item.size || digest(value) !== item.sha256) fail("ATTACHMENT_IMMUTABLE", `frozen attachment changed: ${item.target}`); }
  return {};
}
export function prepareAttachments(input, runtime, provider, maxBytes, roots) {
  const checked = validateAttachments(input, maxBytes, roots); const workspace = path.join(runtime, "workspace"); const cwd = path.join(workspace, provider); fs.mkdirSync(workspace, { recursive: true, mode: 0o700 }); if (fs.existsSync(cwd)) fail("ATTACHMENT_IMMUTABLE", "provider workspace already exists");
  const staging = path.join(workspace, `.${provider}-${randomUUID()}`); fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try { for (const entry of checked.entries) { const target = path.join(staging, ...entry.target.split("/")); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, contents(checked.root, entry, maxBytes), { mode: 0o400, flag: "wx" }); } if (provider === "kimi") { const skills = path.join(staging, "skills"); if (fs.existsSync(skills) && !fs.lstatSync(skills).isDirectory()) fail("ATTACHMENT_INVALID", "Kimi skills destination must be a directory"); fs.mkdirSync(skills, { recursive: true, mode: 0o700 }); } writeManifest(staging, checked); lockTree(staging); fs.renameSync(staging, cwd); } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  return { cwd, ...checked };
}
export function verifyFrozenAttachments(runtime, provider, stored) {
  if (!stored) fail("ATTACHMENT_IMMUTABLE", "runtime has no frozen attachments"); const cwd = path.join(runtime, "workspace", provider);
  try { return { cwd, ...verifyTree(cwd, stored) }; }
  catch (error) { if (error?.code === "ATTACHMENT_IMMUTABLE") throw error; fail("ATTACHMENT_IMMUTABLE", "frozen attachment workspace is unavailable"); }
}
export function prepareWritableAttachmentView(runtime, provider, stored) {
  const frozen = verifyFrozenAttachments(runtime, provider, stored); const cwd = path.join(runtime, "work", provider); const bundle = path.join(cwd, "bundle"); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); fs.chmodSync(cwd, 0o700);
  if (fs.existsSync(bundle)) { try { verifyTree(bundle, stored); return { cwd, bundle }; } catch (error) { if (error?.code === "ATTACHMENT_IMMUTABLE") throw error; fail("ATTACHMENT_IMMUTABLE", "provider bundle view is unavailable"); } }
  const staging = path.join(cwd, `.bundle-${randomUUID()}`); fs.mkdirSync(staging, { mode: 0o700 });
  try { for (const item of stored.files) { const source = path.join(frozen.cwd, ...item.target.split("/")); const target = path.join(staging, ...item.target.split("/")); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o400); } if (provider === "kimi") fs.mkdirSync(path.join(staging, "skills"), { recursive: true, mode: 0o700 }); writeManifest(staging, stored); lockTree(staging); fs.renameSync(staging, bundle); }
  catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  return { cwd, bundle };
}
// Doctor must prove the filesystem half of attachment delivery without
// consulting a provider.  Use the production copy/lock/verify paths with a
// harmless, broker-owned file so an empty packet root is not mutated merely
// by a readiness check.
export function probeAttachmentWorkspace(runtime, provider, maxBytes) {
  let root = null;
  try {
    root = fs.mkdtempSync(path.join(runtime, "attachment-probe-"));
    const source = path.join(root, "source"); const payload = "x";
    fs.mkdirSync(source, { mode: 0o700 }); fs.writeFileSync(path.join(source, "probe.txt"), payload, { mode: 0o600, flag: "wx" });
    const manifest = { version: 1, bundle_id: `doctor-${randomUUID()}`, entries: [{ source: "probe.txt", destination: "probe.txt", size: Buffer.byteLength(payload), sha256: digest(payload), embed: true }] };
    const input = { root: source, delivery: "file_only", manifest };
    const allowlist = [{ root: source, sources: ["probe.txt"] }];
    const frozen = prepareAttachments(input, root, provider, maxBytes, allowlist);
    const stored = { bundle_id: frozen.bundle_id, manifest_hash: frozen.manifest_hash, files: frozen.files };
    verifyFrozenAttachments(root, provider, stored);
    const writable = prepareWritableAttachmentView(root, provider, stored);
    if (!fs.statSync(writable.cwd).isDirectory() || !fs.statSync(writable.bundle).isDirectory()) fail("ATTACHMENT_PROBE_FAILED", "private attachment workspace is unavailable");
    verifyTree(writable.bundle, stored);
  } catch (error) {
    if (error?.code === "ATTACHMENT_PROBE_FAILED") throw error;
    fail("ATTACHMENT_PROBE_FAILED", "attachment workspace probe failed");
  } finally { if (root) { unlockTree(root); fs.rmSync(root, { recursive: true, force: true, maxRetries: 2 }); } }
}
