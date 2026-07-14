import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalDeliveryManifestHash, canonicalInnerManifestHash, canonicalMaterialManifestHash, canonicalPacketHash, prepareCheckedAttachments, validateAttachments, validateFileOnlyTriad } from "../lib/attachments.mjs";
import { MATERIAL_REDACTION_RULE_VERSION, deriveProviderMaterial, prepareSensitiveRoots } from "../lib/material-redaction.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "derived-material-"));

function source({ delivery = "file_only", diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n", packetExtra = {}, asset = null, continuation = null, innerExtra = {} } = {}) {
  const root = temp(); const embed = delivery === "always_embed";
  const files = [["changes.diff", diff], ["skills/review/SKILL.md", asset ?? "review only the attached material"]];
  const preliminary = files.map(([target, value]) => ({ target, sha256: sha(value), size: Buffer.byteLength(value), embed }));
  const manifestHash = canonicalMaterialManifestHash("raw-bundle", preliminary);
  const packet = { version: "review-packet.v1", unified_diff: diff, manifest_hash: manifestHash, diff_sha256: sha(diff), ...packetExtra };
  packet.packet_hash = canonicalPacketHash(packet); files.push(["review-packet.v1.json", `${JSON.stringify(packet)}\n`]);
  for (const [name, value] of files) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value); }
  const attachments = files.map(([destination, value]) => ({ destination, sha256: sha(value), size: Buffer.byteLength(value) }));
  const outer = attachments.map(({ destination: target, sha256, size }) => ({ target, sha256, size, embed }));
  const inner = { version: "review-attachment-manifest.v1", delivery_mode: delivery, packet_hash: packet.packet_hash, manifest_hash: manifestHash, diff_sha256: packet.diff_sha256, attachments, delivery_manifest_hash: canonicalDeliveryManifestHash("raw-bundle", outer, delivery), ...(continuation ? { continuation } : {}), ...innerExtra };
  inner.inner_manifest_hash = canonicalInnerManifestHash(inner); fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(inner)}\n`);
  const all = [...outer, { target: "manifest.json", sha256: sha(fs.readFileSync(path.join(root, "manifest.json"))), size: fs.statSync(path.join(root, "manifest.json")).size, embed }];
  const manifest = { version: 1, bundle_id: "raw-bundle", entries: all.map(({ target, ...entry }) => ({ source: target, destination: target, ...entry })) };
  const checked = validateAttachments({ root, delivery, manifest }, 4 * 1024 * 1024, [{ root, sources: all.map(({ target }) => target) }]); validateFileOnlyTriad(checked); return checked;
}
const roots = (...groups) => groups.map(([root_id, ...values]) => ({ root_id, values }));

test("replaces registered roots across diff, packet, and assets and rebuilds the triad", () => {
  const host = temp(); const literal = `${host}/My Project/🔒secret.md`;
  const checked = source({ diff: `-${literal}\n+key=${literal}\n`, packetExtra: { [literal]: `read ${literal}` }, asset: `contract: ${literal}` });
  const first = deriveProviderMaterial(checked, null, roots(["home", host])); const second = deriveProviderMaterial(checked, null, roots(["home", host]));
  const visible = first.content_entries.map((item) => item.contents.toString()).join("\n");
  assert.equal(visible.includes(host), false); assert.match(visible, /\[PRIVATE_ROOT_HOME\]\/My Project\/🔒secret\.md/);
  assert.equal(first.material_representation, "sanitized"); assert.equal(first.manifest_hash, second.manifest_hash); validateFileOnlyTriad(first);
  assert.match(first.redaction.root_set_hash, /^[a-f0-9]{64}$/u);
  assert.deepEqual({ ...first.redaction, root_set_hash: "stable" }, { rule_version: MATERIAL_REDACTION_RULE_VERSION, root_set_hash: "stable", roots: [{ root_id: "home", token: "[PRIVATE_ROOT_HOME]", count: 7 }], replacement_count: 7, raw_material_manifest_hash: checked.manifest_hash, derived_material_manifest_hash: first.manifest_hash, residual_scan: "passed" });
});

test("uses one token for lexical and realpath aliases", (t) => {
  const parent = temp(); const actual = path.join(parent, "actual"); const alias = path.join(parent, "alias"); fs.mkdirSync(actual); fs.symlinkSync(actual, alias); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const derived = deriveProviderMaterial(source({ diff: `+${alias}/a.md\n+${actual}/b.md\n` }), null, roots(["worktree", alias, actual]));
  const diff = derived.content_entries.find((item) => item.target === "changes.diff").contents.toString();
  assert.equal(diff, "+[PRIVATE_ROOT_WORKTREE]/a.md\n+[PRIVATE_ROOT_WORKTREE]/b.md\n"); assert.equal(derived.redaction.roots[0].count, 4);
});

test("longest overlapping root wins and prefix boundary prevents false matches", () => {
  const parent = temp(); const nested = path.join(parent, "repo"); fs.mkdirSync(nested);
  const derived = deriveProviderMaterial(source({ diff: `+${nested}/a\n+${parent}/b\n+${parent}bert/c\n` }), null, roots(["home", parent], ["worktree", nested]));
  const diff = derived.content_entries.find((item) => item.target === "changes.diff").contents.toString();
  assert.match(diff, /^\+\[PRIVATE_ROOT_WORKTREE\]\/a$/m); assert.match(diff, /^\+\[PRIVATE_ROOT_HOME\]\/b$/m); assert.match(diff, new RegExp(`^\\+${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}bert/c$`, "m"));
});

for (const dangerous of ["", "/", "C:\\", "\\\\server\\share", "relative/root", "/safe/../broad"]) test(`rejects dangerous root ${JSON.stringify(dangerous)}`, () => {
  assert.throws(() => prepareSensitiveRoots(roots(["danger", dangerous])), { code: "MATERIAL_INCOMPLETE" });
});

test("does not interpret unregistered absolute-looking source syntax", () => {
  const diff = ["+assert.match(diff, /^--- \\/dev\\/null$/m);", "+//server/share/private", "+C:\\unregistered\\path", "+/dev/null"].join("\n");
  const derived = deriveProviderMaterial(source({ diff }), null, roots(["home", temp()]));
  assert.equal(derived.content_entries.find((item) => item.target === "changes.diff").contents.toString(), diff);
  assert.equal(derived.material_representation, "raw");
});

test("dogfood source fixtures derive without parsing their syntax", () => {
  const host = temp(); const diff = [
    `+  ["quoted path", "${host}/My Project"],`,
    '+  ["network fixture", "//server/share/private"],',
    '+  assert.throws(() => source({ diff: "+//server\\n" }));',
    '+  assert.match(diff, /^--- \\/dev\\/null$/m);',
  ].join("\n");
  const derived = deriveProviderMaterial(source({ diff }), null, roots(["home", host])); const visible = derived.content_entries.map((item) => item.contents.toString()).join("\n");
  assert.equal(visible.includes(host), false); assert.equal(visible.includes("/^--- \\/dev\\/null$/m"), true); assert.equal(visible.includes("//server/share/private"), true); validateFileOnlyTriad(derived);
});

test("fails closed when root replacement collapses JSON keys", () => {
  const first = temp(); const second = temp();
  assert.throws(() => deriveProviderMaterial(source({ packetExtra: { [`${first}/same`]: 1, [`${second}/same`]: 2 } }), null, roots(["secret", first, second])), { code: "MATERIAL_INCOMPLETE" });
});

test("keeps clean raw material byte-identical and records scan evidence", () => {
  const checked = source(); const derived = deriveProviderMaterial(checked, null, roots(["home", temp()]));
  assert.equal(derived.material_representation, "raw"); assert.deepEqual(derived.files, checked.files); assert.deepEqual(derived.content_entries.map((item) => item.contents), checked.content_entries.map((item) => item.contents));
  assert.equal(derived.redaction.raw_material_manifest_hash, checked.manifest_hash); assert.equal(derived.redaction.derived_material_manifest_hash, checked.manifest_hash); assert.equal(derived.redaction.residual_scan, "passed");
});

test("freezes the already-validated bytes when the source changes after validation", () => {
  const checked = source(); const original = checked.content_entries.find((item) => item.target === "changes.diff").contents;
  fs.writeFileSync(path.join(checked.root, "changes.diff"), "MUTATED AFTER VALIDATION"); const frozen = prepareCheckedAttachments(checked, temp(), "raw-opencode");
  assert.deepEqual(fs.readFileSync(path.join(frozen.cwd, "changes.diff")), original);
});

test("rebinds a derived continuation to the derived initial chain", () => {
  const host = temp(); const redactionRoots = roots(["home", host]);
  const rawInitial = source({ diff: `+${host}/r1\n` }); const initial = deriveProviderMaterial(rawInitial, null, redactionRoots);
  const rawDelta = source({ diff: `+${host}/r2\n`, continuation: { initial_material_manifest_hash: rawInitial.manifest_hash, sequence: 1, previous_delivery_manifest_hash: null } });
  const delta = deriveProviderMaterial(rawDelta, { initial_material_manifest_hash: initial.manifest_hash, previous_delivery_manifest_hash: null, rule_version: MATERIAL_REDACTION_RULE_VERSION }, redactionRoots);
  const inner = JSON.parse(delta.content_entries.find((item) => item.target === "manifest.json").contents); assert.equal(inner.continuation.initial_material_manifest_hash, initial.manifest_hash); validateFileOnlyTriad(delta);
});

test("rejects continuation material derived with a different rule version", () => {
  assert.throws(() => deriveProviderMaterial(source(), { rule_version: "host-root-prefix.v0" }, roots(["home", temp()])), { code: "MATERIAL_INCOMPLETE" });
});

test("rejects continuation material with a different frozen root fingerprint", () => {
  assert.throws(() => deriveProviderMaterial(source(), { rule_version: MATERIAL_REDACTION_RULE_VERSION, root_set_hash: "0".repeat(64) }, roots(["home", temp()])), { code: "MATERIAL_INCOMPLETE" });
});
