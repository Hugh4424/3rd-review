import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalDeliveryManifestHash,
  canonicalInnerManifestHash,
  canonicalMaterialManifestHash,
  canonicalPacketHash,
} from "./attachments.mjs";
import { fail } from "./errors.mjs";

export const MATERIAL_REDACTION_RULE_VERSION = "host-root-prefix.v1";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (bytes, label) => { try { return JSON.parse(bytes.toString("utf8")); } catch { fail("MATERIAL_INCOMPLETE", `${label} must be valid JSON`); } };
const record = (target, contents, embed) => ({ target, sha256: sha(contents), size: contents.length, embed });
const contentEntry = (original, contents) => ({ ...original, sha256: sha(contents), size: contents.length, contents });

function trimRoot(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("MATERIAL_INCOMPLETE", "sensitive host roots must be non-empty absolute paths");
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) fail("MATERIAL_INCOMPLETE", "sensitive host roots must be absolute paths");
  if (value.split(/[\\/]+/u).includes("..")) fail("MATERIAL_INCOMPLETE", "sensitive host roots cannot contain parent traversal");
  const normalized = value.replace(/[\\/]+$/u, "");
  if (!normalized || /^[A-Za-z]:$/u.test(normalized) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+$/u.test(normalized)) fail("MATERIAL_INCOMPLETE", "sensitive host root is too broad");
  return normalized;
}

function realpathAlias(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

function preparedRoots(items) {
  if (!Array.isArray(items)) fail("MATERIAL_INCOMPLETE", "prepared sensitive host roots must be an array");
  const output = items.map((item, index) => {
    if (!item || typeof item !== "object" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(item.root_id ?? "") || !Number.isSafeInteger(item.order) || item.order < 0) fail("MATERIAL_INCOMPLETE", `prepared sensitive host root ${index} is invalid`);
    const value = trimRoot(item.value); const token = `[PRIVATE_ROOT_${item.root_id.toUpperCase().replace(/-/gu, "_")}]`;
    if (item.token !== token) fail("MATERIAL_INCOMPLETE", `prepared sensitive host root ${index} has an invalid token`);
    return { root_id: item.root_id, token, value, order: item.order };
  });
  output.sort((a, b) => b.value.length - a.value.length || a.order - b.order || a.value.localeCompare(b.value));
  return Object.freeze(output.map((item) => Object.freeze(item)));
}

export function prepareSensitiveRoots(groups) {
  if (!Array.isArray(groups)) fail("MATERIAL_INCOMPLETE", "sensitive host roots must be an array");
  const aliases = []; const seenIds = new Set();
  for (const [index, group] of groups.entries()) {
    if (!group || typeof group !== "object" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(group.root_id ?? "") || !Array.isArray(group.values) || group.values.length === 0) fail("MATERIAL_INCOMPLETE", `sensitive host root group ${index} is invalid`);
    if (seenIds.has(group.root_id)) fail("MATERIAL_INCOMPLETE", `duplicate sensitive host root id: ${group.root_id}`);
    seenIds.add(group.root_id);
    const token = `[PRIVATE_ROOT_${group.root_id.toUpperCase().replace(/-/gu, "_")}]`;
    const groupAliases = new Set();
    for (const raw of group.values) {
      const lexical = trimRoot(raw); const candidates = [lexical, realpathAlias(lexical)].filter(Boolean).map(trimRoot);
      for (const value of candidates) {
        if (groupAliases.has(value)) continue;
        groupAliases.add(value); aliases.push({ root_id: group.root_id, token, value, order: index });
      }
    }
  }
  return preparedRoots(aliases);
}

export function restoreSensitiveRoots(snapshot) { return preparedRoots(snapshot); }
export function sensitiveRootSetHash(roots) {
  const prepared = roots.every((item) => item && Object.hasOwn(item, "value")) ? restoreSensitiveRoots(roots) : prepareSensitiveRoots(roots);
  return sha(JSON.stringify(prepared.map(({ root_id, value, order }) => ({ root_id, value, order }))));
}

function boundary(value, end) { return end === value.length || value[end] === "/" || value[end] === "\\"; }
function nextMatch(value, start, roots) {
  let best = null;
  for (const root of roots) {
    let index = value.indexOf(root.value, start);
    while (index >= 0 && !boundary(value, index + root.value.length)) index = value.indexOf(root.value, index + 1);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && root.value.length > best.root.value.length)) best = { index, root };
  }
  return best;
}
function replaceString(value, roots, counts) {
  let cursor = 0; let output = ""; let match;
  while ((match = nextMatch(value, cursor, roots))) {
    output += value.slice(cursor, match.index) + match.root.token;
    cursor = match.index + match.root.value.length;
    counts.set(match.root.root_id, (counts.get(match.root.root_id) ?? 0) + 1);
  }
  return output + value.slice(cursor);
}
function replaceValue(value, roots, counts) {
  if (typeof value === "string") return replaceString(value, roots, counts);
  if (Array.isArray(value)) return value.map((item) => replaceValue(item, roots, counts));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      const nextKey = replaceString(key, roots, counts);
      if (Object.hasOwn(output, nextKey)) fail("MATERIAL_INCOMPLETE", "host root redaction produced duplicate JSON keys");
      output[nextKey] = replaceValue(item, roots, counts);
    }
    return output;
  }
  return value;
}
function assertNoRegisteredRoot(value, roots, label) {
  if (nextMatch(String(value), 0, roots)) fail("SOURCE_CONTAINS_HOST_ROOT", `${label} still contains a registered sensitive host root`);
}
function receipt(roots, counts, rawHash, derivedHash) {
  const byId = new Map();
  for (const root of roots) if (!byId.has(root.root_id)) byId.set(root.root_id, { root_id: root.root_id, token: root.token, count: counts.get(root.root_id) ?? 0 });
  return { rule_version: MATERIAL_REDACTION_RULE_VERSION, root_set_hash: sensitiveRootSetHash(roots), roots: [...byId.values()], replacement_count: [...counts.values()].reduce((sum, count) => sum + count, 0), raw_material_manifest_hash: rawHash, derived_material_manifest_hash: derivedHash, residual_scan: "passed" };
}

