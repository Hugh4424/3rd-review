import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const NORMALIZED_ENGINES = new Set([
  "claude",
  "codex",
  "kimi",
  "cursor",
  "opencode",
  "antigravity",
]);

const DETECT_AGENT_MAP = new Map([
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["anthropic", "claude"],
  ["codex", "codex"],
  ["openai", "codex"],
  ["kimi", "kimi"],
  ["moonshot", "kimi"],
  ["cursor", "cursor"],
  ["opencode", "opencode"],
  ["open-code", "opencode"],
  ["antigravity", "antigravity"],
]);

export async function detectHost(sessionStatePath) {
  if (!sessionStatePath) {
    throw new Error("sessionStatePath is required");
  }

  const isTestMode = process.env.NODE_ENV === "test" || process.env.REVIEW_TEST_MODE === "1";
  const rawOverride = process.env.HOST_ENGINE_OVERRIDE;
  const hasTestOverride = isTestMode && typeof rawOverride === "string" && rawOverride.trim() !== "";
  const overrideHost = hasTestOverride ? normalizeEngineId(rawOverride) : null;
  const cached = await readSessionState(sessionStatePath);
  if (cached) {
    if (!hasTestOverride) return cached;
    if (overrideHost && cached === overrideHost) return cached;
  }

  let hostEngine = null;
  if (isTestMode) {
    hostEngine = overrideHost;
  } else {
    hostEngine = await detectWithVercelAgent();
    if (!hostEngine) hostEngine = detectFromProcessName();
  }

  if (!hostEngine) {
    throw new Error(
      "Unable to detect host engine. Supported engines: " +
        [...NORMALIZED_ENGINES].join(", ") +
        ". In tests, set HOST_ENGINE_OVERRIDE with NODE_ENV=test or REVIEW_TEST_MODE=1.",
    );
  }

  await mkdir(dirname(sessionStatePath), { recursive: true });
  await writeFile(
    sessionStatePath,
    JSON.stringify({ host_engine: hostEngine, detected_at: new Date().toISOString() }, null, 2),
  );
  return hostEngine;
}

async function readSessionState(sessionStatePath) {
  try {
    const state = JSON.parse(await readFile(sessionStatePath, "utf8"));
    if (typeof state.host_engine !== "string" || !state.host_engine) {
      throw new Error("session-state.json missing host_engine");
    }
    const hostEngine = state.host_engine.trim().toLowerCase();
    if (!NORMALIZED_ENGINES.has(hostEngine)) {
      throw new Error(`Invalid cached host_engine in session-state.json: ${state.host_engine}`);
    }
    return hostEngine;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function detectWithVercelAgent() {
  let mod;
  try {
    mod = await import("@vercel/detect-agent");
  } catch {
    return null;
  }

  const detector =
    mod.detectAgent ??
    mod.detectCurrentAgent ??
    mod.getAgent ??
    mod.default;

  if (typeof detector !== "function") return null;

  try {
    const detected = await detector();
    return normalizeDetectedAgent(detected);
  } catch {
    return null;
  }
}

function normalizeDetectedAgent(detected) {
  if (typeof detected === "string") {
    return normalizeEngineId(detected);
  }
  if (detected && typeof detected === "object") {
    return normalizeEngineId(
      detected.id ??
        detected.agent ??
        detected.name ??
        detected.provider ??
        detected.type,
    );
  }
  return null;
}

function detectFromProcessName() {
  const rawParts = [
    process.env.npm_lifecycle_event,
    process.env._,
    process.title,
    ...process.argv,
  ].filter(Boolean);

  const names = rawParts.map((part) => {
    const normalized = part.toLowerCase();
    const lastSegment = normalized.split(/[\\/]/).pop() ?? normalized;
    return lastSegment.replace(/\.(m?js|cjs|ts|tsx|jsx|sh|cmd|exe)$/i, "");
  });

  for (const engine of NORMALIZED_ENGINES) {
    if (names.includes(engine)) return engine;
  }
  if (names.includes("claude-code")) return "claude";
  if (names.includes("open-code")) return "opencode";
  return null;
}

function normalizeEngineId(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (!key || key === "unknown") return null;
  if (NORMALIZED_ENGINES.has(key)) return key;
  return DETECT_AGENT_MAP.get(key) ?? null;
}
