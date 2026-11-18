const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { createService } = require("../server");

// These are deliberately synthetic credentials and public DNS answers. No browser,
// network destination, saved session, or real API key is used by these tests.
const TOKEN = "synthetic-test-token-with-over-32-characters";
const ORIGIN = "https://example.com";
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const requestBody = (actions = [], extra = {}) => ({ url: ORIGIN, mode: "actions", actions, ...extra });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Expected lifecycle event did not occur");
    await delay(5);
  }
}

function fakeChromium(options = {}) {
  const state = { launches: 0, browserCloses: 0, contextCloses: 0, visits: [] };
  const chromium = {
    async launch(launchOptions) {
      state.launches += 1;
      state.launchOptions = launchOptions;
      if (options.onLaunch) await options.onLaunch(state);
      let currentUrl = ORIGIN;
      const page = {
        setDefaultNavigationTimeout() {},
        setDefaultTimeout() {},
        async goto(url) {
          state.visits.push(url);
          currentUrl = url;
          if (options.onGoto) await options.onGoto(state, url);
        },
        url: () => options.finalUrl || currentUrl,
        async $eval(_selector, fn, keepExact) {
          return fn({ innerText: options.text || "Example   Domain" }, keepExact);
        },
        async screenshot() { return options.screenshot || Buffer.from("fake-png"); },
        video() { return { async path() { return path.join(state.contextOptions.recordVideo.dir, "recording.webm"); } }; },
        locator() {
          return { async click() { if (options.clickError) throw options.clickError; } };
        }
      };
      const context = {
        async route(_pattern, handler) { state.route = handler; },
        async routeWebSocket(_pattern, handler) { state.webSocket = handler; },
        async newPage() { return page; },
        async close() {
          state.contextCloses += 1;
          if (options.videoBuffer) {
            await fs.writeFile(path.join(state.contextOptions.recordVideo.dir, "recording.webm"), options.videoBuffer);
          }
        }
      };
      return {
        async newContext(contextOptions) { state.contextOptions = contextOptions; return context; },
        async close() {
          state.browserCloses += 1;
          if (options.onClose) await options.onClose(state);
        }
      };
    }
  };
  return { chromium, state };
}

async function start(t, options = {}) {
  const fake = fakeChromium(options.browser);
  const service = createService({
    apiToken: TOKEN,
    allowedOrigins: [ORIGIN],
    maxConcurrentJobs: 1,
    jobTimeoutMs: 1000,
    ...options.config
  }, { chromium: fake.chromium, lookup: options.lookup || publicLookup });
  const server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await service.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  async function request(endpoint, { body, token = TOKEN, raw, ...rest } = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: body !== undefined || raw !== undefined ? "POST" : "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(raw !== undefined ? { body: raw } : {}),
      ...rest
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { ...fake, service, request };
}

test("health is public while service operations require the bearer token", async (t) => {
  const { request, state } = await start(t);
  const health = await request("/health", { token: null });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-powered-by"), null);
  for (const token of [null, "incorrect-token"]) {
    const result = await request("/actions", { token, body: requestBody() });
    assert.equal(result.status, 401);
  }
  const actions = await request("/debug/actions");
  assert.equal(actions.status, 200);
  assert.ok(actions.body.supported_actions.includes("screenshot"));
  assert.ok(!actions.body.supported_actions.includes("evaluate"));
  assert.equal((await request("/debug/build")).status, 404);
  assert.equal(state.launches, 0);
});

test("authentication precedes body parsing, and malformed bodies do not echo content", async (t) => {
  const { request, state } = await start(t);
  const privateInput = "synthetic-sensitive-input-do-not-echo";
  const raw = `{"secret":"${privateInput}"`;
  assert.equal((await request("/actions", { token: null, raw })).status, 401);
  const malformed = await request("/actions", { raw });
  assert.equal(malformed.status, 400);
  assert.ok(!JSON.stringify(malformed.body).includes(privateInput));
  const oversized = await request("/actions", { raw: JSON.stringify({ text: "x".repeat(270000) }) });
  assert.equal(oversized.status, 413);
  assert.equal(state.launches, 0);
});

test("invalid action plans are rejected before a browser can launch", async (t) => {
  const { request, state } = await start(t);
  const bodies = [
    requestBody([], { mode: "run" }),
    requestBody(Array.from({ length: 51 }, () => ({ action: "wait", ms: 0 }))),
    requestBody([], { recordVideo: "true" }),
    requestBody([{ action: "evaluate", script: "document.cookie" }]),
    requestBody([{ action: "constructor" }]),
    requestBody([null]),
    requestBody([{ action: "screenshot", path: "../.env" }]),
    requestBody([{ action: "wait_for", selector: "body", timeout: 0 }]),
    requestBody([{ action: "navigate", url: "https://not-allowed.example.com" }])
  ];
  for (const body of bodies) {
    const result = await request("/actions", { body });
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
  }
  assert.equal(state.launches, 0);
});

test("private destinations and mixed public/private DNS answers never launch Chromium", async (t) => {
  const { request, state } = await start(t, {
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]
  });
  for (const url of [ORIGIN, "http://example.com", "https://127.0.0.1", "https://localhost", "https://user:synthetic-password@example.com"]) {
    const result = await request("/actions", { body: requestBody([], { url }) });
    assert.equal(result.status, 400);
    assert.ok(!JSON.stringify(result.body).includes("synthetic-password"));
  }
  assert.equal(state.launches, 0);
});

