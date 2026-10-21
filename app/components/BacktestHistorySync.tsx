"use client";

import { useEffect } from "react";

export default function BacktestHistorySync() {
  const publicMode = process.env.NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE === "1";
  useEffect(() => {
    if (publicMode) return;
    void fetch("/api/backtest/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ force: false, timeframes: ["15m", "1d", "4h", "1m"] }),
    }).catch(() => {
      /* Preserve last verified SQLite history if OpenD is unavailable. */
    });
  }, [publicMode]);

  return null;
}
