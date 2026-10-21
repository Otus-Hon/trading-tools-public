const ENABLED =
  typeof window !== "undefined" && process.env.NODE_ENV !== "production";

function stamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

export function diag(scope: string, message: string, details?: unknown) {
  if (!ENABLED) return;
  const prefix = `[TT][${stamp()}][${scope}] ${message}`;
  if (details === undefined) {
    console.log(prefix);
    return;
  }
  console.groupCollapsed(prefix);
  console.log(details);
  console.groupEnd();
}

export function diagError(scope: string, message: string, error: unknown, details?: unknown) {
  if (!ENABLED) return;
  const prefix = `[TT][${stamp()}][${scope}] ${message}`;
  // These diagnostics describe failures already handled by the UI. Logging them
  // as console errors makes Next.js show its development error overlay and turns
  // recoverable provider outages into an apparent application crash.
  console.groupCollapsed(prefix);
  console.warn(error);
  if (details !== undefined) {
    console.log(details);
  }
  console.groupEnd();
}
