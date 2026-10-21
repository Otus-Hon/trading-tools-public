/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

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

module.exports = { pythonPath };