test("successful actions return bounded output and close their fresh browser", async (t) => {
  const { request, state } = await start(t);
  const result = await request("/actions", { body: requestBody([
    { action: "extract_text", selector: "h1" },
    { action: "screenshot" },
    { action: "navigate", url: `${ORIGIN}/next` }
  ]) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, {
    finalUrl: `${ORIGIN}/next`,
    results: [
      { action: "extract_text", text: "Example Domain" },
      { action: "screenshot", base64: Buffer.from("fake-png").toString("base64") },
      { action: "goto", url: `${ORIGIN}/next` }
    ]
  });
  await until(() => state.browserCloses === 1);
  assert.equal(state.contextCloses, 1);
  assert.equal(state.launchOptions.chromiumSandbox, true);
  assert.equal(state.contextOptions.acceptDownloads, false);
  assert.equal(state.contextOptions.serviceWorkers, "block");
  assert.equal(state.contextOptions.storageState, undefined);
});

test("browser failures are generic and cannot echo a credential in a Playwright error", async (t) => {
  const sensitive = "synthetic-password-from-a-filled-form";
  const { request, state } = await start(t, { browser: { clickError: new Error(`Page failure: ${sensitive} ${TOKEN}`) } });
  const result = await request("/actions", { body: requestBody([{ action: "click", selector: `input[value='${sensitive}']` }]) });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { ok: false, error: "Browser job failed" });
  assert.ok(!JSON.stringify(result.body).includes(sensitive));
  assert.ok(!JSON.stringify(result.body).includes(TOKEN));
  await until(() => state.browserCloses === 1);
});

test("oversized screenshots are refused and the browser is closed", async (t) => {
  const { request, state } = await start(t, { browser: { screenshot: Buffer.alloc(5 * 1024 * 1024 + 1) } });
  const result = await request("/actions", { body: requestBody([{ action: "screenshot" }]) });
  assert.equal(result.status, 413);
  assert.equal(result.body.ok, false);
  await until(() => state.browserCloses === 1);
});

