import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = {
  "deploy/windows/auto-update.ps1": [
    "Global\\TradingToolsAutoUpdate",
    "update.ps1",
    "auto-update.log",
  ],
  "deploy/windows/register-auto-update.ps1": [
    "TradingToolsAutoUpdate",
    "RepetitionInterval",
    "MultipleInstances IgnoreNew",
  ],
  "deploy/windows/update.ps1": [
    "safe.directory=$repositoryRoot",
    "Invoke-DeploymentGit fetch --quiet origin main",
    "merge-base --is-ancestor",
    "installed-release.txt",
    "installedReleaseIsCurrent",
    "repairing the incomplete installed release",
  ],
  "deploy/windows/install.ps1": [
    "Write-Progress",
    "npm.cmd run build",
    "test:public-security",
  ],
};

for (const [relativePath, requiredText] of Object.entries(contracts)) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  for (const expected of requiredText) {
    assert.ok(source.includes(expected), `${relativePath} must include ${expected}`);
  }

  let braces = 0;
  for (const char of source.replace(/#[^\n]*/g, "")) {
    if (char === "{") braces += 1;
    if (char === "}") braces -= 1;
    assert.ok(braces >= 0, `${relativePath} has an unmatched closing brace`);
  }
  assert.equal(braces, 0, `${relativePath} has unmatched opening braces`);
}

console.log("Windows automatic-update script contract passed");
