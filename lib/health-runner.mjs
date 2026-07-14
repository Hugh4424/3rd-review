const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
const states = new Set(["progressing", "busy", "retry", "completed", "failed", "dead", "unverifiable"]);
const failure = (code, message, evidence = null) => ({ status: "failed", error: { code, message }, evidence });

export function createHealthRunner({ probeSession = null, intervalMs = 60_000, probeDeadlineMs = 5_000, probeAbortGraceMs = 50, clock = realClock, isCancelled = () => false, validateCompleted = () => true, onDecision = () => {} } = {}) {
  let timer = null; let deadline = null; let activeProbe = null; let stopped = false; let generation = 0; let cursor = null; let session_id = null; let unverifiable = 0; let fallbackGeneration = 0;
  const clear = () => { if (timer !== null) clock.clearTimeout(timer); if (deadline !== null) clock.clearTimeout(deadline); timer = null; deadline = null; activeProbe?.abortAndSettle(); activeProbe = null; };
  const finish = (decision) => { if (stopped) return; stopped = true; clear(); onDecision(decision); };
  const cancel = () => finish(failure("CANCELLED", "health supervision was cancelled"));
  const publish = (decision) => { if (isCancelled()) cancel(); else finish(decision); };
  const schedule = () => { if (!stopped) timer = clock.setTimeout(tick, intervalMs); };
  const noteProgress = ({ cursor: nextCursor = null, session_id: nextSession = null } = {}) => { generation += 1; unverifiable = 0; if (nextCursor !== null && nextCursor !== undefined) cursor = nextCursor; if (nextSession) session_id = nextSession; };
  const timedProbe = (ctx) => new Promise((resolve) => {
    const controller = new AbortController(); let resolved = false; let timedOut = false; let providerSettled = false; let abortCheck = null;
    const settle = (value) => { if (resolved) return; resolved = true; if (deadline !== null) clock.clearTimeout(deadline); if (abortCheck !== null) clock.clearTimeout(abortCheck); deadline = null; abortCheck = null; activeProbe = null; resolve(value); };
    const abortAndSettle = () => { if (resolved) return; controller.abort(); settle({ status: "stopped" }); };
    activeProbe = { abortAndSettle };
    let returned; try { returned = probeSession({ ...ctx, signal: controller.signal }); } catch (error) { providerSettled = true; settle({ status: "unverifiable", error: { code: "PROBE_FAILED", message: error?.message }, evidence: "probe rejected", probe_reclaimed: true }); return; }
    Promise.resolve(returned).then(
      (value) => { providerSettled = true; settle(timedOut ? { status: "unverifiable", error: { code: "PROBE_DEADLINE" }, evidence: "probe deadline exceeded", probe_reclaimed: true } : value); },
      (error) => { providerSettled = true; settle({ status: "unverifiable", error: { code: timedOut ? "PROBE_DEADLINE" : "PROBE_FAILED", message: error?.message }, evidence: timedOut ? "probe deadline exceeded" : "probe rejected", probe_reclaimed: true }); },
    );
    deadline = clock.setTimeout(() => { deadline = null; timedOut = true; controller.abort(); abortCheck = clock.setTimeout(() => { if (!providerSettled) settle({ status: "unverifiable", error: { code: "PROBE_DEADLINE" }, evidence: "probe ignored abort", probe_reclaimed: false }); }, probeAbortGraceMs); }, probeDeadlineMs);
  });
  const handleUnverifiable = (result) => { unverifiable += 1; if (unverifiable >= 2) publish(failure("HEALTH_UNVERIFIABLE", "health could not be verified twice", result?.evidence ?? null)); else schedule(); };
  async function tick() {
    timer = null; if (stopped) return; if (isCancelled()) { cancel(); return; }
    if (!probeSession) {
      if (generation !== fallbackGeneration) { fallbackGeneration = generation; unverifiable = 0; schedule(); return; }
      handleUnverifiable({ evidence: "no structured stream progress" }); return;
    }
    const probeGeneration = generation; const result = await timedProbe({ session_id, cursor, activity_generation: generation });
    if (stopped) return; if (isCancelled()) { cancel(); return; }
    if (result.status === "stopped") return;
    if (result.status === "unverifiable" && result.probe_reclaimed === false) { publish(failure("PROBE_ABORT_FAILED", "health probe did not stop after abort", result.evidence ?? null)); return; }
    if (!result || !states.has(result.status)) { publish(failure("HEALTH_INVALID", "health probe returned an invalid status")); return; }
    if (generation !== probeGeneration && ["dead", "failed", "unverifiable"].includes(result.status)) { unverifiable = 0; schedule(); return; }
    if (result.session_id) session_id = result.session_id; if (result.cursor !== null && result.cursor !== undefined) cursor = result.cursor;
    if (result.status === "progressing") { noteProgress({ cursor: result.cursor, session_id: result.session_id }); schedule(); return; }
    if (["busy", "retry"].includes(result.status)) { unverifiable = 0; schedule(); return; }
    if (result.status === "unverifiable") { handleUnverifiable(result); return; }
    if (result.status === "completed") {
      const raw = result.raw; if (!raw || typeof raw.stdout !== "string" || typeof raw.stderr !== "string" || !validateCompleted(raw)) { publish(failure("HEALTH_INVALID", "completed health result has no parseable raw", result.evidence ?? null)); return; }
      publish({ ...result, status: "completed", raw }); return;
    }
    const code = result.error?.code ?? (result.status === "dead" ? "PROCESS_DEAD" : "PROVIDER_HEALTH_FAILED"); publish(failure(code, result.error?.message ?? `provider health is ${result.status}`, result.evidence ?? null));
  }
  return { start: schedule, stop: () => { stopped = true; clear(); }, cancel, noteProgress, snapshot: () => ({ generation, cursor, session_id, unverifiable, stopped, probe_active: activeProbe !== null }) };
}
