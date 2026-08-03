import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const distRoot = path.join(webRoot, "dist");

const BANNED_PATTERNS = [
  { pattern: /start\.bat/i, reason: "obsolete Windows launcher" },
  { pattern: /Claude Code[^\n]{0,80}(automatically|自动)(configured|配置)/i, reason: "unsupported automatic client configuration claim" },
  { pattern: /memory[^\n]{0,30}(port|端口)[^\n]{0,20}9338[^\n]{0,20}(all tools|全部工具|single|单体)/i, reason: "obsolete monolithic 9338 claim" },
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

if (!fs.existsSync(path.join(distRoot, "index.html"))) {
  throw new Error("landing-build-missing-index");
}

const files = walk(distRoot).filter((file) => /\.(?:html|js|css|json|txt)$/i.test(file));
if (files.length === 0) {
  throw new Error("landing-build-empty");
}

const violations = [];
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  for (const rule of BANNED_PATTERNS) {
    if (rule.pattern.test(content)) {
      violations.push({ file: path.relative(webRoot, file), reason: rule.reason });
    }
  }
}

if (violations.length > 0) {
  throw new Error(`landing-build-content-invalid:${JSON.stringify(violations)}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, filesChecked: files.length })}\n`);
