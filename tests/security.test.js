const test = require("node:test");
const assert = require("node:assert/strict");
const { readConfig, publicAddress, createUrlPolicy, RequestError } = require("../security");

const API_TOKEN = "test-only-" + "a".repeat(40);
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("configuration requires a private token and defaults to a local, bounded service", () => {
  assert.throws(() => readConfig({}), /Set API_TOKEN/);
  assert.throws(() => readConfig({ API_TOKEN: "replace-with-a-real-token-".repeat(2) }), /Set API_TOKEN/);
  const config = readConfig({ API_TOKEN });
  assert.equal(config.host, "127.0.0.1");
  assert.deepEqual(config.allowedOrigins, ["https://example.com"]);
  assert.equal(config.maxConcurrentJobs, 2);
  assert.equal(config.jobTimeoutMs, 60000);
  for (const env of [
    { PORT: "0" }, { PORT: "3000.5" }, { MAX_CONCURRENT_JOBS: "9" },
    { JOB_TIMEOUT_MS: "0" }, { JOB_TIMEOUT_MS: "120001" }
  ]) assert.throws(() => readConfig({ API_TOKEN, ...env }), RequestError);
});

test("configuration accepts only exact public HTTPS origins", () => {
  assert.deepEqual(readConfig({ API_TOKEN, ALLOWED_ORIGINS: "https://example.com/, https://www.example.com" }).allowedOrigins,
    ["https://example.com", "https://www.example.com"]);
  for (const origin of [
    "https://example.com/path", "https://example.com?query=1", "https://example.com#fragment",
    "http://example.com", "https://*.example.com", "https://localhost",
    "https://127.0.0.1", "https://[::1]", "https://example.com:8443", "https://user:pass@example.com"
  ]) assert.throws(() => readConfig({ API_TOKEN, ALLOWED_ORIGINS: origin }), RequestError, origin);
});

test("public address policy rejects private, documentation, multicast and transition addresses", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.2.1", "198.18.0.1",
    "198.51.100.2", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1",
    "2001::1", "2001:0000:0000:0000:0000:0000:0000:0001", "2001:2::1",
    "2001:20::1", "2001:db8::1", "2002::1", "3fff::1", "not-an-address"
  ]) assert.equal(publicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"])
    assert.equal(publicAddress(address), true, address);
});

test("URL policy permits paths only on allowed origins and validates every DNS address", async () => {
  const policy = createUrlPolicy(["https://example.com"], publicLookup);
  const result = await policy("https://example.com/docs?topic=demo#readme");
  assert.equal(result.origin, "https://example.com");
  for (const url of [
    "https://other.example.com", "https://example.com.evil.org", "http://example.com",
    "file:///etc/passwd", "data:text/html,hello", "https://user:pass@example.com",
    "https://example.com:8443", "https://example.com.", "https://127.1", "https://0x7f000001",
    "https://[::1]", "https://example.internal", null, {}, "invalid"
  ]) await assert.rejects(policy(url), RequestError, String(url));
  const mixedDns = createUrlPolicy(["https://example.com"], async () => [
    { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }
  ]);
  await assert.rejects(mixedDns("https://example.com"), /only to public addresses/);
  const specialIpv6Dns = createUrlPolicy(["https://example.com"], async () => [{ address: "2001:2::1", family: 6 }]);
  await assert.rejects(specialIpv6Dns("https://example.com"), /only to public addresses/);
  const emptyDns = createUrlPolicy(["https://example.com"], async () => []);
  await assert.rejects(emptyDns("https://example.com"), /only to public addresses/);
});

test("unlisted origins never trigger DNS and DNS errors do not disclose resolver details", async () => {
  let calls = 0;
  const policy = createUrlPolicy(["https://example.com"], async () => {
    calls += 1;
    throw new Error("private resolver details");
  });
  await assert.rejects(policy("https://other.example.com"), /origin is not allowed/);
  assert.equal(calls, 0);
  await assert.rejects(policy("https://example.com"), { message: "Destination DNS lookup failed" });
  assert.equal(calls, 1);
});

test("DNS lookups are bounded even when the resolver never settles", async () => {
  const policy = createUrlPolicy(["https://example.com"], () => new Promise(() => {}), 10);
  await assert.rejects(policy("https://example.com"), { message: "Destination DNS lookup timed out" });
});
