#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const port = 4317;
const origin = `http://127.0.0.1:${port}`;
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "trading-tools-public-test-"));
const cacheAt = Date.now();
const verifiedCbbc = {
  ok: true,
  futuresContract: { selectionPolicy: "front_calendar_month_until_expiry_date_end_hkt" },
  snapshots: { "HK.800000": { price: 24000, updateTime: "2026-10-21 14:00:00" } },
  cbbcLevels: [
    { side: "bear", price: 24500, products: 2, streetVolume: 2000000, tradedVolume: 100000 },
    { side: "bull", price: 23500, products: 3, streetVolume: 3000000, tradedVolume: 200000 },
  ],
  cbbcTotal: 5,
  cbbcActive: 5,
  cbbcRowsFetched: 5,
  cbbcComplete: true,
  cbbcFetchedAt: "2026-10-21T14:00:00+08:00",
};
fs.writeFileSync(path.join(tempData, "futu_market_data_cache.json"), JSON.stringify({ at: cacheAt, payload: verifiedCbbc }));
fs.writeFileSync(path.join(tempData, "futu_market_data_live_cache.json"), JSON.stringify({
  at: cacheAt,
  payload: {
    ok: true,
    liveOnly: true,
    snapshots: { "HK.800000": { price: 24001, updateTime: "2026-10-21 14:00:05" } },
    cbbcLevels: [],
    cbbcTotal: 0,
    cbbcRowsFetched: 0,
    cbbcComplete: false,
  },
}));
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    TRADING_TOOLS_PUBLIC_MODE: "1",
    NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE: "1",
    TRADING_TOOLS_DATA_DIR: tempData,
    FUTU_HOST: "127.0.0.1",
    FUTU_PORT: "11111",
    FUTU_PYTHON: path.join(tempData, "must-not-run-python"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-12_000); });
child.stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-12_000); });

async function request(urlPath, init) {
  return fetch(`${origin}${urlPath}`, { redirect: "manual", ...init });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request("/api/health");
      if (response.status === 200 || response.status === 503) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start.\n${output}`);
}

async function expectStatus(urlPath, expected, init) {
  const response = await request(urlPath, init);
  assert.equal(response.status, expected, `${urlPath} returned ${response.status}, expected ${expected}`);
  return response;
}

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function main() {
  await waitForServer();

  await expectStatus("/api/backtest/run", 403, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "print('must not run')" }),
  });
  await expectStatus("/api/backtest/refresh", 403, { method: "POST", body: "{}" });
  await expectStatus("/api/cbbc/refresh", 403, { method: "POST", body: "{}" });
  await expectStatus("/api/moneyflow/refresh", 403, { method: "POST", body: "{}" });
  await expectStatus("/api/futu/candles?date=2026-10-20", 403);
  await expectStatus("/api/startup", 403);
  await expectStatus("/api/markets/chart?symbol=http%3A%2F%2F127.0.0.1%3A11111", 400);
  await expectStatus(`/api/hsi?${"x".repeat(600)}`, 414);

  const liveCache = await expectStatus("/api/futu/market-data?live=1", 200);
  const livePayload = await liveCache.json();
  assert.equal(livePayload.snapshots["HK.800000"].price, 24001);
  assert.equal(livePayload.cbbcComplete, true);
  assert.equal(livePayload.cbbcRowsFetched, 5);
  assert.equal(livePayload.cbbcTotal, 5);
  assert.equal(livePayload.cbbcLevels.length, 2);
  assert.doesNotMatch(JSON.stringify(livePayload), /must-not-run-python|TradingTools|\\Users\\|\/Users\//);

  const cbbc = await expectStatus("/api/cbbc/latest", 404);
  assert.doesNotMatch(await cbbc.text(), /https?:\/\/|stack|ENOENT/i);

  const page = await expectStatus("/market-data", 200);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-powered-by"), null);

  console.log("public security integration tests passed");
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await stopChild();
    fs.rmSync(tempData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})();
