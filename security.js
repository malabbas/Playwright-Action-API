const dns = require("node:dns/promises");
const net = require("node:net");

const globalIpv6 = new net.BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const specialIpv6 = new net.BlockList();
// Conservatively reject special-use assignments and transition mechanisms,
// including their expanded spellings. This is a supplement to the origin list.
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
]) specialIpv6.addSubnet(address, prefix, "ipv6");

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) === 6) {
    return globalIpv6.check(address, "ipv6") && !specialIpv6.check(address, "ipv6");
  }
  return false;
}

function parsePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new RequestError("A valid allowed HTTPS URL is required"); }
  if (typeof value !== "string" || url.protocol !== "https:" || url.username || url.password ||
      url.port || net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      url.hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname) ||
      /\.(localhost|local|internal|test|invalid)$/.test(url.hostname)) {
    throw new RequestError("Only public HTTPS hostnames on port 443 are accepted");
  }
  return url;
}

function readConfig(env = process.env) {
  const apiToken = env.API_TOKEN || "";
  if (apiToken.length < 32 || /replace|change.me|your.token/i.test(apiToken) || /\s/.test(apiToken)) {
    throw new RequestError("Set API_TOKEN to a random value of at least 32 characters; run npm run setup locally.");
  }
  const allowedOrigins = (env.ALLOWED_ORIGINS || "https://example.com").split(",").map((entry) => {
    const value = entry.trim();
    const url = parsePublicUrl(value);
    if (value !== url.origin && value !== `${url.origin}/`) throw new RequestError("ALLOWED_ORIGINS must contain exact HTTPS origins without paths");
    return url.origin;
  });
  function integer(name, fallback, min, max) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new RequestError(`Invalid ${name} configuration`);
    return value;
  }
  return {
    apiToken, allowedOrigins,
    host: env.HOST || "127.0.0.1",
    port: integer("PORT", 3000, 1, 65535),
    maxConcurrentJobs: integer("MAX_CONCURRENT_JOBS", 2, 1, 8),
    jobTimeoutMs: integer("JOB_TIMEOUT_MS", 60000, 1000, 120000)
  };
}

function createUrlPolicy(origins, lookup = dns.lookup, dnsTimeoutMs = 5000) {
  const allowed = new Set(origins);
  return async (value) => {
    const url = parsePublicUrl(value);
    if (!allowed.has(url.origin)) throw new RequestError("URL origin is not allowed");
    let addresses;
    let timer;
    try {
      addresses = await Promise.race([
        lookup(url.hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new RequestError("Destination DNS lookup timed out")), dnsTimeoutMs);
        })
      ]);
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError("Destination DNS lookup failed");
    } finally {
      clearTimeout(timer);
    }
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      throw new RequestError("Destination must resolve only to public addresses");
    }
    return url;
  };
}

module.exports = { RequestError, readConfig, publicAddress, createUrlPolicy };
