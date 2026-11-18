const { readConfig } = require("../security");
(async () => {
  const config = readConfig();
  const url = config.allowedOrigins[0];
  const response = await fetch(`http://127.0.0.1:${config.port}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiToken}` },
    body: JSON.stringify({ url, mode: "actions", actions: [{ action: "extract_text", selector: "h1" }, { action: "screenshot" }] }),
    signal: AbortSignal.timeout(config.jobTimeoutMs + 5000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  console.log(JSON.stringify({ ok: true, finalUrl: result.data.finalUrl, heading: result.data.results[0].text, screenshotBytes: Buffer.from(result.data.results[1].base64, "base64").length }, null, 2));
})().catch(() => {
  console.error("Demo failed. Check that npm start is running, Chromium is installed, and the configured origin is reachable.");
  process.exitCode = 1;
});
