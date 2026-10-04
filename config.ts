import { join } from "path";
import { homedir } from "os";
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from "fs";

const CONFIG_DIR = join(homedir(), ".wren");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface Config {
  url?: string;
  cookie?: string;
  /** API key (wren_…). Takes precedence over cookie; WREN_API_KEY overrides both. */
  apiKey?: string;
}

export function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(config: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  // The file can hold a session cookie or an API key: keep it private to the user
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* not supported on every filesystem */ }
}
