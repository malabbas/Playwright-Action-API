/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  timeout: 30000,
  use: {
    browserName: "chromium",
    headless: true
  }
};

module.exports = config;
