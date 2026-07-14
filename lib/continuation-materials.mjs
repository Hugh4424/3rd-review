import { fail } from "./errors.mjs";

export function lastProviderMaterial(state, provider, session_id) {
  if (typeof session_id !== "string" || !session_id) fail("MATERIAL_INCOMPLETE", "continuation has no native provider session");
  const completed = state.continuation_materials ?? [];
  for (let index = completed.length - 1; index >= 0; index -= 1) if (completed[index]?.provider_sessions?.[provider] === session_id) return completed[index];
  return null;
}
export function reserveContinuationMaterial(state, material, provider, session_id) {
  if (!material || typeof session_id !== "string" || !session_id) fail("MATERIAL_INCOMPLETE", "continuation material lacks a verified session");
  const completed = state.continuation_materials ?? []; const reservation = state.continuation_reservation;
  if (!reservation && completed.length !== material.sequence - 1) fail("MATERIAL_INCOMPLETE", "continuation sequence is no longer available");
  if (reservation && (reservation.sequence !== material.sequence || reservation.manifest_hash !== material.manifest_hash || reservation.delivery_manifest_hash !== material.delivery_manifest_hash || reservation.initial_material_manifest_hash !== material.initial_material_manifest_hash)) fail("MATERIAL_INCOMPLETE", "continuation material is reserved by another request");
  if (reservation?.provider_sessions?.[provider] && reservation.provider_sessions[provider] !== session_id) fail("MATERIAL_INCOMPLETE", "continuation provider/session is reserved by another request");
  return { ...state, continuation_reservation: { ...(reservation ?? material), provider_sessions: { ...(reservation?.provider_sessions ?? {}), [provider]: session_id } } };
}
export function releaseContinuationMaterial(state, material, provider, session_id) {
  const reservation = state.continuation_reservation;
  if (!material || typeof session_id !== "string" || !session_id || !reservation || reservation.sequence !== material.sequence || reservation.manifest_hash !== material.manifest_hash || reservation.provider_sessions?.[provider] !== session_id) return state;
  const provider_sessions = { ...reservation.provider_sessions }; delete provider_sessions[provider];
  return { ...state, continuation_reservation: Object.keys(provider_sessions).length ? { ...reservation, provider_sessions } : null };
}
export function recordContinuationMaterial(state, material, provider, session_id) {
  const completed = state.continuation_materials ?? []; const reservation = state.continuation_reservation;
  if (!reservation || reservation.sequence !== material.sequence || reservation.manifest_hash !== material.manifest_hash || reservation.delivery_manifest_hash !== material.delivery_manifest_hash || reservation.provider_sessions?.[provider] !== session_id) fail("MATERIAL_INCOMPLETE", "continuation material has no matching reservation");
  const provider_sessions = { ...reservation.provider_sessions }; delete provider_sessions[provider]; const nextReservation = Object.keys(provider_sessions).length ? { ...reservation, provider_sessions } : null; const existing = completed.find((item) => item.sequence === material.sequence);
  if (existing) {
    if (existing.manifest_hash !== material.manifest_hash || existing.delivery_manifest_hash !== material.delivery_manifest_hash || existing.initial_material_manifest_hash !== material.initial_material_manifest_hash) fail("MATERIAL_INCOMPLETE", "continuation sequence was already bound to different material");
    return { ...state, continuation_materials: completed.map((item) => item.sequence === material.sequence ? { ...item, provider_sessions: { ...item.provider_sessions, [provider]: session_id } } : item), continuation_reservation: nextReservation };
  }
  if (completed.length !== material.sequence - 1) fail("MATERIAL_INCOMPLETE", "continuation sequence cannot be appended out of order");
  return { ...state, continuation_materials: [...completed, { ...material, provider_sessions: { [provider]: session_id } }], continuation_reservation: nextReservation };
}
