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
  const allowed = new Set([
    "full",
    "min",
    "extract",
    "law_page",
    "relevant",
    "match_window",
    "search_window"
  ]);
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

const normalizeArabicText = (text) => {
  if (typeof text !== "string") {
    return "";
  }
  return text
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/\s+/g, " ")
    .trim();
};

const normalizeArabicTextWithMap = (text) => {
  if (typeof text !== "string") {
    return { normalizedText: "", indexMap: [] };
  }
  const indexMap = [];
  const chars = [];
  let lastWasSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/.test(char)) {
      continue;
    }
    if (/\s/.test(char)) {
      if (lastWasSpace) {
        continue;
      }
      lastWasSpace = true;
      chars.push(" ");
      indexMap.push(i);
      continue;
    }
    lastWasSpace = false;
    let normalizedChar = char;
    if (/[\u0622\u0623\u0625\u0671]/.test(char)) {
      normalizedChar = "\u0627";
    } else if (char === "\u0649") {
      normalizedChar = "\u064A";
    } else if (char === "\u0629") {
      normalizedChar = "\u0647";
    }
    chars.push(normalizedChar);
    indexMap.push(i);
  }

  return { normalizedText: chars.join("").trim(), indexMap };
};

const buildKeywordSet = (terms) => {
  if (!Array.isArray(terms)) {
    return [];
  }
  const englishStopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "been",
    "but",
    "by",
    "for",
    "from",
    "has",
    "have",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "then",
    "there",
    "these",
    "this",
    "to",
    "was",
    "were",
    "with"
  ]);
  const arabicStopwords = new Set([
    "و",
    "في",
    "على",
    "من",
    "الى",
    "إلى",
    "عن",
    "مع",
    "هو",
    "هي",
    "هذا",
    "هذه",
    "ذلك",
    "تلك",
    "هناك",
    "هنا",
    "الذي",
    "التي",
    "الذين",
    "ما",
    "لا",
    "نعم",
    "كان",
    "تكون"
  ]);
  const keywords = new Set();

  for (const term of terms) {
    if (typeof term !== "string") {
      continue;
    }
    const cleaned = term.replace(/\*\*/g, " ");
    const tokens = cleaned.match(/[A-Za-z0-9]+|[\u0600-\u06FF]+/g) || [];
    for (const token of tokens) {
      if (!token) {
        continue;
      }
      const normalizedToken = /[\u0600-\u06FF]/.test(token)
        ? normalizeArabicText(token)
        : token.toLowerCase();
      if (!normalizedToken) {
        continue;
      }
      if (englishStopwords.has(normalizedToken)) {
        continue;
      }
      if (arabicStopwords.has(normalizedToken)) {
        continue;
      }
      keywords.add(normalizedToken);
    }
  }

  return Array.from(keywords);
};

const splitParagraphsWithOffsets = (text) => {
  const paragraphs = [];
  if (!text) {
    return paragraphs;
  }
  const separatorRegex = /\n{2,}/g;
  let start = 0;
  let match;

  while ((match = separatorRegex.exec(text)) !== null) {
    const end = match.index;
    const raw = text.slice(start, end);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const trimmedStart = start + leading;
    const trimmedEnd = end - trailing;
    const paragraphText = raw.trim();
    if (paragraphText) {
      paragraphs.push({
        text: paragraphText,
        start: trimmedStart,
        end: Math.max(trimmedStart, trimmedEnd)
      });
    }
    start = end + match[0].length;
  }

  if (start <= text.length) {
    const raw = text.slice(start);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const trimmedStart = start + leading;
    const trimmedEnd = text.length - trailing;
    const paragraphText = raw.trim();
    if (paragraphText) {
      paragraphs.push({
        text: paragraphText,
        start: trimmedStart,
        end: Math.max(trimmedStart, trimmedEnd)
      });
    }
  }

  return paragraphs;
};

const countOccurrences = (text, term) => {
  if (!text || !term) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(term, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + term.length;
  }
  return count;
};

const mapNormalizedRangeToOriginal = (indexMap, textLength, start, end) => {
  if (!indexMap.length || start >= end) {
    return { start: 0, end: 0 };
  }
  const safeStart = Math.max(0, Math.min(start, indexMap.length - 1));
  const safeEnd = Math.max(0, Math.min(end - 1, indexMap.length - 1));
  const originalStart = indexMap[safeStart] ?? 0;
  const originalEnd = (indexMap[safeEnd] ?? textLength - 1) + 1;
  return {
    start: Math.max(0, Math.min(originalStart, textLength)),
    end: Math.max(0, Math.min(originalEnd, textLength))
  };
};

