import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.mjs";
import { fileOnlySandboxCapability, SYSTEM_FILE_ONLY_WRAPPER_ROOT } from "./config.mjs";

// A trusted wrapper must mount host workdir at provider_visible_root for both
// --3rd-review-run probes and real provider execution. The broker does not
// trust a wrapper JSON claim: it runs this probe through that exact run path.
export function verifyManagedWrapper(config, { root = SYSTEM_FILE_ONLY_WRAPPER_ROOT, owner = 0 } = {}) {
  if (!config || !fs.existsSync(config.command)) return false;
  try {
    const declaredRoot = path.resolve(root); const declaredCommand = path.resolve(config.command); const declaredRelative = path.relative(declaredRoot, declaredCommand);
    if (!declaredRelative || declaredRelative === ".." || declaredRelative.startsWith(`..${path.sep}`)) return false;
    let declaredCursor = declaredRoot;
    for (const part of declaredRelative.split(path.sep)) { declaredCursor = path.join(declaredCursor, part); const stat = fs.lstatSync(declaredCursor); if (stat.isSymbolicLink()) return false; }
    const managedRoot = fs.realpathSync(root); const configured = fs.realpathSync(config.command); const relative = path.relative(managedRoot, configured);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
    let cursor = managedRoot;
    for (const part of relative.split(path.sep).slice(0, -1)) { cursor = path.join(cursor, part); const stat = fs.lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o022) !== 0) return false; }
    const rootStat = fs.lstatSync(managedRoot); const stat = fs.lstatSync(configured);
    return rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === owner && (rootStat.mode & 0o022) === 0 && stat.isFile() && !stat.isSymbolicLink() && stat.uid === owner && (stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0 && createHash("sha256").update(fs.readFileSync(configured)).digest("hex") === config.sha256;
  } catch { return false; }
}
function probeProgram() {
  return `import fs from "node:fs";\nconst readable=(p)=>{try{fs.readFileSync(p);return true}catch{return false}};const [marker,...hostTargets]=process.argv.slice(2);console.log(JSON.stringify({version:1,marker_readable:readable(marker),host_targets_readable:hostTargets.map(readable)}));\n`;
}
function probe(config, requestedBundle = null, requestedWorkdir = null) {
  if (!verifyManagedWrapper(config)) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "3rd-review-sandbox-probe-")); const workdir = requestedWorkdir ?? root; const bundle = requestedBundle ?? path.join(workdir, "bundle"); const ownWorkdir = !requestedWorkdir;
  const sentinels = [path.join(root, "host-sentinel-a"), path.join(root, "host-sentinel-b")]; const driver = path.join(workdir, `.3rd-review-sandbox-probe-${randomUUID()}.mjs`);
  try {
    if (ownWorkdir) { fs.mkdirSync(bundle, { mode: 0o700 }); fs.writeFileSync(path.join(bundle, "attachment-probe.txt"), "provider-visible", { mode: 0o400 }); }
    const marker = requestedBundle ? (fs.existsSync(path.join(bundle, "review-packet.v1.json")) ? path.join(bundle, "review-packet.v1.json") : path.join(bundle, "attachment-probe.txt")) : path.join(bundle, "attachment-probe.txt");
    if (!fs.existsSync(marker)) return false;
    for (const file of sentinels) fs.writeFileSync(file, "host-only", { mode: 0o600 });
    fs.writeFileSync(driver, probeProgram(), { mode: 0o600, flag: "wx" });
    const virtual = config.provider_visible_root; const virtualPath = (host) => `${virtual}/${path.relative(workdir, host).split(path.sep).join("/")}`;
    const result = spawnSync(config.command, [...config.args, "--3rd-review-run", `--bundle=${bundle}`, `--workdir=${workdir}`, `--provider-visible-root=${virtual}`, "--", process.execPath, virtualPath(driver), virtualPath(marker), ...sentinels, process.cwd()], { encoding: "utf8", timeout: 5_000, cwd: workdir });
    const value = JSON.parse(result.stdout || "{}");
    return result.status === 0 && value?.version === 1 && value.marker_readable === true && Array.isArray(value.host_targets_readable) && value.host_targets_readable.length === 3 && value.host_targets_readable.every((readable) => readable === false);
  } catch { return false; } finally {
    try { if (fs.existsSync(driver)) fs.rmSync(driver, { force: true }); if (ownWorkdir) fs.rmSync(root, { recursive: true, force: true }); else fs.rmSync(root, { recursive: true, force: true }); } catch { /* probe cleanup does not change verdict */ }
  }
}
export function hasConfiguredFileOnlySandbox(config, bundle = null, workdir = null) { return probe(fileOnlySandboxCapability(config), bundle, workdir); }
export function fileOnlySandboxProbe() { return { ready: false, reason: "NO_VERIFIED_FILE_ONLY_SANDBOX_WRAPPER" }; }
export function requireFileOnlySandbox(config, plan, bundle, workdir) {
  if (!hasConfiguredFileOnlySandbox(config, bundle, workdir)) fail("ATTACHMENT_SANDBOX_UNAVAILABLE", "NO_VERIFIED_FILE_ONLY_SANDBOX_WRAPPER");
  const sandbox = fileOnlySandboxCapability(config); const virtual = sandbox?.provider_visible_root;
  if (!sandbox) fail("ATTACHMENT_SANDBOX_UNAVAILABLE", "NO_VERIFIED_FILE_ONLY_SANDBOX_WRAPPER");
  const replace = (value) => typeof value === "string" && (value === workdir || value.startsWith(`${workdir}${path.sep}`)) ? `${virtual}${value.slice(workdir.length).split(path.sep).join("/")}` : value;
  return { ...plan, command: sandbox.command, argv: [...sandbox.args, "--3rd-review-run", `--bundle=${bundle}`, `--workdir=${workdir}`, `--provider-visible-root=${virtual}`, "--", plan.command, ...plan.argv.map(replace)], env: Object.fromEntries(Object.entries(plan.env ?? {}).map(([key, value]) => [key, replace(value)])), beforeSpawn: () => { if (!verifyManagedWrapper(sandbox)) fail("ATTACHMENT_SANDBOX_UNAVAILABLE", "FILE_ONLY_SANDBOX_WRAPPER_CHANGED"); } };
}
