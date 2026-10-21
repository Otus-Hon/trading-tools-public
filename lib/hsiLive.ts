// Real-time HSI CASH index via Tencent's r_hkHSI endpoint.
//
// IMPORTANT: this is the real-time *cash* index, NOT futures and NOT the
// 15-minute-delayed feed. Tencent serves two variants of the same symbol:
//   - "hkHSI"   → 15-minute delayed (HKEX licensing on the plain feed)
//   - "r_hkHSI" → real-time (timestamp tracks the wall clock to the second)
// It also carries the real-time intraday high/low, which is what CBBC knockout
// detection needs (knockouts are determined against the cash index).
//
// Response (GBK, but all the numeric fields are ASCII so UTF-8 decoding is fine):
//   v_r_hkHSI="100~恒生指数~HSI~<price>~<prevClose>~<open>~...~<time>~<chg>~<chg%>~<high>~<low>~...";
// field indices (split on "~"): 3=price 4=prevClose 5=open 30=time 31=chg 32=chg% 33=high 34=low

export type HsiLive = {
  price: number;
  prevClose: number | null;
  open: number | null;       // today's session open
  change: number | null;
  changePercent: number | null;
  high: number | null;       // today's intraday high
  low: number | null;        // today's intraday low
  time: string | null;       // raw Tencent timestamp, HKT "YYYY/MM/DD HH:MM:SS"
  ageSeconds: number | null; // how old the feed's own timestamp is, in seconds
  realtime: boolean;         // ageSeconds present and < 120s
  source: string;
};

const TIMEOUT_MS = 6000;

function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function fetchTextWithTimeout(url: string, headers: Record<string, string>): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Age (seconds) of a Tencent HKT timestamp "YYYY/MM/DD HH:MM:SS" relative to now.
function hktAgeSeconds(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  // HKT is UTC+8 → subtract 8h worth of hours when building the UTC epoch.
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
  if (!Number.isFinite(utcMs)) return null;
  return (Date.now() - utcMs) / 1000;
}

export async function fetchHsiLive(): Promise<HsiLive | null> {
  const text = await fetchTextWithTimeout("https://qt.gtimg.cn/q=r_hkHSI", {
    "User-Agent": "Mozilla/5.0",
    Referer: "https://gu.qq.com/",
  });
  if (!text) return null;

  const inner = text.split('"')[1];
  if (!inner) return null;

  const f = inner.split("~");
  const price = parseFloat(f[3]);
  if (!Number.isFinite(price) || price <= 0) return null;

  const prevClose = parseFloat(f[4]);
  const open = parseFloat(f[5]);
  const high = parseFloat(f[33]);
  const low = parseFloat(f[34]);
  const time = f[30] ?? null;

  const pc = finitePositive(prevClose);
  const change = pc !== null ? price - pc : null;
  const changePercent = change !== null && pc ? (change / pc) * 100 : null;
  const ageSeconds = hktAgeSeconds(time);

  return {
    price,
    prevClose: pc,
    open: finitePositive(open),
    change,
    changePercent,
    high: finitePositive(high),
    low: finitePositive(low),
    time,
    ageSeconds,
    realtime: ageSeconds !== null && ageSeconds >= 0 && ageSeconds < 120,
    source: "tencent-r_hkHSI",
  };
}
