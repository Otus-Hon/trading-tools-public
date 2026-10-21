const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function futuHost() {
  return String(process.env.FUTU_HOST || "127.0.0.1").trim();
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || "").trim());
}

function assertFutuLoopback() {
  const host = futuHost();
  if (!isLoopbackHost(host)) {
    throw new Error(`Futu OpenD host must be localhost; refusing ${host}.`);
  }
  return host;
}

module.exports = { LOOPBACK_HOSTS, futuHost, isLoopbackHost, assertFutuLoopback };
