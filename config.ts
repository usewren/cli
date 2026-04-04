import { join } from "path";
import { homedir } from "os";
import { readFileSync, mkdirSync, writeFileSync } from "fs";

const CONFIG_DIR = join(homedir(), ".wren");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface Config {
  url?: string;
  cookie?: string;
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
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
