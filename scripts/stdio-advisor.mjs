import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const ENGINE_PRIORITY = ["claude", "codex", "kimi", "cursor", "opencode", "antigravity"];
const STDIO_TIMEOUT_MS = 10000;
const ENGINE_PROVIDER = new Map([
  ["claude", "anthropic"],
  ["codex", "openai"],
  ["kimi", "moonshot"],
  ["cursor", "cursor"],
  ["opencode", "opencode"],
  ["antigravity", "google"],
]);

export async function checkEngineAvailability({
  candidateEngine,
  hostEngine,
  round,
  omcPath,
  spawnFn = spawn,
}) {
  const base = {
    provider: candidateEngine?.provider,
    model: candidateEngine?.model,
    available: false,
  };

  if (!candidateEngine?.id) {
    return { ...base, skip_reason: "invalid_engine", error: "candidateEngine.id is required" };
  }
  if (candidateEngine.id === hostEngine) {
    return { ...base, skip_reason: "same_source" };
  }
  const hostProvider = ENGINE_PROVIDER.get(hostEngine);
  if (hostProvider && candidateEngine.provider === hostProvider) {
    return { ...base, skip_reason: "same_source_provider" };
  }
  if (!omcPath) {
    return { ...base, skip_reason: "omc_path_missing", error: "omcPath is required" };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timeoutFired = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timeoutFired = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already be gone.
      }
      settle({
        ...base,
        skip_reason: "timeout",
        error: `omc stdio query timed out after ${STDIO_TIMEOUT_MS}ms`,
      });
    }, STDIO_TIMEOUT_MS);

    let child;
    try {
      child = spawnFn(
        omcPath,
        [
          "stdio",
          "query",
          "--engine",
          candidateEngine.id,
          "--provider",
          candidateEngine.provider,
          "--model",
          candidateEngine.model,
          "--round",
          String(round ?? 1),
        ],
        { stdio: ["ignore", "pipe", "pipe"], shell: false },
      );
    } catch (error) {
      settle(classifyFailure(base, error, ""));
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settle(classifyFailure(base, error, stderr || stdout));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (timeoutFired || (code == null && signal === "SIGTERM")) {
        settle({
          ...base,
          skip_reason: "timeout",
          error: `omc stdio query timed out after ${STDIO_TIMEOUT_MS}ms`,
        });
        return;
      }
      settle(classifyResult(base, code, stdout, stderr));
    });
  });
}

export async function queryAvailableEngine({
  hostEngine,
  round,
  offlineEnginesPath,
  checkFn = checkEngineAvailability,
  omcPath = "omc",
}) {
  const offlineEngines = await loadOfflineEngines(offlineEnginesPath);
  const byId = new Map(offlineEngines.map((engine) => [engine.id, engine]));

  for (const engineId of ENGINE_PRIORITY) {
    if (engineId === hostEngine) continue;
    const candidateEngine = byId.get(engineId);
    if (!candidateEngine?.available) continue;

    const result = await checkFn({ candidateEngine, hostEngine, round, omcPath });
    if (result?.available === true) {
      return { engine: engineId };
    }
  }

  return { escalate: true };
}

async function loadOfflineEngines(offlineEnginesPath) {
  if (!offlineEnginesPath) {
    throw new Error("offlineEnginesPath is required");
  }

  const parsed = JSON.parse(await readFile(offlineEnginesPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("offline-engines.json must contain an array");
  }
  return parsed;
}

function classifyResult(base, code, stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  if (code !== 0) {
    const failure = classifyFailure(base, null, combined);
    if (failure.skip_reason) return failure;
    return {
      ...base,
      skip_reason: "nonzero_exit",
      error: combined.trim() || `omc exited with code ${code}`,
    };
  }

  const payload = parseJsonPayload(stdout);
  if (!payload) {
    return {
      ...base,
      skip_reason: "invalid_response",
      error: "omc stdio query did not return valid JSON",
    };
  }
  if (payload?.error) {
    return classifyFailure(base, new Error(String(payload.error)), String(payload.error));
  }

  return {
    provider: payload?.provider ?? base.provider,
    model: payload?.model ?? base.model,
    available: payload?.available === true,
    ...(payload?.available === true ? {} : { skip_reason: "unavailable" }),
  };
}

function classifyFailure(base, error, output) {
  const message = [error?.code, error?.message, output].filter(Boolean).join("\n");
  if (/ENOENT/.test(message)) {
    return { ...base, skip_reason: "spawn_enoent", error: message };
  }
  if (/MODULE_NOT_FOUND/.test(message)) {
    return { ...base, skip_reason: "module_not_found", error: message };
  }
  if (/action_not_supported/.test(message)) {
    return { ...base, skip_reason: "action_not_supported", error: message };
  }
  if (error) {
    return { ...base, skip_reason: "spawn_error", error: message || String(error) };
  }
  return { ...base };
}

function parseJsonPayload(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = jsonPayloadCandidates(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function jsonPayloadCandidates(text) {
  const candidates = [text];
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.startsWith("{") && line.endsWith("}")) {
      candidates.push(line);
    }
  }

  for (let start = text.length - 1; start >= 0; start -= 1) {
    if (text[start] !== "{") continue;
    const candidate = balancedObjectFrom(text, start);
    if (candidate) candidates.push(candidate);
  }

  return [...new Set(candidates)];
}

function balancedObjectFrom(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      if (depth < 0) return null;
    }
  }

  return null;
}
