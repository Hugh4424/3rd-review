export const SUPPORTED_PROVIDER_IDS = Object.freeze([
  "claude-code",
  "codex",
  "kimi",
  "opencode",
  "antigravity",
  "pi",
]);

const supported = new Set(SUPPORTED_PROVIDER_IDS);

export function isSupportedProviderId(value) {
  return typeof value === "string" && supported.has(value);
}
