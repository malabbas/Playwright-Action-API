const express = require("express");
const { chromium } = require("playwright");

const playwrightVersion =
  process.env.PW_VERSION || require("playwright/package.json").version;

console.log(`BOOT_IMAGE_CHECK: Playwright ${playwrightVersion}`);

console.log("BOOT: server.js loaded");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.type("text").send("SERVER_OK_v1");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const listRoutes = (appInstance) =>
  appInstance._router.stack
    .filter((layer) => layer.route && layer.route.path)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).map((method) =>
        method.toUpperCase()
      )
    }));

app.get("/routes", (_req, res) => {
  res.json({ routes: listRoutes(app) });
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

const normalizeMode = (mode) => {
  const allowed = new Set(["full", "min", "extract", "law_page", "relevant"]);
  if (typeof mode !== "string") {
    return "min";
  }
  const normalized = mode.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : "min";
};

const clampNumber = (value, min, max, fallback) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
};

const normalizeSelectors = (selectors) => {
  const defaultSelectors = { title: "h1", content: "article, main" };
  if (!selectors || typeof selectors !== "object") {
    return defaultSelectors;
  }
  return {
    title:
      typeof selectors.title === "string" && selectors.title.trim().length > 0
        ? selectors.title.trim()
        : defaultSelectors.title,
    content:
      typeof selectors.content === "string" &&
      selectors.content.trim().length > 0
        ? selectors.content.trim()
        : defaultSelectors.content
  };
};

const truncateText = (text, maxChars) => {
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
};

const runActions = async (page, steps, timeoutMs) => {
  for (const step of steps) {
    const action = step && (step.action || step.type);
    if (!action || typeof action !== "string") {
      throw new Error("Invalid action step");
    }
    const optional = Boolean(step.optional);
    try {
      await executeAction(page, action, step, timeoutMs);
    } catch (error) {
      if (!optional) {
        throw error;
      }
    }
  }
};

const executeAction = async (page, action, step, timeoutMs) => {
  switch (action) {
    case "wait": {
      const ms = clampNumber(step.ms, 0, timeoutMs, 0);
      await page.waitForTimeout(ms);
      return;
    }
    case "waitForSelector": {
      if (typeof step.selector !== "string") {
        throw new Error("waitForSelector requires selector");
      }
      await page.waitForSelector(step.selector, {
        timeout: clampNumber(step.timeoutMs, 0, timeoutMs, timeoutMs)
      });
      return;
    }
    case "waitForNetworkIdle": {
      await page.waitForLoadState("networkidle", {
        timeout: clampNumber(step.timeoutMs, 0, timeoutMs, timeoutMs)
      });
      return;
    }
    case "click": {
      if (typeof step.selector !== "string") {
        throw new Error("click requires selector");
      }
      await page.click(step.selector);
      return;
    }
    case "clickText": {
      if (typeof step.text !== "string") {
        throw new Error("clickText requires text");
      }
      const clicked = await page.evaluate((targetText) => {
        const isVisible = (element) => {
          if (!element) {
            return false;
          }
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(
          document.querySelectorAll(
            'button, [role="button"], a, input[type="button"], input[type="submit"]'
          )
        );
        const match = candidates.find((element) => {
          const text =
            element.tagName === "INPUT"
              ? element.value || ""
              : element.textContent || "";
          return isVisible(element) && text.trim() === targetText;
        });
        if (!match) {
          return false;
        }
        match.click();
        return true;
      }, step.text);
      if (!clicked) {
        throw new Error(`clickText could not find element: ${step.text}`);
      }
      return;
    }
    case "type": {
      if (typeof step.selector !== "string" || typeof step.text !== "string") {
        throw new Error("type requires selector and text");
      }
      const clearFirst =
        typeof step.clearFirst === "boolean" ? step.clearFirst : true;
      if (clearFirst) {
        await page.fill(step.selector, step.text);
      } else {
        await page.type(step.selector, step.text);
      }
      return;
    }
    case "press": {
      if (typeof step.key !== "string") {
        throw new Error("press requires key");
      }
      await page.keyboard.press(step.key);
      return;
    }
    case "scrollTo": {
      const y = clampNumber(step.y, -1000000, 1000000, 0);
      await page.evaluate((scrollY) => {
        window.scrollTo(0, scrollY);
      }, y);
      return;
    }
    case "scrollBy": {
      const dy = clampNumber(step.dy, -1000000, 1000000, 0);
      await page.evaluate((scrollDy) => {
        window.scrollBy(0, scrollDy);
      }, dy);
      return;
    }
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
};

const extractPageText = async (page, selectors) =>
  page.evaluate((selectorConfig) => {
    const stripElements = () => {
      document
        .querySelectorAll("nav, footer, header, aside, script, style")
        .forEach((element) => element.remove());
    };

    const normalize = (text) =>
      text
        .replace(/\r/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+\n/g, "\n")
        .trim();

    const titleElement = document.querySelector(selectorConfig.title);
    const titleText = titleElement ? titleElement.textContent.trim() : "";

    stripElements();

    const contentElement = document.querySelector(selectorConfig.content);
    const contentText = normalize(
      contentElement ? contentElement.innerText || "" : document.body.innerText
    );
    const fullText = normalize(document.body.innerText || "");
    const lawLines = fullText
      .split("\n")
      .filter((line) =>
        /المادة|الفصل|الباب/.test(line) || /^#{1,6}\s+/.test(line)
      )
      .join("\n");

    return {
      titleText,
      contentText,
      fullText,
      lawText: lawLines
    };
  }, selectors);

const extractFields = async (page, extractMap) => {
  if (!extractMap || typeof extractMap !== "object") {
    return {};
  }
  const entries = Object.entries(extractMap).filter(
    ([key, selector]) => key && typeof selector === "string"
  );
  if (entries.length === 0) {
    return {};
  }
  return page.evaluate((fields) => {
    const extracted = {};
    for (const [key, selector] of fields) {
      const element = document.querySelector(selector);
      extracted[key] = element ? element.textContent.trim() : "";
    }
    return extracted;
  }, entries);
};

const pickRelevantText = (contentText, questionText) => {
  if (!questionText || typeof questionText !== "string") {
    return contentText;
  }
  const questionTerms = questionText
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);
  if (questionTerms.length === 0) {
    return contentText;
  }
  const paragraphs = contentText
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter(Boolean);
  const scored = paragraphs.map((paragraph) => {
    const lower = paragraph.toLowerCase();
    const score = questionTerms.reduce(
      (total, term) => total + (lower.includes(term) ? 1 : 0),
      0
    );
    return { paragraph, score };
  });
  const top = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.paragraph);
  if (top.length === 0) {
    return paragraphs.slice(0, 5).join("\n\n");
  }
  return top.join("\n\n");
};

app.post("/fetch", async (req, res) => {
  const {
    url,
    mode = "min",
    maxChars = 12000,
    selectors = { title: "h1", content: "article, main" },
    extract = null,
    actions = [],
    timeoutMs = 45000,
    question
  } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing or invalid url" });
  }

  const normalizedMode = normalizeMode(mode);
  const safeMaxChars = clampNumber(maxChars, 1, 200000, 12000);
  const actionSteps = Array.isArray(actions) ? actions.slice(0, 25) : [];
  const safeSelectors = normalizeSelectors(selectors);

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
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    });

    if (actionSteps.length > 0) {
      await runActions(page, actionSteps, timeoutMs);
    }

    const finalUrl = page.url();
    const { titleText, contentText, fullText, lawText } =
      await extractPageText(page, safeSelectors);

    const responseBase = {
      ok: true,
      inputUrl: url,
      finalUrl,
      title: titleText
    };

    if (normalizedMode === "full") {
      const html = await page.content();
      const text = truncateText(fullText, safeMaxChars);
      return res.json({
        ...responseBase,
        html,
        text,
        returnedChars: text.length,
        truncated: text.length < fullText.length
      });
    }

    if (normalizedMode === "extract") {
      const extracted = await extractFields(page, extract);
      const trimmedContent = truncateText(contentText, safeMaxChars);
      return res.json({
        ...responseBase,
        extracted,
        contentText: trimmedContent,
        returnedChars: trimmedContent.length,
        truncated: trimmedContent.length < contentText.length
      });
    }

    if (normalizedMode === "law_page") {
      const lawMinText = truncateText(lawText, safeMaxChars);
      return res.json({
        ...responseBase,
        minText: lawMinText,
        returnedChars: lawMinText.length,
        truncated: lawMinText.length < lawText.length
      });
    }

    if (normalizedMode === "relevant" && question) {
      const relevantText = truncateText(
        pickRelevantText(contentText, question),
        safeMaxChars
      );
      return res.json({
        ...responseBase,
        minText: relevantText,
        returnedChars: relevantText.length,
        truncated: relevantText.length < contentText.length
      });
    }

    const minText = truncateText(contentText, safeMaxChars);
    return res.json({
      ...responseBase,
      minText,
      returnedChars: minText.length,
      truncated: minText.length < contentText.length
    });
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
