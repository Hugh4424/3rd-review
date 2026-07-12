import { ProtocolError } from "./protocol.mjs";

function failure(id, error) {
  return { id, status: "failed", execution_eligible: false, session_id: null, error_code: error, persisted: true };
}

function validateTier(forceTier, count) {
  if (forceTier === null || forceTier === undefined) return null;
  if (!Number.isSafeInteger(forceTier) || forceTier < 0 || forceTier >= count) throw new ProtocolError("REQUEST_INVALID", "force_tier is outside configured tiers");
  return forceTier;
}

export async function routeProviders({ config, host_provider = null, host_verified = true, force_tier = null, execute }) {
  if (!config?.config?.tiers || typeof execute !== "function") throw new TypeError("validated config and execute are required");
  const forced = validateTier(force_tier, config.config.tiers.length);
  const start = forced ?? 0;
  const end = forced ?? config.config.tiers.length - 1;
  const providers = [];
  for (let tierIndex = start; tierIndex <= end; tierIndex += 1) {
    const selected = config.config.tiers[tierIndex];
    const pending = selected.map(async (id) => {
      const provider = config.config.providers[id];
      if (!provider.enabled) return { id, status: "skipped", execution_eligible: false, session_id: null, error_code: "PROVIDER_DISABLED", persisted: true };
      if (host_verified && host_provider && id === host_provider) return { id, status: "skipped", execution_eligible: false, session_id: null, error_code: "SAME_SOURCE", persisted: true };
      try {
        const result = await execute({ id, ...provider, tier: tierIndex });
        const transportEligible = result?.execution_eligible === true;
        const eligible = transportEligible && host_verified;
        return {
          ...result,
          id,
          status: transportEligible ? "completed" : "failed",
          execution_eligible: eligible,
          session_id: eligible && typeof result?.session_id === "string" ? result.session_id : null,
          error_code: eligible ? null : (transportEligible ? "HOST_UNKNOWN" : (typeof result?.error_code === "string" ? result.error_code : "PROVIDER_PROTOCOL_INCOMPLETE")),
          persisted: result?.persisted !== false,
        };
      } catch (error) {
        return failure(id, error instanceof ProtocolError ? error.code : "ADAPTER_FAILED");
      }
    });
    const tierResults = await Promise.all(pending);
    providers.push(...tierResults);
    if (tierResults.some((entry) => entry.execution_eligible)) return { selected_tier: tierIndex, stop_reason: "execution_eligible", providers };
  }
  const anyEligibleTransport = providers.some((entry) => entry.status === "completed" && entry.error_code === "HOST_UNKNOWN");
  const executed = providers.some((entry) => entry.status !== "skipped");
  return { selected_tier: forced ?? end, stop_reason: anyEligibleTransport || !executed ? "no_eligible" : "all_failed", providers };
}
