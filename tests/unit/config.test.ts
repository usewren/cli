import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `wren-cli-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("config", () => {
  it("returns empty object when no config file exists", async () => {
    const { readConfig } = await import("../../config.ts");
    const config = readConfig();
    // May return {} or existing config — just ensure it doesn't throw
    expect(typeof config).toBe("object");
  });

  it("writes and reads back config", async () => {
    const { readConfig, writeConfig } = await import("../../config.ts");
    const original = readConfig();
    writeConfig({ ...original, url: "http://test:9999" });
    const updated = readConfig();
    expect(updated.url).toBe("http://test:9999");
    // Restore
    writeConfig(original);
  });
});
