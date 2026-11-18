const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const root = path.join(__dirname, "..");
const filePath = path.join(root, ".env");
try {
  const template = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  fs.writeFileSync(filePath, template.replace(/^API_TOKEN=.*$/m, `API_TOKEN=${randomBytes(32).toString("hex")}`), { flag: "wx", mode: 0o600 });
  console.log("Created ignored .env with a fresh token. Keep it private. Run npm start.");
} catch (error) {
  if (error.code === "EEXIST") console.log("Existing .env preserved. Edit it locally if you need to change configuration.");
  else { console.error("Unable to create .env."); process.exitCode = 1; }
}
