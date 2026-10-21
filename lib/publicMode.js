function isPublicMode() {
  return process.env.TRADING_TOOLS_PUBLIC_MODE === "1";
}

module.exports = { isPublicMode };
