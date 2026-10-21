import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import TopTabs from "./components/TopTabs";
import FullPageScreenshotShortcut from "./components/FullPageScreenshotShortcut";
import BacktestHistorySync from "./components/BacktestHistorySync";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <TopTabs />
        <BacktestHistorySync />
        {children}
        <FullPageScreenshotShortcut />
      </body>
    </html>
  );
}
