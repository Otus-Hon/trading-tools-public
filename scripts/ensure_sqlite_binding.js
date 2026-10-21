#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

function probeBinding() {
  try {
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    database.prepare("SELECT 1 AS ok").get();
    database.close();
    return true;
  } catch (error) {
    return false;
  }
}

if (probeBinding()) {
  console.log(`[sqlite] better-sqlite3 ready for Node ${process.version} (ABI ${process.versions.modules}).`);
  process.exit(0);
}

console.warn(
  `[sqlite] Native binding does not match Node ${process.version} (ABI ${process.versions.modules}); rebuilding it now.`
);

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("[sqlite] npm executable was not provided. Run `npm rebuild better-sqlite3` and retry.");
  process.exit(1);
}

const rebuild = spawnSync(
  process.execPath,
  [npmCli, "rebuild", "better-sqlite3"],
  { cwd: repoRoot, stdio: "inherit", env: process.env }
);

if (rebuild.error || rebuild.status !== 0 || !probeBinding()) {
  console.error("[sqlite] Unable to prepare better-sqlite3 for the active Node runtime.");
  process.exit(rebuild.status || 1);
}

console.log(`[sqlite] Rebuild complete for Node ${process.version} (ABI ${process.versions.modules}).`);
