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
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["start", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
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

  const noCache = await expectStatus("/api/futu/market-data?live=1", 503);
  const noCacheText = await noCache.text();
  assert.doesNotMatch(noCacheText, /must-not-run-python|TradingTools|\\Users\\|\/Users\//);

  const cbbc = await expectStatus("/api/cbbc/latest", 404);
  assert.doesNotMatch(await cbbc.text(), /https?:\/\/|stack|ENOENT/i);

  const page = await expectStatus("/market-data", 200);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-powered-by"), null);

  console.log("public security integration tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  child.kill("SIGTERM");
  fs.rmSync(tempData, { recursive: true, force: true });
});
