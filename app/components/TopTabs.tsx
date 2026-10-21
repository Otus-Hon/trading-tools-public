"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/market-data", label: "Main Data" },
  { href: "/backtest", label: "Backtest" },
];

export default function TopTabs() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/95 backdrop-blur-xl">
      <div className="flex h-14 items-center px-4 md:px-6 lg:px-8">
        <Link href="/market-data" className="flex shrink-0 items-center gap-2.5" aria-label="Trading Tools home">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black text-[9px] font-bold text-white shadow-sm">
            TT
          </span>
          <span className="text-sm font-semibold tracking-[-0.02em] text-black">Trading Tools</span>
        </Link>
        <nav className="ml-7 flex items-center gap-1" aria-label="Product views">
          {tabs.map((tab) => {
            const active = pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors ${
                  active
                    ? "bg-neutral-100 text-neutral-950"
                    : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-950"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
