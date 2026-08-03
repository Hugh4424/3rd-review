import { fail } from "../errors.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalid, nonempty, plan, restrictedFiles, writeFile } from "./shared.mjs";

const reviewInstruction = "Review only the supplied instruction and the hash-verified frozen files under bundle/ when present. Stay read-only. For file_only material, use only the third-review-bundle MCP server's list_bundle and read_bundle tools. When the instruction ships no attached material, it is complete on its own: answer from its text alone and call no tools at all, treating any path or path:line it mentions as literal text rather than something to open. Do not use native file reads, shell, network, web, other MCP servers, plugins, subagents, or other files. Return exactly the requested final response as visible assistant text.";
// A prompt-only review carries no bundle, so every tool call is by definition
// outside the scoped review bundle and supervision denies it. Review prose is
// dense with `path:line` citations, which is exactly the shape that makes the
// agent reach for a read tool. The broker cannot rely on the caller prefixing
// its own "do not read files" text, so the adapter states the constraint
// itself on the prompt-only path.
const promptOnlyConstraint = "TEXT-ONLY REVIEW. No files are attached to this request and no bundle exists, so there is nothing to open. Do not call any tool: no file reads, no listing, no search, no shell, no MCP calls, not even to check whether a path exists. Every `path`, `path:line`, and `path:line:col` below is literal quoted text supplied for your reference, not an instruction to open that file. Answer entirely from the text of this message and reply with the requested review as visible assistant text.";
// Escalation used only after supervision denied a prompt-only tool call. It
// repeats the same rule in stronger, more explicit terms; it never grants any
// capability, so a denied file_only run can never be laundered through it.
const promptOnlyEscalation = "STOP. Your previous attempt at this review was terminated because you tried to call a tool. This request has no attached files, no bundle, and no readable tool of any kind — every tool call will be killed again. You must produce the entire review from the message text alone, on your first response, with zero tool calls. Treat all file paths and `path:line` references as literal strings that were pasted for you to reason about; they are not openable and their contents are not available. Write the requested review now as plain assistant text.";
const projectConfig = Object.freeze({
  permissions: {
    allow: ["Mcp(third-review-bundle:*)"],
    deny: [
      "Read(**)", "Write(**)", "Shell(*)", "WebFetch(*)",
    ],
  },
});
const isolatedCliConfig = Object.freeze({
  version: 1,
  ...projectConfig,
  approvalMode: "unrestricted",
  autoAcceptWebSearch: false,
  sandbox: { mode: "enabled", networkAccess: "user_config_with_defaults" },
});
const bundleServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "cursor-bundle-mcp.mjs");

function parse(stdout, _stderr = "", expectedSession = null) {
  let session_id = null; let terminal = null; let initialized = false;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); }
    catch { return invalid("Cursor Agent emitted malformed stream JSON"); }
    if (terminal) return invalid("Cursor Agent emitted events after its terminal result");
    const observedSession = nonempty(value.session_id);
    if (observedSession && session_id && observedSession !== session_id) return invalid("Cursor Agent changed session identity during the turn");
    session_id ??= observedSession;
    initialized ||= value.type === "system" && value.subtype === "init";
    if (value.type === "result") {
      if (terminal) return invalid("Cursor Agent emitted multiple terminal result events");
      terminal = value;
    }
  }
  if (!session_id) return invalid("Cursor Agent emitted no session id");
  if (!initialized) return invalid("Cursor Agent emitted no initialization event");
  if (expectedSession && session_id !== expectedSession) return invalid("Cursor Agent did not preserve the requested continuation session");
  if (!terminal || terminal.subtype !== "success" || terminal.is_error === true) return invalid("Cursor Agent emitted no successful terminal result");
  const text = nonempty(terminal.result);
  return text ? { ok: true, text, session_id, usage: terminal.usage ?? null } : invalid("Cursor Agent emitted no final assistant text");
}

function permissionDenied(session_id) {
  return {
    liveness: true, progress: false, event: "tool_call", session_id,
    terminal: {
      state: "failed", session_id,
      error: { code: "PROVIDER_PERMISSION_DENIED", message: "Cursor Agent attempted a tool outside the scoped review bundle" },
    },
  };
}

