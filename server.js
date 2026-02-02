const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { dispatchActions, actionHandlers } = require("./actions");

const playwrightVersion =
  process.env.PW_VERSION || require("playwright/package.json").version;

console.log(`BOOT_IMAGE_CHECK: Playwright ${playwrightVersion}`);
console.log("BOOT: server.js loaded");
console.log("SUPPORTED_ACTIONS:", Object.keys(actionHandlers).sort());

const app = express();
const port = process.env.PORT || 3000;
const VIDEO_DIR = "/tmp/videos";
const VIDEO_RETENTION_MINUTES = Number.parseInt(
  process.env.VIDEO_RETENTION_MINUTES || "60",
  10
);

const cleanupOldVideos = async () => {
  let entries;
  try {
    entries = await fs.readdir(VIDEO_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const cutoff = Date.now() - VIDEO_RETENTION_MINUTES * 60 * 1000;
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(VIDEO_DIR, entry.name);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await fs.unlink(filePath);
          }
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.warn(`Failed to cleanup video ${filePath}:`, error);
          }
        }
      })
  );
};

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
  const { url, mode, actions, recordVideo } = req.body || {};

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
  let video;
  let videoPath;
  let videoBase64;

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

    if (recordVideo === true) {
      await fs.mkdir(VIDEO_DIR, { recursive: true });
      await cleanupOldVideos();
    }

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ...(recordVideo === true
        ? {
            recordVideo: {
              dir: VIDEO_DIR,
              size: { width: 1280, height: 720 }
            }
          }
        : {})
    });

    page = await context.newPage();
    if (recordVideo === true) {
      video = page.video();
    }
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    await page.goto(url, { waitUntil: "domcontentloaded" });

    const results = await dispatchActions(page, actions, { defaultUrl: url });
    const finalUrl = page.url();

    if (recordVideo === true && video) {
      await page.close();
      page = null;
      await context.close();
      context = null;
      videoPath = await video.path();
      videoBase64 = await fs.readFile(videoPath, { encoding: "base64" });
    }

    return res.json({
      ok: true,
      data: {
        results,
        finalUrl,
        ...(recordVideo === true
          ? {
              video: {
                path: videoPath,
                base64: videoBase64
              }
            }
          : {})
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
