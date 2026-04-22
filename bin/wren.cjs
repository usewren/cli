#!/usr/bin/env node
// This wrapper detects whether Bun is available and uses it to run the CLI.
// The actual CLI is written in TypeScript and requires Bun's TS loader.
const { execFileSync } = require("child_process");
const { join } = require("path");
try {
  execFileSync("bun", [join(__dirname, "..", "index.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
} catch (e) {
  if (e.status) process.exit(e.status);
  console.error("wren-cli requires Bun (https://bun.sh). Install it with: curl -fsSL https://bun.sh/install | bash");
  process.exit(1);
}
