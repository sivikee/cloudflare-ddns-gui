// Atomic read/write of the JSON config file that holds the settings this app
// manages: the stored Cloudflare API tokens (each with an alias), the domain
// list (each domain pointing at one token), and whether records are proxied.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const TMP_PATH = `${CONFIG_PATH}.tmp`;

// tokens:  [{ id, alias, token }]
// domains: [{ name, tokenId }]
const DEFAULT_CONFIG = { tokens: [], domains: [], proxied: false };

let current = structuredClone(DEFAULT_CONFIG);
let loaded = false;

// Older configs had a single top-level apiToken and domains as plain strings.
// Convert those into one "default" token that every domain points at.
function normalize(parsed) {
  const tokens = Array.isArray(parsed.tokens)
    ? parsed.tokens.filter(
        (t) => t && typeof t.id === "string" && typeof t.token === "string" && t.token
      ).map((t) => ({ id: t.id, alias: String(t.alias || "unnamed"), token: t.token }))
    : [];

  let legacyId = null;
  if (typeof parsed.apiToken === "string" && parsed.apiToken && tokens.length === 0) {
    legacyId = crypto.randomUUID();
    tokens.push({ id: legacyId, alias: "default", token: parsed.apiToken });
  }

  const domains = Array.isArray(parsed.domains)
    ? parsed.domains
        .map((d) =>
          typeof d === "string"
            ? { name: d, tokenId: legacyId }
            : d && typeof d.name === "string"
              ? { name: d.name, tokenId: typeof d.tokenId === "string" ? d.tokenId : null }
              : null
        )
        .filter(Boolean)
    : [];

  return { tokens, domains, proxied: Boolean(parsed.proxied) };
}

export async function load() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const migrated = typeof parsed.apiToken === "string";
    current = normalize(parsed);
    if (migrated) await write(current);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    current = structuredClone(DEFAULT_CONFIG);
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

async function write(next) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const json = JSON.stringify(next, null, 2);
  await fs.writeFile(TMP_PATH, json, { mode: 0o600 });
  await fs.rename(TMP_PATH, CONFIG_PATH);
}

// Serialize saves so two overlapping requests can't race on the tmp file or
// clobber each other's changes. `next` may be a partial config, or a function
// that receives the latest config and returns one (for read-modify-write).
let saveChain = Promise.resolve();

export function save(nextOrFn) {
  const run = saveChain.then(async () => {
    const next = typeof nextOrFn === "function" ? nextOrFn(current) : nextOrFn;
    const merged = {
      tokens: next.tokens ?? current.tokens,
      domains: next.domains ?? current.domains,
      proxied: next.proxied ?? current.proxied,
    };
    await write(merged);
    current = merged;
    return current;
  });
  saveChain = run.catch(() => {});
  return run;
}

export function tokenById(id) {
  return get().tokens.find((t) => t.id === id) || null;
}

export function newTokenId() {
  return crypto.randomUUID();
}
