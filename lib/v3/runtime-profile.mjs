import fs from "node:fs";
import path from "node:path";
import { canonicalConfigHash, ProtocolError } from "./protocol.mjs";

const KIMI_SYSTEM_PROMPT = [
  "You are a read-only independent reviewer.",
  "Review only the supplied package and return the requested final conclusion.",
  "Do not modify files, execute commands, access the network, delegate work, or use skills.",
].join("\n");

const OPENCODE_PROFILE = Object.freeze({
  "$schema": "https://opencode.ai/config.json",
  agent: {
    "third-review-readonly": {
      description: "Read-only review of supplied material",
      mode: "primary",
      permission: {
        "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow",
        edit: "deny", bash: "deny", task: "deny", external_directory: "deny",
        webfetch: "deny", websearch: "deny", lsp: "deny", skill: "deny",
        question: "deny", todowrite: "deny", doom_loop: "deny",
      },
    },
  },
});

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProtocolError("RUNTIME_UNAVAILABLE", "runtime profile path is not a private directory");
  fs.chmodSync(directory, 0o700);
  return directory;
}

function privateFile(file, contents) {
  try {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) {
      throw new ProtocolError("RUNTIME_UNAVAILABLE", "runtime profile file is not a private real file");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, contents, { encoding: "utf8" });
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    throw error instanceof ProtocolError ? error : new ProtocolError("RUNTIME_UNAVAILABLE", "runtime profile file cannot be safely written", { cause: error.code ?? error.message });
  } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* file was already persisted */ } }
  return file;
}

function writePackage(runtimePath, material) {
  const workspace = privateDirectory(path.join(runtimePath, "materials"));
  privateFile(path.join(workspace, "review-package.md"), material.text);
  return workspace;
}

function kimiProfile(runtimePath) {
  const directory = privateDirectory(path.join(runtimePath, "kimi"));
  const markdown = privateFile(path.join(directory, "reviewer.md"), `${KIMI_SYSTEM_PROMPT}\n`);
  const yaml = ["version: 1", "agent:", "  name: third-review-readonly", "  system_prompt_path: ./reviewer.md", "  tools:", "    - kimi_cli.tools.file:ReadFile", "    - kimi_cli.tools.file:Glob", "    - kimi_cli.tools.file:Grep", ""].join("\n");
  const agentFile = privateFile(path.join(directory, "reviewer.yaml"), yaml);
  return {
    profile_path: agentFile,
    skills_dir: privateDirectory(path.join(directory, "skills")),
    profile_hash: canonicalConfigHash({ provider: "kimi", yaml, system_prompt: KIMI_SYSTEM_PROMPT }).hash,
    files: [markdown, agentFile],
  };
}

function opencodeProfile(runtimePath) {
  const directory = privateDirectory(path.join(runtimePath, "opencode"));
  const config = `${JSON.stringify(OPENCODE_PROFILE)}\n`;
  const configFile = privateFile(path.join(directory, "opencode.json"), config);
  return {
    profile_name: "third-review-readonly",
    runtime_env: { OPENCODE_CONFIG: configFile, OPENCODE_DISABLE_CLAUDE_CODE: "1" },
    profile_hash: canonicalConfigHash({ provider: "opencode", config: OPENCODE_PROFILE }).hash,
    files: [configFile],
  };
}

/** Broker-owned, per-runtime read-only profile. Credentials stay in the native CLI home. */
export function prepareRuntimeProfile({ runtimeRoot, runtimeId, providerId, material }) {
  if (!path.isAbsolute(runtimeRoot) || typeof runtimeId !== "string" || typeof providerId !== "string" || typeof material?.text !== "string") {
    throw new ProtocolError("REQUEST_INVALID", "runtime profile requires runtime, provider, and material");
  }
  const runtimePath = privateDirectory(path.join(runtimeRoot, runtimeId));
  const workspace = writePackage(runtimePath, material);
  const provider = providerId === "kimi" ? kimiProfile(runtimePath) : providerId === "opencode" ? opencodeProfile(runtimePath) : {
    profile_hash: canonicalConfigHash({ provider: providerId, mode: "broker-owned-readonly-workspace" }).hash,
    files: [],
  };
  return { cwd: workspace, runtime_env: {}, ...provider };
}

export const __runtimeProfile = Object.freeze({ KIMI_SYSTEM_PROMPT, OPENCODE_PROFILE });
