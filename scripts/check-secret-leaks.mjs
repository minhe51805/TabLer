import { execFileSync } from "node:child_process";
import fs from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !/\.(?:png|jpg|jpeg|gif|ico|icns|lock)$/i.test(file));
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/],
  ["OpenAI key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
];
const findings = [];
for (const file of tracked) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}
if (findings.length > 0) {
  throw new Error(`Potential tracked secrets found:\n${findings.join("\n")}`);
}
console.log(`Secret scan passed for ${tracked.length} tracked text files.`);