const mergeWindows = (windows) => {
  if (windows.length === 0) {
    return [];
  }
  const sorted = windows.slice().sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
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

const logExtractedLengths = ({ contentText, fullText, lawText }) => {
  console.log(
    `[fetch] extracted lengths: content=${contentText.length}, full=${fullText.length}, law=${lawText.length}`
  );
};

const logResponseLength = (label, text) => {
  console.log(`[fetch] response length before res.json (${label}): ${text.length}`);
};

app.post("/fetch", async (req, res) => {
  const {
    url,
    mode = "min",
    maxChars = 200000,
    windowChars = 6000,
    maxMatches = 3,
    startAfter,
    terms,
    maxWindows = 4,
    selectors = { title: "h1", content: "article, main" },
    extract = null,
    actions = [],
    timeoutMs = 45000,
    question,
    topic
  } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing or invalid url" });
  }

  const normalizedMode = normalizeMode(mode);
  const safeMaxChars = clampNumber(maxChars, 1, 300000, 200000);
  const defaultWindowChars =
    normalizedMode === "search_window" ? 5000 : 6000;
  const safeWindowChars = clampNumber(
    windowChars,
    200,
    200000,
    defaultWindowChars
  );
  const safeMaxMatches = clampNumber(maxMatches, 1, 25, 3);
  const safeMaxWindows = clampNumber(maxWindows, 1, 25, 4);
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
    logExtractedLengths({ contentText, fullText, lawText });

    const responseBase = {
      ok: true,
      inputUrl: url,
      finalUrl,
      title: titleText
    };

    if (normalizedMode === "full") {
      const html = await page.content();
      const text = fullText;
      const totalLength = fullText.length;
      const truncated = totalLength > safeMaxChars;
      logResponseLength("full.text", text);
      return res.json({
        ...responseBase,
        html,
        text,
        returnedChars: text.length,
        totalLength,
        truncated
      });
    }

    if (normalizedMode === "extract") {
      const extracted = await extractFields(page, extract);
      const trimmedContent = contentText;
      const totalLength = contentText.length;
      const truncated = totalLength > safeMaxChars;
      logResponseLength("extract.contentText", trimmedContent);
      return res.json({
        ...responseBase,
        extracted,
        contentText: trimmedContent,
        returnedChars: trimmedContent.length,
        totalLength,
        truncated
      });
    }

    if (normalizedMode === "law_page") {
      const lawMinText = lawText;
      const totalLength = lawText.length;
      const truncated = totalLength > safeMaxChars;
      logResponseLength("law_page.minText", lawMinText);
      return res.json({
        ...responseBase,
        minText: lawMinText,
        returnedChars: lawMinText.length,
        totalLength,
        truncated
      });
    }

    if (normalizedMode === "relevant" && question) {
      const relevantText = pickRelevantText(contentText, question);
      const totalLength = relevantText.length;
      const truncated = totalLength > safeMaxChars;
      logResponseLength("relevant.minText", relevantText);
      return res.json({
        ...responseBase,
        minText: relevantText,
        returnedChars: relevantText.length,
        totalLength,
        truncated
      });
    }

    if (normalizedMode === "match_window") {
      if (!topic || typeof topic !== "string") {
        return res.status(400).json({ error: "Missing or invalid topic" });
      }
      const normalizedTopic = normalizeArabicText(topic);
      const { normalizedText, indexMap } =
        normalizeArabicTextWithMap(contentText);
      const matchIndices = [];
      if (normalizedTopic && normalizedText) {
        let startIndex = 0;
        while (startIndex < normalizedText.length) {
          const foundIndex = normalizedText.indexOf(
            normalizedTopic,
            startIndex
          );
          if (foundIndex === -1) {
            break;
          }
          matchIndices.push(foundIndex);
          startIndex = foundIndex + normalizedTopic.length;
        }
      }
      const matchCount = matchIndices.length;

      if (matchCount === 0) {
        const fallbackText = contentText;
        const totalLength = fallbackText.length;
        const truncated = totalLength > safeMaxChars;
        logResponseLength("match_window.relevantText.fallback", fallbackText);
        return res.json({
          ...responseBase,
          relevantText: fallbackText,
          returnedChars: fallbackText.length,
          totalLength,
          truncated,
          matchCount
        });
      }

      const halfWindow = Math.floor(safeWindowChars / 2);
      const windows = matchIndices.map((matchIndex) => ({
        start: Math.max(0, matchIndex - halfWindow),
        end: Math.min(normalizedText.length, matchIndex + halfWindow)
      }));
      const mergedAll = mergeWindows(windows);
      const mergedWindows = mergedAll.slice(0, safeMaxMatches);

      let relevantText = "";
      let truncated = false;

      for (let i = 0; i < mergedWindows.length; i += 1) {
        const window = mergedWindows[i];
        const { start, end } = mapNormalizedRangeToOriginal(
          indexMap,
          contentText.length,
          window.start,
          window.end
        );
        const segment = contentText.slice(start, end).trim();
        if (!segment) {
          continue;
        }
        const separator = relevantText ? "\n\n" : "";
        const nextChunk = separator + segment;
        relevantText += nextChunk;
      }

      if (mergedWindows.length < mergedAll.length) {
        truncated = true;
      }

      if (relevantText.length > safeMaxChars) {
        truncated = true;
      }

      logResponseLength("match_window.relevantText", relevantText);
      return res.json({
        ...responseBase,
        relevantText,
        returnedChars: relevantText.length,
        truncated,
        totalLength: relevantText.length,
        matchCount
      });
    }

    if (normalizedMode === "search_window") {
      if (!Array.isArray(terms) || terms.length === 0) {
        return res.status(400).json({ error: "Missing or invalid terms" });
      }
      const keywordList = buildKeywordSet(terms);
      let workingText = contentText;
      if (startAfter && typeof startAfter === "string") {
        const startIndex = workingText.indexOf(startAfter);
        if (startIndex !== -1) {
          workingText = workingText.slice(startIndex);
        }
      }

      const paragraphs = splitParagraphsWithOffsets(workingText);
      if (keywordList.length === 0 || paragraphs.length === 0) {
        const fallbackText = workingText;
        const totalLength = fallbackText.length;
        const truncated = totalLength > safeMaxChars;
        logResponseLength("search_window.relevantText.fallback", fallbackText);
        return res.json({
          ...responseBase,
          relevantText: fallbackText,
          truncated,
          totalLength,
          matchCount: 0
        });
      }

      const scored = paragraphs.map((paragraph) => {
        const normalizedParagraph = normalizeArabicText(
          paragraph.text.toLowerCase()
        );
        const score = keywordList.reduce(
          (total, keyword) =>
            total + countOccurrences(normalizedParagraph, keyword),
          0
        );
        return { ...paragraph, score };
      });

      const sortedByScore = scored
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      const selected = sortedByScore.slice(0, safeMaxWindows);
      const matchCount = sortedByScore.reduce(
        (total, entry) => total + entry.score,
        0
      );

      if (selected.length === 0) {
        const fallbackText = workingText;
        const totalLength = fallbackText.length;
        const truncated = totalLength > safeMaxChars;
        logResponseLength("search_window.relevantText.fallback", fallbackText);
        return res.json({
          ...responseBase,
          relevantText: fallbackText,
          truncated,
          totalLength,
          matchCount
        });
      }

      const halfWindow = Math.floor(safeWindowChars / 2);
      const windows = selected.map((entry) => ({
        start: Math.max(0, entry.start - halfWindow),
        end: Math.min(workingText.length, entry.end + halfWindow)
      }));
      const mergedAll = mergeWindows(windows);
      const mergedWindows = mergedAll.slice(0, safeMaxWindows);

      let relevantText = "";
      let truncated = false;

      for (let i = 0; i < mergedWindows.length; i += 1) {
        const window = mergedWindows[i];
        const segment = workingText.slice(window.start, window.end).trim();
        if (!segment) {
          continue;
        }
        const separator = relevantText ? "\n\n" : "";
        const nextChunk = separator + segment;
        relevantText += nextChunk;
      }

      if (mergedWindows.length < mergedAll.length) {
        truncated = true;
      }

      if (relevantText.length > safeMaxChars) {
        truncated = true;
      }

      logResponseLength("search_window.relevantText", relevantText);
      return res.json({
        ...responseBase,
        relevantText,
        truncated,
        totalLength: relevantText.length,
        matchCount
      });
    }

    const minText = contentText;
    const totalLength = minText.length;
    const truncated = totalLength > safeMaxChars;
    logResponseLength("min.minText", minText);
    return res.json({
      ...responseBase,
      minText,
      returnedChars: minText.length,
      totalLength,
      truncated
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
