import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

// tests/setup.ts (preloaded via bunfig.toml) points homedir() at a throwaway
// directory, so these tests never touch the real ~/.wren/config.json.
const CONFIG_DIR = join(homedir(), ".wren");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `wren-cli-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("config", () => {
  it("uses a throwaway home during tests", () => {
    expect(homedir()).toContain("wren-cli-home-");
  });

  it("returns empty object when no config file exists", async () => {
    const { readConfig } = await import("../../config.ts");
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    expect(readConfig()).toEqual({});
  });

  it("returns empty object when the config file is not valid JSON", async () => {
    const { readConfig } = await import("../../config.ts");
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, "{not json");
    expect(readConfig()).toEqual({});
  });

  it("writes and reads back config", async () => {
    const { readConfig, writeConfig } = await import("../../config.ts");
    const original = readConfig();
    writeConfig({ ...original, url: "http://test:9999", apiKey: "wren_x", cookie: "c=1" });
    const updated = readConfig();
    expect(updated.url).toBe("http://test:9999");
    expect(updated.apiKey).toBe("wren_x");
    expect(updated.cookie).toBe("c=1");
    // Restore
    writeConfig(original);
  });

  it.skipIf(process.platform === "win32")("creates the config file readable only by the user", async () => {
    const { writeConfig } = await import("../../config.ts");
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    writeConfig({ apiKey: "wren_secret" });
    expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
    writeConfig({});
  });
});
