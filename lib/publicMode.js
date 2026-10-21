function isPublicMode() {
  return process.env.TRADING_TOOLS_PUBLIC_MODE === "1";
}

function publicForbiddenPayload(message) {
  return {
    ok: false,
    error: message || "This action is disabled on the public website.",
  };
}

module.exports = { isPublicMode, publicForbiddenPayload };
