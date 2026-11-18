const express = require("express");
const { timingSafeEqual, createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { dispatchActions, actionHandlers, normalizeActionName } = require("./actions");
const { readConfig, createUrlPolicy, RequestError } = require("./security");

const MAX_ACTIONS = 50;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

function createService(config, dependencies = {}) {
  const browserType = dependencies.chromium || chromium;
  const validateUrl = createUrlPolicy(config.allowedOrigins, dependencies.lookup);
  const app = express();
  const browsers = new Set();
  const jobs = new Set();
  let activeJobs = 0;
  let stopping = false;
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });
  app.get("/health", (_req, res) => res.status(stopping ? 503 : 200).json({ ok: !stopping }));
  const expectedToken = createHash("sha256").update(config.apiToken).digest();
  app.use((req, res, next) => {
    const authorization = req.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const candidate = createHash("sha256").update(supplied).digest();
    if (!supplied || !timingSafeEqual(expectedToken, candidate)) {
      return res.status(401).json({ ok: false, error: "A valid bearer token is required" });
    }
    if (stopping) return res.status(503).json({ ok: false, error: "Service is stopping" });
    next();
  });
  app.use(express.json({ limit: "256kb", strict: true }));
  app.get("/debug/actions", (_req, res) => {
    res.json({ ok: true, supported_actions: Object.keys(actionHandlers).sort() });
  });
  app.post("/actions", async (req, res) => {
    const { url, mode, actions, recordVideo = false } = req.body || {};
    if (mode !== "actions" || !Array.isArray(actions) || actions.length > MAX_ACTIONS || typeof recordVideo !== "boolean") {
      return res.status(400).json({ ok: false, error: "Use mode actions, up to 50 actions, and a boolean recordVideo" });
    }
    if (activeJobs >= config.maxConcurrentJobs) {
      return res.status(429).json({ ok: false, error: "All browser slots are busy; try again later" });
    }
    activeJobs += 1;
    let finishJob;
    const completion = new Promise((resolve) => { finishJob = resolve; });
    jobs.add(completion);
    const deadline = Date.now() + config.jobTimeoutMs;
    let browser;
    let videoDir;
    let timer;
    let expired = false;
    let cancelled = false;
    let closePromise;
    let running;
    const ensureActive = () => {
      if (expired) throw new RequestError("Browser job timed out", 504);
      if (cancelled || stopping) throw new RequestError("Browser job cancelled", 503);
    };
    const closeBrowser = () => {
      if (!browser) return Promise.resolve();
      if (!closePromise) closePromise = browser.close().catch(() => {}).finally(() => browsers.delete(browser));
      return closePromise;
    };
    const onDisconnect = () => {
      if (!res.writableEnded) {
        cancelled = true;
        void closeBrowser();
      }
    };
    res.on("close", onDisconnect);
    try {
      const work = async () => {
        await validateUrl(url);
        for (const step of actions) {
          ensureActive();
          const name = normalizeActionName(step);
          if (!Object.hasOwn(actionHandlers, name || "")) throw new RequestError("Unsupported or invalid action");
          if (Object.hasOwn(step, "path")) throw new RequestError("Server file paths are not accepted");
          if (name === "goto") await validateUrl(step.url === undefined ? url : step.url);
          if (step.timeout === 0) throw new RequestError("Action timeout must be greater than zero");
        }
        ensureActive();
        browser = await browserType.launch({ headless: true, chromiumSandbox: true, timeout: Math.max(1, deadline - Date.now()) });
        browsers.add(browser);
        if (expired || cancelled || stopping) {
          await closeBrowser();
          ensureActive();
        }
        if (recordVideo) videoDir = await fs.mkdtemp(path.join(os.tmpdir(), "playwright-action-"));
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          acceptDownloads: false,
          serviceWorkers: "block",
          ...(recordVideo ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {})
        });
        await context.route("**/*", async (route) => {
          let response;
          try {
            if (expired || cancelled || stopping) return await route.abort("blockedbyclient");
            await validateUrl(route.request().url());
            // Playwright does not route each redirected URL. Fetch without following
            // redirects, then fulfill only the checked response so no redirect escapes.
            response = await route.fetch({ maxRedirects: 0, timeout: Math.max(1, Math.min(30000, deadline - Date.now())) });
            if (response.status() >= 300 && response.status() < 400) {
              await route.abort("blockedbyclient");
            } else {
              await route.fulfill({ response });
            }
          } catch {
            await route.abort("blockedbyclient").catch(() => {});
          } finally {
            if (response) await response.dispose().catch(() => {});
          }
        });
        await context.routeWebSocket("**/*", (socket) => socket.close());
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(15000);
        const video = recordVideo ? page.video() : null;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const results = await dispatchActions(page, actions, { defaultUrl: url, maxOutputBytes: MAX_OUTPUT_BYTES });
        const finalUrl = page.url();
        await validateUrl(finalUrl);
        const data = { results, finalUrl };
        await context.close();
        if (video) {
          const filePath = await video.path();
          const stats = await fs.stat(filePath);
          if (stats.size > MAX_MEDIA_BYTES) throw new RequestError("Video exceeds the 5 MiB output limit", 413);
          data.video = { base64: await fs.readFile(filePath, { encoding: "base64" }) };
        }
        const payload = JSON.stringify({ ok: true, data });
        if (Buffer.byteLength(payload) > MAX_OUTPUT_BYTES) throw new RequestError("Response exceeds the 10 MiB output limit", 413);
        return payload;
      };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          void closeBrowser();
          reject(new RequestError("Browser job timed out", 504));
        }, config.jobTimeoutMs);
      });
      running = work();
      const payload = await Promise.race([running, timeout]);
      if (!res.destroyed && payload) res.type("json").send(payload);
    } catch (error) {
      if (!res.destroyed) {
        const known = error instanceof RequestError;
        res.status(known ? error.status : 502).json({ ok: false, error: known ? error.message : "Browser job failed" });
      }
    } finally {
      clearTimeout(timer);
      await closeBrowser();
      // Respond to deadlines promptly, retaining the slot until late work cleans up.
      if (running) await running.catch(() => {});
      if (videoDir) await fs.rm(videoDir, { recursive: true, force: true }).catch(() => {});
      activeJobs -= 1;
      finishJob();
      jobs.delete(completion);
      res.removeListener("close", onDisconnect);
    }
  });
  app.use((_req, res) => res.status(404).json({ ok: false, error: "Endpoint not found" }));
  app.use((error, _req, res, _next) => {
    const status = error.type === "entity.too.large" ? 413 : 400;
    res.status(status).json({ ok: false, error: "Invalid or oversized JSON request" });
  });
  return {
    app,
    async stop() {
      stopping = true;
      await Promise.allSettled([...browsers].map((browser) => browser.close()));
      await Promise.allSettled([...jobs]);
    }
  };
}

if (require.main === module) {
  try {
    const config = readConfig();
    const service = createService(config);
    const server = service.app.listen(config.port, config.host, () => {
      console.log(`Playwright Action API listening on ${config.host}:${config.port}`);
    });
    server.on("error", () => {
      console.error("Unable to start the service; check HOST and PORT.");
      process.exitCode = 1;
    });
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const deadline = setTimeout(() => process.exit(1), 10000);
      deadline.unref();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await Promise.all([closed, service.stop()]);
      clearTimeout(deadline);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof RequestError ? error.message : "Invalid service configuration");
    process.exitCode = 1;
  }
}

module.exports = { createService };
