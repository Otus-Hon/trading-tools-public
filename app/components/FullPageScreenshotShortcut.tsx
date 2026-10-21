"use client";

import { useEffect, useRef, useState } from "react";
import html2canvas from "html2canvas-pro";
import { diagError } from "@/lib/clientDiag";

type ScreenshotStatus = "capturing" | "copied" | "downloaded" | "error" | null;

export default function FullPageScreenshotShortcut() {
  const [status, setStatus] = useState<ScreenshotStatus>(null);
  const capturingRef = useRef(false);

  useEffect(() => {
    let statusTimer: ReturnType<typeof setTimeout> | null = null;

    const showTemporaryStatus = (nextStatus: Exclude<ScreenshotStatus, "capturing" | null>) => {
      setStatus(nextStatus);
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => setStatus(null), 2200);
    };

    const captureWholePage = async () => {
      if (capturingRef.current) return;
      capturingRef.current = true;
      setStatus("capturing");
      try {
        const root = document.documentElement;
        const width = Math.max(root.scrollWidth, document.body.scrollWidth);
        const height = Math.max(root.scrollHeight, document.body.scrollHeight);
        const canvas = await html2canvas(root, {
          backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
          width,
          height,
          windowWidth: width,
          windowHeight: height,
          scrollX: 0,
          scrollY: -window.scrollY,
          scale: Math.max(1, window.devicePixelRatio || 1),
          useCORS: true,
          logging: false,
          ignoreElements: (element) => element.hasAttribute("data-screenshot-status"),
        });
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("Could not create screenshot");

        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          showTemporaryStatus("copied");
        } catch {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `trading-tools-${new Date().toISOString().replaceAll(":", "-")}.png`;
          link.click();
          URL.revokeObjectURL(url);
          showTemporaryStatus("downloaded");
        }
      } catch (error) {
        diagError("Screenshot", "full-page capture failed", error);
        showTemporaryStatus("error");
      } finally {
        capturingRef.current = false;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || !event.shiftKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void captureWholePage();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (statusTimer) clearTimeout(statusTimer);
    };
  }, []);

  if (!status) return null;
  return (
    <div
      data-screenshot-status
      className="fixed bottom-5 left-1/2 z-[100] -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--text)] shadow-xl"
    >
      {status === "capturing" && "Capturing whole webpage…"}
      {status === "copied" && "Whole webpage copied to clipboard"}
      {status === "downloaded" && "Clipboard blocked — PNG downloaded"}
      {status === "error" && "Could not capture webpage"}
    </div>
  );
}