test("recordings are returned without server paths and temporary files are removed", async (t) => {
  const videoBuffer = Buffer.from("synthetic-webm-recording");
  const { request, state, service } = await start(t, { browser: { videoBuffer } });
  const result = await request("/actions", { body: requestBody([], { recordVideo: true }) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.video, { base64: videoBuffer.toString("base64") });
  await service.stop();
  await assert.rejects(fs.access(state.contextOptions.recordVideo.dir), { code: "ENOENT" });
});

test("oversized recordings are refused and their temporary files are removed", async (t) => {
  const { request, state, service } = await start(t, { browser: { videoBuffer: Buffer.alloc(5 * 1024 * 1024 + 1) } });
  const result = await request("/actions", { body: requestBody([], { recordVideo: true }) });
  assert.equal(result.status, 413);
  assert.equal(result.body.ok, false);
  await service.stop();
  await assert.rejects(fs.access(state.contextOptions.recordVideo.dir), { code: "ENOENT" });
});

test("every browser request is checked, redirects are not followed, and WebSockets close", async (t) => {
  const routed = [];
  let socketCloses = 0;
  const { request } = await start(t, { browser: {
    async onGoto(state) {
      for (const [url, status] of [["https://127.0.0.1/secret", 200], [ORIGIN, 200], [ORIGIN, 302], [ORIGIN, 307]]) {
        const observation = { url, status, fetched: false, fulfilled: false, aborted: false };
        routed.push(observation);
        const response = { status: () => status, async dispose() { observation.disposed = true; } };
        await state.route({
          request: () => ({ url: () => url }),
          async fetch(options) {
            observation.fetched = true;
            assert.equal(options.maxRedirects, 0);
            return response;
          },
          async fulfill(options) { assert.equal(options.response, response); observation.fulfilled = true; },
          async abort() { observation.aborted = true; },
          async continue() { assert.fail("Unchecked redirect chains must not continue in the browser"); }
        });
      }
      state.webSocket({ close() { socketCloses += 1; } });
    }
  } });
  const result = await request("/actions", { body: requestBody() });
  assert.equal(result.status, 200);
  assert.deepEqual(routed.map(({ fetched, fulfilled, aborted }) => ({ fetched, fulfilled, aborted })), [
    { fetched: false, fulfilled: false, aborted: true },
    { fetched: true, fulfilled: true, aborted: false },
    { fetched: true, fulfilled: false, aborted: true },
    { fetched: true, fulfilled: false, aborted: true }
  ]);
  assert.equal(socketCloses, 1);
  assert.ok(routed.filter(({ fetched }) => fetched).every(({ disposed }) => disposed));
});

test("a full browser slot rejects new work until the active job cleans up", async (t) => {
  const pending = deferred();
  t.after(() => pending.resolve());
  const { request, state } = await start(t, { browser: { onGoto: () => pending.promise } });
  const first = request("/actions", { body: requestBody() });
  await until(() => state.visits.length === 1);
  const busy = await request("/actions", { body: requestBody() });
  assert.equal(busy.status, 429);
  assert.equal(state.launches, 1);
  pending.resolve();
  assert.equal((await first).status, 200);
  await until(() => state.browserCloses === 1);
  assert.equal((await request("/actions", { body: requestBody() })).status, 200);
});

test("a timed-out launch returns promptly and retains its slot until late browser cleanup", async (t) => {
  const launch = deferred();
  t.after(() => launch.resolve());
  const { request, state } = await start(t, {
    config: { jobTimeoutMs: 30 },
    browser: { onLaunch: (state) => state.launches === 1 ? launch.promise : undefined }
  });
  const response = await Promise.race([
    request("/actions", { body: requestBody() }),
    delay(500).then(() => { throw new Error("The timed-out launch did not produce a bounded HTTP response"); })
  ]);
  assert.equal(response.status, 504);
  assert.equal((await request("/actions", { body: requestBody() })).status, 429);
  launch.resolve();
  await until(() => state.browserCloses === 1);
  assert.equal((await request("/actions", { body: requestBody() })).status, 200);
});

test("stopping the service marks health unavailable and refuses new actions", async (t) => {
  const { request, state, service } = await start(t);
  await service.stop();
  assert.deepEqual(await request("/health", { token: null }).then(({ status, body }) => ({ status, body })), {
    status: 503, body: { ok: false }
  });
  assert.equal((await request("/actions", { body: requestBody() })).status, 503);
  assert.equal(state.launches, 0);
});

test("shutdown cancels a job still validating DNS and lets the client finish", async (t) => {
  const lookupStarted = deferred();
  const lookupResult = deferred();
  const { request, state, service } = await start(t, {
    lookup: async () => { lookupStarted.resolve(); return lookupResult.promise; }
  });
  const response = request("/actions", { body: requestBody() });
  await lookupStarted.promise;
  const stopped = service.stop();
  lookupResult.resolve(await publicLookup());
  assert.equal((await response).status, 503);
  await stopped;
  assert.equal(state.launches, 0);
});
