/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("path");

const DATA_DIR = path.resolve(
  process.env.TRADING_TOOLS_DATA_DIR ||
    path.join(process.cwd(), "private-data", "runtime")
);

function dataPath(...segments) {
  return path.join(DATA_DIR, ...segments);
}

module.exports = { DATA_DIR, dataPath };
