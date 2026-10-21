"use client";

import { useEffect } from "react";

export default function BacktestHistorySync() {
  useEffect(() => {
    void fetch("/api/backtest/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ force: false, timeframes: ["15m", "1d", "4h", "1m"] }),
    }).catch(() => {
      /* Preserve last verified SQLite history if OpenD is unavailable. */
    });
  }, []);

  return null;
}
