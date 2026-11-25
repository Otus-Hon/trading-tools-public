"use client";

import { useState } from "react";
import AutoStrategyPanel from "../components/AutoStrategyPanel";
import MacdBacktest from "../components/MacdBacktest";

export default function BacktestPage() {
  const [view, setView] = useState<"auto" | "python">("auto");

  return (
    <main className="flex min-h-[100dvh] flex-col overflow-visible bg-[#fafafa] px-3 py-4 text-neutral-950 sm:px-4 md:px-6 lg:px-8 xl:h-[calc(100dvh-3.5625rem)] xl:min-h-0 xl:overflow-hidden">
      <div className="mb-3 flex shrink-0 rounded-lg border border-neutral-200 bg-white p-0.5" aria-label="Backtest views">
        <button
          type="button"
          onClick={() => setView("auto")}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold ${view === "auto" ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"}`}
        >
          Auto strategies
        </button>
        <button
          type="button"
          onClick={() => setView("python")}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold ${view === "python" ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"}`}
        >
          Python strategy
        </button>
      </div>
      <div className="min-w-0 flex-1">
        {view === "auto" ? <AutoStrategyPanel /> : <MacdBacktest />}
      </div>
    </main>
  );
}
