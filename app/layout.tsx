import type { Metadata } from "next";
import "./globals.css";
import TopTabs from "./components/TopTabs";
import FullPageScreenshotShortcut from "./components/FullPageScreenshotShortcut";
import BacktestHistorySync from "./components/BacktestHistorySync";

export const metadata: Metadata = {
  title: "Trading Tools",
  description: "Market dashboards and API testing tools",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <TopTabs />
        <BacktestHistorySync />
        {children}
        <FullPageScreenshotShortcut />
      </body>
    </html>
  );
}
