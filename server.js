const express = require("express");
const { chromium } = require("playwright");
const { dispatchActions, actionHandlers } = require("./actions");

const playwrightVersion =
  process.env.PW_VERSION || require("playwright/package.json").version;

console.log(`BOOT_IMAGE_CHECK: Playwright ${playwrightVersion}`);
console.log("BOOT: server.js loaded");
console.log("SUPPORTED_ACTIONS:", Object.keys(actionHandlers).sort());

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/debug/actions", (_req, res) => {
  res.json({
    ok: true,
    supported_actions: Object.keys(actionHandlers).sort()
  });
});

app.get("/debug/build", (_req, res) => {
  res.json({
    ok: true,
    node: process.version,
    cwd: process.cwd(),
    server_file: __filename,
    render: {
      RENDER_GIT_COMMIT: process.env.RENDER_GIT_COMMIT || "",
      RENDER_SERVICE_ID: process.env.RENDER_SERVICE_ID || ""
    }
  });
});

app.post("/actions", async (req, res) => {
  const { url, mode, actions } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid url" });
  }

  if (mode !== "actions") {
    return res
      .status(400)
      .json({ ok: false, error: "Missing or invalid mode" });
  }

  if (!Array.isArray(actions)) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing or invalid actions" });
  }

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    page = await context.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    await page.goto(url, { waitUntil: "domcontentloaded" });

    const results = await dispatchActions(page, actions, { defaultUrl: url });

    return res.json({
      ok: true,
      data: {
        results,
        finalUrl: page.url()
      }
    });
  } catch (error) {
    return res
      .status(500)
      .json({ ok: false, error: error.message || "Unexpected error" });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Playwright action service listening on port ${port}`);
});