export function deriveProviderMaterial(checked, continuation = null, sensitiveRoots = []) {
  const roots = sensitiveRoots.every((item) => item && Object.hasOwn(item, "value")) ? restoreSensitiveRoots(sensitiveRoots) : prepareSensitiveRoots(sensitiveRoots);
  const raw_material_manifest_hash = checked.manifest_hash;
  if (continuation?.rule_version && continuation.rule_version !== MATERIAL_REDACTION_RULE_VERSION) fail("MATERIAL_INCOMPLETE", "continuation material redaction rule changed");
  if (continuation?.root_set_hash && continuation.root_set_hash !== sensitiveRootSetHash(roots)) fail("MATERIAL_INCOMPLETE", "continuation sensitive host root set changed");
  const diffEntry = checked.content_entries.find((item) => item.target === "changes.diff");
  const packetEntry = checked.content_entries.find((item) => item.target === "review-packet.v1.json");
  const manifestEntry = checked.content_entries.find((item) => item.target === "manifest.json");
  if (!diffEntry || !packetEntry || !manifestEntry) fail("MATERIAL_INCOMPLETE", "derived material requires the complete review triad");

  const counts = new Map(); const derivedBytes = new Map();
  for (const entry of checked.content_entries) {
    if (["review-packet.v1.json", "manifest.json"].includes(entry.target)) continue;
    derivedBytes.set(entry.target, Buffer.from(replaceString(entry.contents.toString("utf8"), roots, counts)));
  }
  const packet = replaceValue(json(packetEntry.contents, "review-packet.v1.json"), roots, counts);
  const inner = replaceValue(json(manifestEntry.contents, "manifest.json"), roots, counts);
  const replacement_count = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const requiresContinuationRebind = Boolean(inner.continuation && continuation && (inner.continuation.initial_material_manifest_hash !== continuation.initial_material_manifest_hash || inner.continuation.previous_delivery_manifest_hash !== (continuation.previous_delivery_manifest_hash ?? null)));
  if (replacement_count === 0 && !requiresContinuationRebind) {
    for (const entry of checked.content_entries) assertNoRegisteredRoot(entry.contents.toString("utf8"), roots, entry.target);
    return { ...checked, raw_material_manifest_hash, delivery_manifest_hash: inner.delivery_manifest_hash, material_representation: "raw", redaction: receipt(roots, counts, raw_material_manifest_hash, raw_material_manifest_hash) };
  }

  const embed = checked.requested_delivery === "always_embed";
  const materialRecords = checked.files
    .filter((item) => !["review-packet.v1.json", "manifest.json"].includes(item.target))
    .map((item) => record(item.target, derivedBytes.get(item.target), embed));
  const material_manifest_hash = canonicalMaterialManifestHash(checked.bundle_id, materialRecords);
  const diffBytes = derivedBytes.get("changes.diff");
  packet.diff_sha256 = sha(diffBytes); packet.manifest_hash = material_manifest_hash; packet.packet_hash = canonicalPacketHash(packet);
  const packetBytes = Buffer.from(`${JSON.stringify(packet)}\n`); derivedBytes.set("review-packet.v1.json", packetBytes);
  const deliveredWithoutManifest = checked.files.filter((item) => item.target !== "manifest.json").map((item) => record(item.target, derivedBytes.get(item.target), embed));
  Object.assign(inner, {
    packet_hash: packet.packet_hash,
    manifest_hash: material_manifest_hash,
    diff_sha256: packet.diff_sha256,
    attachments: deliveredWithoutManifest.map(({ target: destination, sha256, size }) => ({ destination, sha256, size })),
    delivery_manifest_hash: canonicalDeliveryManifestHash(checked.bundle_id, deliveredWithoutManifest, checked.requested_delivery),
  });
  if (inner.continuation) {
    if (!continuation || typeof continuation.initial_material_manifest_hash !== "string") fail("MATERIAL_INCOMPLETE", "derived continuation needs its derived initial material binding");
    inner.continuation = { ...inner.continuation, initial_material_manifest_hash: continuation.initial_material_manifest_hash, previous_delivery_manifest_hash: continuation.previous_delivery_manifest_hash ?? null };
  }
  inner.inner_manifest_hash = canonicalInnerManifestHash(inner);
  const manifestBytes = Buffer.from(`${JSON.stringify(inner)}\n`); derivedBytes.set("manifest.json", manifestBytes);
  const files = checked.files.map((item) => item.target === "manifest.json" ? record(item.target, manifestBytes, embed) : deliveredWithoutManifest.find((candidate) => candidate.target === item.target));
  const content_entries = checked.content_entries.map((item) => contentEntry(item, derivedBytes.get(item.target)));
  for (const item of content_entries) assertNoRegisteredRoot(item.contents.toString("utf8"), roots, item.target);
  return { ...checked, entries: files.map((item) => ({ source: item.target, ...item })), files, manifest_hash: material_manifest_hash, delivery_manifest_hash: inner.delivery_manifest_hash,
    total_bytes: files.reduce((sum, item) => sum + item.size, 0), content_entries, raw_material_manifest_hash,
    material_representation: "sanitized", redaction: receipt(roots, counts, raw_material_manifest_hash, material_manifest_hash) };
}
