// Run cbbc_fetch.js every 60 seconds, printing the same OK line each run.
const { spawn } = require("child_process");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "cbbc_fetch.js");
const INTERVAL_MS = 60_000;

function runOnce() {
  const child = spawn(process.execPath, [SCRIPT_PATH], { stdio: "inherit" });
  child.on("error", (err) => {
    console.error("Error spawning fetch process:", err);
  });
}

runOnce();
setInterval(runOnce, INTERVAL_MS);
