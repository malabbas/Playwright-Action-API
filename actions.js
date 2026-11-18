const DEFAULT_SCROLL_BY = 800;
const DEFAULT_MAX_SCROLLS = 10;
const DEFAULT_SCROLL_WAIT_MS = 150;
const { RequestError } = require("./security");

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
  if (typeof action !== "string") {
    return null;
  }
  const normalized = action.trim().toLowerCase();
  const aliases = {
    navigate: "goto",
    go_to: "goto",
    go: "goto"
  };
  return aliases[normalized] || normalized;
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
    const targetUrl =
      typeof step.url === "string"
        ? step.url
        : typeof step.defaultUrl === "string"
          ? step.defaultUrl
          : null;
    if (!targetUrl) {
      throw new Error("goto requires url");
    }
    const waitUntil = typeof step.waitUntil === "string" ? step.waitUntil : "load";
    const timeout = clampNumber(step.timeout, 0, 120000, 30000);
    await page.goto(targetUrl, { waitUntil, timeout });
    return { action: "goto", url: page.url() };
  },
  wait: async (page, step) => {
    const ms = clampNumber(step.ms, 0, 120000, 0);
    await page.waitForTimeout(ms);
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
  screenshot: async (page, step) => {
    const fullPage = Boolean(step.fullPage);
    const buffer = await page.screenshot({ fullPage, timeout: 15000 });
    if (buffer.length > 5 * 1024 * 1024) throw new RequestError("Screenshot exceeds the 5 MiB output limit", 413);
    return { action: "screenshot", base64: buffer.toString("base64") };
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

const dispatchActions = async (page, steps, options = {}) => {
  const results = [];
  const defaultUrl =
    options && typeof options.defaultUrl === "string" ? options.defaultUrl : null;
  const supportedActions = Object.keys(actionHandlers).sort();

  for (const step of steps) {
    const effectiveStep =
      defaultUrl && step && typeof step === "object"
        ? { ...step, defaultUrl }
        : step;
    const action = normalizeActionName(effectiveStep);
    if (!action) {
      throw new Error("Invalid action step");
    }
    const handler = Object.hasOwn(actionHandlers, action) ? actionHandlers[action] : null;
    if (!handler) {
      throw new Error(
        `Unsupported action: ${action}. Supported: ${supportedActions.join(", ")}`
      );
    }
    const result = await handler(page, effectiveStep);
    if (typeof result !== "undefined") {
      results.push(result);
      if (Buffer.byteLength(JSON.stringify(results)) > (options.maxOutputBytes || 10 * 1024 * 1024)) {
        throw new RequestError("Results exceed the 10 MiB output limit", 413);
      }
    }
  }

  return results;
};

module.exports = { dispatchActions, actionHandlers, normalizeActionName };