function scopedSpillPath(filePath, cursorData) {
  if (!nonempty(filePath) || !path.isAbsolute(filePath) || !nonempty(cursorData)) return null;
  try {
    const root = fs.realpathSync(cursorData);
    const resolved = path.resolve(filePath);
    const real = fs.realpathSync(resolved);
    const relative = path.relative(root, real);
    // Compare canonical paths so `/tmp` and `/private/tmp` spellings remain
    // equivalent on macOS. A symlink that resolves outside cursor-data fails
    // the relative-root check below.
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    if (!relative.split(path.sep).includes("agent-tools") || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

function spillOutputPaths(value) {
  const content = value.tool_call?.mcpToolCall?.result?.success?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const filePath = item?.text?.outputLocation?.filePath;
    return typeof filePath === "string" && filePath.trim() ? [filePath] : [];
  });
}

function admittedMcpCall(call) {
  const discovery = call.getMcpToolsToolCall?.args;
  if (discovery
    && discovery.server === "third-review-bundle"
    && (discovery.toolName === undefined || ["list_bundle", "read_bundle"].includes(discovery.toolName))) {
    return { kind: discovery.toolName === undefined ? "mcp-discovery" : discovery.toolName };
  }
  const mcp = call.mcpToolCall?.args;
  if (mcp
    && mcp.serverIdentifier === "third-review-bundle"
    && mcp.providerIdentifier === "third-review-bundle"
    && ["list_bundle", "read_bundle"].includes(mcp.toolName)) {
    return { kind: mcp.toolName };
  }
  return null;
}

function observeLine(stream, line, scope = null) {
  if (stream !== "stdout") return { progress: false };
  try {
    const value = JSON.parse(line); const session_id = nonempty(value.session_id);
    if (value.type === "interaction_query" && value.subtype === "request") return permissionDenied(session_id);
    if (value.type === "tool_call" && ["started", "completed"].includes(value.subtype)) {
      const call = value.tool_call ?? {};
      const callId = nonempty(value.call_id);
      if (!callId) return permissionDenied(session_id);
      // The `started` event carries the authoritative target identity. Cursor
      // may omit those arguments from `completed`, so pair by call_id rather
      // than re-deriving admission from the completion event.
      if (value.subtype === "started") {
        const mcpAdmission = admittedMcpCall(call);
        if (mcpAdmission) scope?.calls?.set(callId, mcpAdmission);
        else {
          // Cursor spills large MCP results to its isolated agent-tools
          // directory and then asks its native Read tool to fetch that exact
          // file. This is an internal transport step, not a new host-file
          // read. Admit only paths previously returned by read_bundle, after
          // realpath-checking them below the current isolated cursor-data.
          const requestedPath = call.readToolCall?.args?.path;
          const spillPath = scopedSpillPath(requestedPath, scope?.cursorData);
          if (!spillPath || !scope?.spillPaths?.has(spillPath)) return permissionDenied(session_id);
          scope.calls?.set(callId, { kind: "spill-read", path: spillPath });
        }
      } else {
        const admission = scope?.calls?.get(callId);
        if (!admission) return permissionDenied(session_id);
        if (admission.kind === "spill-read") {
          const completedPath = call.readToolCall?.args?.path;
          if (completedPath !== undefined && scopedSpillPath(completedPath, scope.cursorData) !== admission.path) return permissionDenied(session_id);
        }
        scope.calls.delete(callId);
        if (admission.kind === "read_bundle") {
          for (const filePath of spillOutputPaths(value)) {
            const spillPath = scopedSpillPath(filePath, scope.cursorData);
            if (spillPath) scope.spillPaths?.add(spillPath);
          }
        }
      }
    }
    if (value.type === "result") {
      const completed = value.subtype === "success" && value.is_error !== true && nonempty(value.result);
      return {
        liveness: true, progress: true, event: value.type, session_id,
        terminal: completed
          ? { state: "completed", session_id }
          : { state: "failed", session_id, error: { code: "PROVIDER_HEALTH_FAILED", message: "Cursor Agent returned a terminal error" } },
      };
    }
    if (value.type === "retry" && value.subtype === "starting") return { liveness: true, progress: true, retry_count: 1, event: "retry", session_id };
    if (["system", "user", "connection", "status", "heartbeat"].includes(value.type)) return { liveness: true, progress: false, event: value.type, session_id };
    return { liveness: true, progress: true, event: value.type ?? "json", session_id };
  } catch { return { progress: false }; }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function ensureKeychainLink(home) {
  const source = path.join(process.env.HOME ?? "", "Library", "Keychains", "login.keychain-db");
  if (!path.isAbsolute(source) || !fs.existsSync(source)) fail("RUNTIME_UNAVAILABLE", "Cursor native authentication requires the macOS login keychain");
  const directory = ensureDirectory(path.join(home, "Library", "Keychains"));
  const target = path.join(directory, "login.keychain-db");
  let existing = false;
  try { fs.lstatSync(target); existing = true; } catch {}
  if (existing) {
    let matches = false;
    try { matches = fs.realpathSync(target) === fs.realpathSync(source); } catch {}
    if (!matches) fail("RUNTIME_UNAVAILABLE", "Cursor isolated keychain link has an unexpected target");
    return target;
  }
  try { fs.symlinkSync(source, target); }
  catch (error) { fail("RUNTIME_UNAVAILABLE", `cannot create Cursor isolated keychain link: ${error.message}`); }
  return target;
}

function isolatedEnvironment(runtime, provider) {
  if (!runtime) fail("RUNTIME_UNAVAILABLE", "Cursor Agent requires a stable broker runtime directory");
  const root = restrictedFiles(runtime, provider);
  const home = ensureDirectory(path.join(root, "home"));
  if (provider.auth?.type !== "env") ensureKeychainLink(home);
  const config = ensureDirectory(path.join(root, "xdg-config"));
  const cache = ensureDirectory(path.join(root, "xdg-cache"));
  const data = ensureDirectory(path.join(root, "xdg-data"));
  const cursorConfig = ensureDirectory(path.join(root, "cursor-config"));
  const cursorData = ensureDirectory(path.join(root, "cursor-data"));
  const cliConfig = `${JSON.stringify(isolatedCliConfig, null, 2)}\n`;
  writeFile(path.join(ensureDirectory(path.join(config, "cursor")), "cli-config.json"), cliConfig);
  writeFile(path.join(cursorConfig, "cli-config.json"), cliConfig);
  return {
    cursorData,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      CURSOR_CONFIG_DIR: cursorConfig,
      CURSOR_DATA_DIR: cursorData,
    },
  };
}

function executionPlan(provider, cwd, prompt, runtime, session = null, { escalatePromptOnly = false } = {}) {
  if (!provider.allow_host_state) fail("PROVIDER_HOST_STATE_UNACKNOWLEDGED", "Cursor Agent persists prompts and conversations in its native profile; set allow_host_state=true only for trusted material");
  if (provider.effort) fail("PROVIDER_OPTION_UNSUPPORTED", "Cursor Agent does not support generic provider.effort; select the required model variant instead");
  if (provider.thinking === false) fail("PROVIDER_OPTION_UNSUPPORTED", "Cursor Agent thinking is controlled by the selected model variant");
  const isolated = isolatedEnvironment(runtime, provider);
  const hasBundle = fs.existsSync(path.join(cwd, "bundle"));
  const bundle = hasBundle
    ? path.join(cwd, "bundle")
    : ensureDirectory(path.join(isolated.cursorData, "empty-bundle"));
  const configDir = path.join(cwd, ".cursor");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFile(path.join(configDir, "cli.json"), `${JSON.stringify(projectConfig, null, 2)}\n`);
  writeFile(path.join(configDir, "mcp.json"), `${JSON.stringify({
    mcpServers: {
      "third-review-bundle": {
        command: process.execPath,
        args: [bundleServer, bundle],
      },
    },
  }, null, 2)}\n`);
  const argv = [
    "-p", "--trust", "--workspace", cwd, "--output-format", "stream-json",
    "--sandbox", "enabled", "--disable-indexing", "--disable-codebase-ref",
    "--approve-mcps",
    "--data-dir", isolated.cursorData,
  ];
  // `ask` is the CLI's read-only Q&A mode. There is no native "no tools at
  // all" switch, so this only narrows the surface; the prompt constraint and
  // stream supervision remain the actual guarantee. It is applied only when no
  // bundle exists, so file_only reviews keep their unchanged tool surface.
  if (!hasBundle) argv.push("--mode", "ask");
  if (provider.model) argv.push("--model", provider.model);
  if (session) argv.push("--resume", session);
  const scope = { calls: new Map(), spillPaths: new Set(), cursorData: isolated.cursorData };
  // The prompt-only constraint is prepended by the adapter rather than trusted
  // to the caller, and the escalation replaces it verbatim on the one retry.
  const providerPrompt = hasBundle
    ? prompt
    : `${escalatePromptOnly ? promptOnlyEscalation : promptOnlyConstraint}\n\n${prompt}`;
  return {
    ...plan(provider, cwd, argv, providerPrompt, isolated.env),
    clientArgv: argv, expectedSession: session,
    // Declares to the broker that this exact run may be retried once with a
    // hardened prompt when supervision denied a tool call. Only prompt-only
    // runs carry it, so a file_only permission denial stays terminal.
    ...(hasBundle || escalatePromptOnly ? {} : { promptOnlyRetry: true }),
    observeLine: (stream, line) => observeLine(stream, line, scope),
  };
}

export default {
  capabilities: { continuation: true, attachment_delivery: ["file_only", "always_embed"] },
  modelInstruction: reviewInstruction,
  promptViaStdin: true,
  requiresWritableCwd: true,
  stableContinuationCwd: true,
  runFromWritableRoot: true,
  doctor: (provider, cwd) => plan(provider, cwd, ["--version"], null),
  start: (provider, cwd, prompt, runtime) => executionPlan(provider, cwd, prompt, runtime),
  resume: (provider, cwd, session, prompt, runtime) => executionPlan(provider, cwd, prompt, runtime, session),
  // A denied prompt-only attempt is retried once as a brand new turn, never as
  // a resume: the previous session was killed mid-tool-call, so its native
  // state is not a sound base to continue from.
  retryPromptOnly: (provider, cwd, prompt, runtime) => executionPlan(provider, cwd, prompt, runtime, null, { escalatePromptOnly: true }),
  parse,
  observeLine,
};
