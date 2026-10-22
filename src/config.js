// Atomic read/write of the JSON config file that holds the three settings
// this app actually manages: the Cloudflare API token, the domain list, and
// whether records should be proxied.

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const TMP_PATH = `${CONFIG_PATH}.tmp`;

const DEFAULT_CONFIG = { apiToken: "", domains: [], proxied: false };

let current = { ...DEFAULT_CONFIG };
let loaded = false;

export async function load() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    current = {
      apiToken: typeof parsed.apiToken === "string" ? parsed.apiToken : "",
      domains: Array.isArray(parsed.domains) ? parsed.domains : [],
      proxied: Boolean(parsed.proxied),
    };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    current = { ...DEFAULT_CONFIG };
  }
  loaded = true;
  return current;
}

export function get() {
  if (!loaded) {
    throw new Error("config accessed before load() completed");
  }
  return current;
}

export async function save(next) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const merged = {
    apiToken: next.apiToken ?? current.apiToken,
    domains: next.domains ?? current.domains,
    proxied: next.proxied ?? current.proxied,
  };
  const json = JSON.stringify(merged, null, 2);
  await fs.writeFile(TMP_PATH, json, { mode: 0o600 });
  await fs.rename(TMP_PATH, CONFIG_PATH);
  current = merged;
  return current;
}
