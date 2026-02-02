const DEFAULT_SCROLL_BY = 800;
const DEFAULT_MAX_SCROLLS = 10;
const DEFAULT_SCROLL_WAIT_MS = 150;

const clampNumber = (value, min, max, fallback) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
};

const normalizeActionName = (step) => {
  if (!step || typeof step !== "object") {
    return null;
  }
  const action = step.action || step.type;
  return typeof action === "string" ? action.trim().toLowerCase() : null;
};

const getLocator = (page, step) => {
  if (typeof step.selector === "string" && step.selector.trim().length > 0) {
    const locator = page.locator(step.selector.trim());
    if (typeof step.nth === "number") {
      return locator.nth(step.nth);
    }
    return locator;
  }
  if (typeof step.text === "string" && step.text.trim().length > 0) {
    const locator = page.getByText(step.text.trim());
    if (typeof step.nth === "number") {
      return locator.nth(step.nth);
    }
    return locator;
  }
  return null;
};

const actionHandlers = {
  // Add new actions by appending a new handler here.
  // Each handler receives (page, step) and can return a value to push into results.
  goto: async (page, step) => {
    if (typeof step.url !== "string") {
      throw new Error("goto requires url");
    }
    const waitUntil = typeof step.waitUntil === "string" ? step.waitUntil : "load";
    const timeout = clampNumber(step.timeout, 0, 120000, 30000);
    await page.goto(step.url, { waitUntil, timeout });
    return { action: "goto", url: page.url() };
  },
  wait: async (_page, step) => {
    const ms = clampNumber(step.ms, 0, 120000, 0);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { action: "wait", ms };
  },
  scroll: async (page, step) => {
    const locator = getLocator(page, step);
    if (locator) {
      await locator.scrollIntoViewIfNeeded();
      return { action: "scroll", selector: step.selector || step.text || null };
    }
    const scrollBy = clampNumber(step.scrollBy, -2000, 2000, DEFAULT_SCROLL_BY);
    const maxScrolls = clampNumber(
      step.maxScrolls,
      1,
      100,
      DEFAULT_MAX_SCROLLS
    );
    const waitMsBetween = clampNumber(
      step.waitMsBetween,
      0,
      5000,
      DEFAULT_SCROLL_WAIT_MS
    );

    for (let i = 0; i < maxScrolls; i += 1) {
      await page.evaluate((dy) => window.scrollBy(0, dy), scrollBy);
      if (waitMsBetween > 0) {
        await page.waitForTimeout(waitMsBetween);
      }
    }

    return { action: "scroll", scrollBy, maxScrolls };
  },
  click: async (page, step) => {
    const locator = getLocator(page, step);
    if (!locator) {
      throw new Error("click requires selector or text");
    }
    await locator.click();
    return { action: "click" };
  },
  fill: async (page, step) => {
    if (typeof step.value !== "string") {
      throw new Error("fill requires value");
    }
    const locator = getLocator(page, step);
    if (!locator) {
      throw new Error("fill requires selector or text");
    }
    await locator.fill(step.value);
    return { action: "fill" };
  },
  press: async (page, step) => {
    if (typeof step.key !== "string") {
      throw new Error("press requires key");
    }
    if (typeof step.selector === "string") {
      await page.locator(step.selector).press(step.key);
    } else {
      await page.keyboard.press(step.key);
    }
    return { action: "press", key: step.key };
  },
  wait_for: async (page, step) => {
    if (typeof step.selector !== "string") {
      throw new Error("wait_for requires selector");
    }
    const timeout = clampNumber(step.timeout, 0, 120000, 30000);
    await page.waitForSelector(step.selector, { timeout });
    return { action: "wait_for" };
  },
  evaluate: async (page, step) => {
    if (typeof step.script !== "string") {
      throw new Error("evaluate requires script");
    }
    const result = await page.evaluate(step.script);
    return { action: "evaluate", result };
  },
  screenshot: async (page, step) => {
    const path = typeof step.path === "string" ? step.path : null;
    const fullPage = Boolean(step.fullPage);
    const buffer = await page.screenshot({ path: path || undefined, fullPage });
    const data = path ? { path } : { base64: buffer.toString("base64") };
    return { action: "screenshot", ...data };
  },
  extract_text: async (page, step) => {
    if (typeof step.selector !== "string") {
      throw new Error("extract_text requires selector");
    }
    const keepExactText = Boolean(step.keepExactText);
    const text = await page.$eval(step.selector, (element, keepExact) => {
      if (!element) {
        return "";
      }
      const rawText = element.innerText || element.textContent || "";
      if (keepExact) {
        return rawText;
      }
      return rawText.replace(/\s+/g, " ").trim();
    }, keepExactText);
    return { action: "extract_text", text };
  },
  extract_articles: async (page, step) => {
    const patterns = Array.isArray(step.patterns) ? step.patterns : [];
    const containerSelectors = Array.isArray(step.containerSelectors)
      ? step.containerSelectors
      : ["article", "main", "body"];
    const keepExactText = Boolean(step.keepExactText);

    const articles = await page.evaluate(
      ({ selectors, regexSources, keepExact }) => {
        const regexes = regexSources
          .map((source) => {
            try {
              return new RegExp(source, "gi");
            } catch (error) {
              return null;
            }
          })
          .filter(Boolean);

        const normalize = (text) =>
          keepExact ? text : text.replace(/\s+/g, " ").trim();

        const containers = selectors
          .map((selector) => Array.from(document.querySelectorAll(selector)))
          .flat();

        const results = [];

        containers.forEach((container) => {
          const text = normalize(container.innerText || container.textContent || "");
          if (!text) {
            return;
          }
          if (regexes.length === 0) {
            results.push({ text });
            return;
          }
          regexes.forEach((regex) => {
            const matches = text.match(regex);
            if (matches && matches.length > 0) {
              results.push({ text, matches });
            }
          });
        });

        return results;
      },
      { selectors: containerSelectors, regexSources: patterns, keepExact: keepExactText }
    );

    return { action: "extract_articles", articles };
  }
};

const dispatchActions = async (page, steps) => {
  const results = [];

  for (const step of steps) {
    const action = normalizeActionName(step);
    if (!action) {
      throw new Error("Invalid action step");
    }
    const handler = actionHandlers[action];
    if (!handler) {
      throw new Error(`Unsupported action: ${action}`);
    }
    const result = await handler(page, step);
    if (typeof result !== "undefined") {
      results.push(result);
    }
  }

  return results;
};

module.exports = { dispatchActions };
