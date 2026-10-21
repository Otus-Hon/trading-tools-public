export type CbbcSide = "bear" | "bull";

export type CbbcKnockoutLevel = {
  side: CbbcSide;
  start: number;
  end: number;
  price: number;
  trigger: number;
  volume: number;
};

export type CbbcLevelRows = {
  bearRows?: Array<{ start?: number; end?: number; count?: number | null }>;
  bullRows?: Array<{ start?: number; end?: number; count?: number | null }>;
};

function isSide(value: unknown): value is CbbcSide {
  return value === "bear" || value === "bull";
}

export function cbbcKnockoutLevel(
  side: CbbcSide,
  start: number,
  end: number,
  volume: number,
): CbbcKnockoutLevel | null {
  if (!isSide(side) || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(volume)) {
    return null;
  }
  // The drawn line is the knockout. A 100-point bear band 25,200-25,299 is hit
  // only when cash reaches 25,300 (end + 1). Touching 25,200 is still inside the
  // bucket and must stay active. Bull bands use the symmetric lower boundary.
  // Detail rows are one recovery price, so the line and the trigger are that price.
  if (side === "bear") {
    const price = end + 1;
    if (!Number.isFinite(price)) return null;
    return { side, start, end, price, trigger: price, volume };
  }
  const price = start - 1;
  if (!Number.isFinite(price)) return null;
  return { side, start, end, price, trigger: price, volume };
}

export function rowsToCbbcLevels(data: CbbcLevelRows | null | undefined): CbbcKnockoutLevel[] {
  if (!data) return [];
  const levels: CbbcKnockoutLevel[] = [];
  for (const row of data.bearRows ?? []) {
    const level = cbbcKnockoutLevel("bear", Number(row?.start), Number(row?.end), Number(row?.count));
    if (level) levels.push(level);
  }
  for (const row of data.bullRows ?? []) {
    const level = cbbcKnockoutLevel("bull", Number(row?.start), Number(row?.end), Number(row?.count));
    if (level) levels.push(level);
  }
  return levels;
}

export function cbbcLevelKey(level: { side: CbbcSide; price: number }) {
  return `${level.side}:${level.price}`;
}

export function cbbcLevelKnockedOut(
  level: { side: CbbcSide; trigger: number },
  high: number | null,
  low: number | null,
): boolean {
  if (level.side === "bear") return high !== null && Number.isFinite(high) && high >= level.trigger;
  return low !== null && Number.isFinite(low) && low <= level.trigger;
}

// Keep every band seen this session. Outstanding feeds delete a bucket as soon
// as it knocks out, which is the moment the alert has to be able to see it.
export function mergeCbbcLevels(
  existing: CbbcKnockoutLevel[],
  incoming: CbbcKnockoutLevel[],
): CbbcKnockoutLevel[] {
  const map = new Map<string, CbbcKnockoutLevel>();
  for (const level of existing) map.set(cbbcLevelKey(level), level);
  for (const level of incoming) map.set(cbbcLevelKey(level), level);
  return Array.from(map.values());
}

export function normalizeStoredCbbcLevels(stored: unknown): CbbcKnockoutLevel[] {
  if (!Array.isArray(stored)) return [];
  const levels: CbbcKnockoutLevel[] = [];
  for (const level of stored) {
    if (!level || typeof level !== "object") continue;
    const row = level as { side?: unknown; start?: unknown; end?: unknown; volume?: unknown };
    if (!isSide(row.side)) continue;
    const normalized = cbbcKnockoutLevel(row.side, Number(row.start), Number(row.end), Number(row.volume));
    if (normalized) levels.push(normalized);
  }
  return levels;
}

export function newlyKnockedOutLevels(
  levels: CbbcKnockoutLevel[],
  already: Set<string> | null,
  high: number,
  low: number,
): { now: Set<string>; newly: CbbcKnockoutLevel[] } {
  const now = new Set<string>();
  const newly: CbbcKnockoutLevel[] = [];
  for (const level of levels) {
    if (!cbbcLevelKnockedOut(level, high, low)) continue;
    const key = cbbcLevelKey(level);
    now.add(key);
    if (already && !already.has(key)) newly.push(level);
  }
  return { now, newly };
}
