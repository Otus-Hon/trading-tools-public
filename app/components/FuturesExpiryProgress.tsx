"use client";

import { useEffect, useMemo, useState } from "react";

type FuturesContract = {
  continuousCode: string;
  contractCode: string;
  contractName: string;
  expiryDate: string;
  exchange: string;
  source: string;
  selectionPolicy: string;
};

type FutuContractPayload = {
  ok?: boolean;
  futuresContract?: FuturesContract | null;
};

const COUNTDOWN_DAYS = 30;

function hkToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function calendarDaysBetween(from: string, to: string) {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.ceil((toMs - fromMs) / 86_400_000);
}

export default function FuturesExpiryProgress() {
  const [contract, setContract] = useState<FuturesContract | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryId: number | null = null;

    const load = async () => {
      try {
        const response = await fetch(`/api/futu/market-data?_=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as FutuContractPayload;
        if (cancelled || !payload.ok || !payload.futuresContract?.expiryDate) return;
        setContract(payload.futuresContract);
      } catch {
        // Preserve the last verified contract metadata.
      }
    };

    void load();
    // The first request can legitimately return the disk cache while the server
    // refreshes it in the background. Pick up the newly resolved contract shortly after.
    retryId = window.setTimeout(() => { void load(); }, 4_000);
    const intervalId = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      cancelled = true;
      if (retryId !== null) window.clearTimeout(retryId);
      window.clearInterval(intervalId);
    };
  }, []);

  const countdown = useMemo(() => {
    if (!contract) return null;
    const rawDays = calendarDaysBetween(hkToday(), contract.expiryDate);
    if (rawDays === null) return null;
    const days = Math.max(0, rawDays);
    const daysWithinWindow = Math.min(days, COUNTDOWN_DAYS);
    const elapsedDays = COUNTDOWN_DAYS - daysWithinWindow;
    return {
      days,
      elapsedDays,
      percent: (elapsedDays / COUNTDOWN_DAYS) * 100,
      isExpiry: rawDays <= 0,
    };
  }, [contract]);

  if (!contract || !countdown) {
    return (
      <div className="h-[52px] w-full rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-400">
        期結資料載入中…
      </div>
    );
  }

  const tone = countdown.isExpiry
    ? "border-red-700 bg-red-600 text-white"
    : "border-amber-300 bg-amber-50 text-amber-950";
  const fill = countdown.isExpiry ? "bg-red-800" : "bg-neutral-300";

  return (
    <div
      role="progressbar"
      aria-label="HSI futures expiry countdown"
      aria-valuemin={0}
      aria-valuemax={COUNTDOWN_DAYS}
      aria-valuenow={countdown.elapsedDays}
      aria-valuetext={countdown.isExpiry ? "HSI futures expire today" : `${countdown.days} days remaining until HSI futures expiry`}
      title={`${contract.contractName} · ${contract.contractCode} · 期結 ${contract.expiryDate} · ${contract.source}`}
      className={`h-[52px] w-full rounded-lg border px-4 py-1.5 shadow-sm ${tone}`}
    >
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs font-semibold">
        {countdown.isExpiry ? (
          <strong className="text-base">今天期結</strong>
        ) : (
          <span>
            期結倒數 <strong className="text-base tabular-nums">{countdown.days}</strong> 日
          </span>
        )}
        <span className="truncate text-[10px] opacity-75">
          {contract.contractCode.replace("HK.", "")} · {contract.expiryDate}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className={`h-2 flex-1 overflow-hidden rounded-full ${countdown.isExpiry ? "bg-red-300/60" : "bg-amber-500"}`}>
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
            style={{ width: `${countdown.percent}%` }}
          />
        </div>
        <span className="text-[10px] font-bold leading-none opacity-80">期結</span>
      </div>
    </div>
  );
}
