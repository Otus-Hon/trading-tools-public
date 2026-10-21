/* eslint-disable @typescript-eslint/no-require-imports */

function hasCompleteCbbc(payload) {
  return Boolean(
    payload?.ok &&
    payload.cbbcComplete === true &&
    Number(payload.cbbcTotal) > 0 &&
    Number(payload.cbbcRowsFetched) === Number(payload.cbbcTotal) &&
    Array.isArray(payload.cbbcLevels)
  );
}

function mergeVerifiedCbbcPayload(payload, verifiedPayload) {
  if (!hasCompleteCbbc(verifiedPayload)) return payload;
  return {
    ...payload,
    cbbcLevels: verifiedPayload.cbbcLevels,
    cbbcTotal: verifiedPayload.cbbcTotal,
    cbbcActive: verifiedPayload.cbbcActive,
    cbbcRowsFetched: verifiedPayload.cbbcRowsFetched,
    cbbcComplete: true,
    cbbcFetchedAt: verifiedPayload.cbbcFetchedAt,
  };
}

function selectDetailCbbcLevels(payload, cashPrice, perSide = 9, distance = 1800) {
  if (!hasCompleteCbbc(payload)) return [];
  const eligible = payload.cbbcLevels
    .filter((level) =>
      (level?.side === "bear" || level?.side === "bull") &&
      Number.isFinite(Number(level.price)) &&
      Number.isFinite(Number(level.streetVolume)) &&
      (!Number.isFinite(cashPrice) || Math.abs(Number(level.price) - cashPrice) <= distance)
    )
    .sort((a, b) => Number(b.streetVolume) - Number(a.streetVolume));
  return ["bear", "bull"].flatMap((side) =>
    eligible.filter((level) => level.side === side).slice(0, perSide)
  );
}

module.exports = { hasCompleteCbbc, mergeVerifiedCbbcPayload, selectDetailCbbcLevels };
