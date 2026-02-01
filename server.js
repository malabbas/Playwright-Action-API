const express = require("express");
const { chromium } = require("playwright");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/run", async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing or invalid url" });
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

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded"
    });

    const title = await page.title();
    const finalUrl = page.url();
    const status = response ? response.status() : null;

    const screenshotBuffer = await page.screenshot({ type: "png" });

    res.json({
      title,
      finalUrl,
      status,
      screenshotBase64: screenshotBuffer.toString("base64")
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Unexpected error"
    });
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

app.post("/fetch", async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing or invalid url" });
  }

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const title = await page.title();

    res.json({ ok: true, title });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Unexpected error"
    });
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
  console.log(`Playwright service listening on port ${port}`);
});
