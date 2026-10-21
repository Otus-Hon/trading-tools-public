/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isPublicMode } = require("./publicMode");
const { assertFutuLoopback } = require("./loopback");

function pythonPath() {
  const candidates = [
    process.env.FUTU_PYTHON,
    path.join(process.cwd(), ".venv-futu", "Scripts", "python.exe"),
    path.join(process.cwd(), ".venv-futu", "bin", "python"),
    "/tmp/futu-opend-verify-venv/bin/python",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate))
    ?? (process.platform === "win32" ? "python" : "python3");
}

function spawnPython(args, options = {}) {
  assertFutuLoopback();
  return spawn(pythonPath(), ["-u", ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function spawnPythonForHttp(args, options = {}) {
  if (isPublicMode()) {
    const error = new Error("Python execution is disabled for public HTTP requests.");
    error.code = "PUBLIC_PYTHON_DENIED";
    throw error;
  }
  return spawnPython(args, options);
}

module.exports = { pythonPath, spawnPython, spawnPythonForHttp };
