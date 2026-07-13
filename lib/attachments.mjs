import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.mjs";

const EMBED_BUDGET = 512 * 1024;
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
function renderEmbedded(items) {
  const text = items.map((entry) => `<attachment destination="${entry.target}" sha256="${entry.sha256}">\n${entry.contents}\n</attachment>`).join("\n");
  if (Buffer.byteLength(text, "utf8") > EMBED_BUDGET) fail("ATTACHMENT_EMBED_TOO_LARGE", `embedded attachments exceed ${EMBED_BUDGET} bytes`);
  return text;
}
export function validateAttachments(input, maxBytes, roots) {
  if (!input || typeof input !== "object" || !["file_only", "always_embed"].includes(input.delivery)) fail("ATTACHMENT_DELIVERY_UNSUPPORTED", "attachment delivery must be file_only or always_embed");
  const { canonical, policy } = allowedRoot(input.root, roots); const parsed = parseManifest(input.manifest); let total = 0; const values = [];
  for (const entry of parsed.entries) { allowedSource(entry.source, policy); total += entry.size; if (total > maxBytes) fail("ATTACHMENT_TOO_LARGE", `attachments exceed ${maxBytes} bytes`); values.push({ ...entry, contents: contents(canonical, entry, maxBytes) }); }
  const files = records(parsed.entries);
  return { root: canonical, requested_delivery: input.delivery, bundle_id: parsed.bundle_id, entries: parsed.entries, files, manifest_hash: manifestHash(parsed.bundle_id, files), embedded_text: parsed.entries.every((entry) => entry.embed) ? renderEmbedded(values.map((entry) => ({ ...entry, contents: entry.contents.toString("utf8") }))) : null };
}
function writeManifest(directory, stored) { fs.writeFileSync(path.join(directory, "attachments-manifest.json"), `${JSON.stringify({ version: 1, bundle_id: stored.bundle_id, manifest_hash: stored.manifest_hash, files: stored.files })}\n`, { mode: 0o400, flag: "wx" }); }
function lockTree(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, item.name); if (item.isDirectory()) { lockTree(target); fs.chmodSync(target, 0o500); } else fs.chmodSync(target, 0o400); } fs.chmodSync(directory, 0o500); }
function unlockTree(directory) { try { for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) unlockTree(path.join(directory, item.name)); fs.chmodSync(directory, 0o700); } catch { /* probe cleanup is best effort */ } }
function verifyTree(directory, stored) {
  const manifest = path.join(directory, "attachments-manifest.json"); const embedded = [];
  const root = fs.lstatSync(directory); if (!root.isDirectory() || root.isSymbolicLink()) fail("ATTACHMENT_IMMUTABLE", "frozen attachment root changed");
  const saved = JSON.parse(fs.readFileSync(manifest, "utf8")); if (saved.bundle_id !== stored.bundle_id || saved.manifest_hash !== stored.manifest_hash || JSON.stringify(saved.files) !== JSON.stringify(stored.files)) fail("ATTACHMENT_IMMUTABLE", "frozen attachment manifest changed");
  for (const item of stored.files) { const file = path.join(directory, ...item.target.split("/")); const stat = fs.lstatSync(file); const value = fs.readFileSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== item.size || digest(value) !== item.sha256) fail("ATTACHMENT_IMMUTABLE", `frozen attachment changed: ${item.target}`); if (item.embed) embedded.push({ ...item, contents: value.toString("utf8") }); }
  return { embedded_text: stored.files.every((item) => item.embed) ? renderEmbedded(embedded) : null };
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
export function appendEmbedded(prompt, text, maxPromptBytes) { if (!text) return prompt; const output = `${prompt}\n\n<attachments mode="always_embed">\n${text}\n</attachments>`; if (Buffer.byteLength(output, "utf8") > maxPromptBytes) fail("PROMPT_TOO_LARGE", `prompt and embedded attachments exceed ${maxPromptBytes} bytes`); return output; }
