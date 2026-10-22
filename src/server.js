import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as config from "./config.js";
import * as cf from "./cloudflare.js";
import * as updater from "./updater.js";
import * as log from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";

if (!AUTH_USER || !AUTH_PASSWORD) {
  console.error(
    "AUTH_USER and AUTH_PASSWORD must both be set (non-empty) — refusing to start without auth."
  );
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");

// --- Basic auth, in front of everything below ------------------------------

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest();
}

function timingSafeEqualStr(a, b) {
  // timingSafeEqual throws on length mismatch, so compare fixed-length
  // digests instead of the raw (variable-length, secret) strings.
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

app.use((req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sepIndex = decoded.indexOf(":");
    if (sepIndex !== -1) {
      const user = decoded.slice(0, sepIndex);
      const pass = decoded.slice(sepIndex + 1);
      if (timingSafeEqualStr(user, AUTH_USER) && timingSafeEqualStr(pass, AUTH_PASSWORD)) {
        return next();
      }
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Cloudflare DDNS"');
  res.status(401).send("Authentication required");
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// --- API ---------------------------------------------------------------

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](-*[a-z0-9])*\.)+[a-z0-9](-*[a-z0-9])*$/i;

const MAX_ALIAS_LENGTH = 64;

// The only shape a token ever leaves the server in: the secret itself is
// never sent back to the browser once saved, just a masked hint.
function maskToken({ id, alias, token }) {
  return { id, alias, masked: `••••••••${token.slice(-4)}` };
}

function parseAlias(raw) {
  const alias = typeof raw === "string" ? raw.trim() : "";
  if (!alias) return { error: "token alias is required" };
  if (alias.length > MAX_ALIAS_LENGTH) {
    return { error: `token alias must be at most ${MAX_ALIAS_LENGTH} characters` };
  }
  return { alias };
}

function aliasTaken(alias, exceptId) {
  const lower = alias.toLowerCase();
  return config.get().tokens.some((t) => t.id !== exceptId && t.alias.toLowerCase() === lower);
}

async function parseToken(raw) {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) return { error: "API token is required" };
  if (/[\s=]/.test(token)) return { error: "API token must not contain whitespace or '='" };
  try {
    await cf.verifyToken(token);
  } catch (err) {
    return { error: `token verification failed: ${err.message}` };
  }
  return { token };
}

app.get("/api/config", (req, res) => {
  const { tokens, domains, proxied } = config.get();
  res.json({ tokens: tokens.map(maskToken), domains, proxied });
});

app.post("/api/tokens", async (req, res) => {
  const body = req.body || {};
  const { alias, error: aliasError } = parseAlias(body.alias);
  if (aliasError) return res.status(400).json({ error: aliasError });
  if (aliasTaken(alias)) {
    return res.status(400).json({ error: `a token named "${alias}" already exists` });
  }

  const { token, error: tokenError } = await parseToken(body.token);
  if (tokenError) return res.status(400).json({ error: tokenError });

  const entry = { id: config.newTokenId(), alias, token };
  await config.save((cur) => ({ tokens: [...cur.tokens, entry] }));
  log.info(`token "${alias}" added`);
  res.json(maskToken(entry));
});

// Rename a token and/or replace its secret. An omitted or blank token keeps
// the stored one.
app.patch("/api/tokens/:id", async (req, res) => {
  const existing = config.tokenById(req.params.id);
  if (!existing) return res.status(404).json({ error: "token not found" });

  const body = req.body || {};
  let alias = existing.alias;
  if (body.alias !== undefined) {
    const parsed = parseAlias(body.alias);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (aliasTaken(parsed.alias, existing.id)) {
      return res.status(400).json({ error: `a token named "${parsed.alias}" already exists` });
    }
    alias = parsed.alias;
  }

  let token = existing.token;
  if (typeof body.token === "string" && body.token.trim()) {
    const parsed = await parseToken(body.token);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    token = parsed.token;
  }

  const updated = { id: existing.id, alias, token };
  await config.save((cur) => ({
    tokens: cur.tokens.map((t) => (t.id === existing.id ? updated : t)),
  }));
  if (token !== existing.token) cf.clearZoneCache();
  log.info(`token "${alias}" updated`);
  res.json(maskToken(updated));
});

app.delete("/api/tokens/:id", async (req, res) => {
  const existing = config.tokenById(req.params.id);
  if (!existing) return res.status(404).json({ error: "token not found" });

  const users = config.get().domains.filter((d) => d.tokenId === existing.id);
  if (users.length > 0) {
    return res.status(409).json({
      error: `token "${existing.alias}" is still used by: ${users.map((d) => d.name).join(", ")}`,
    });
  }

  await config.save((cur) => ({ tokens: cur.tokens.filter((t) => t.id !== existing.id) }));
  cf.clearZoneCache();
  log.info(`token "${existing.alias}" deleted`);
  res.json({ ok: true });
});

app.post("/api/config", async (req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.domains)) {
    return res.status(400).json({ error: "domains must be an array" });
  }

  const seen = new Set();
  const domains = [];
  for (const d of body.domains) {
    const name = typeof d?.name === "string" ? d.name.trim().toLowerCase() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    domains.push({ name, tokenId: typeof d.tokenId === "string" ? d.tokenId : null });
  }

  if (domains.length === 0) {
    return res.status(400).json({ error: "at least one domain is required" });
  }

  const invalid = domains.filter((d) => !HOSTNAME_RE.test(d.name));
  if (invalid.length > 0) {
    return res
      .status(400)
      .json({ error: `invalid domain(s): ${invalid.map((d) => d.name).join(", ")}` });
  }

  const unassigned = domains.filter((d) => !config.tokenById(d.tokenId));
  if (unassigned.length > 0) {
    return res.status(400).json({
      error: `pick an API token for: ${unassigned.map((d) => d.name).join(", ")}`,
    });
  }

  const proxied = Boolean(body.proxied);

  await config.save({ domains, proxied });
  log.info(`configuration saved (${domains.length} domain(s), proxied=${proxied})`);

  const state = await updater.runOnce();
  res.json({ ok: true, records: state.records });
});

app.post("/api/update", async (req, res) => {
  const state = await updater.runOnce();
  res.json({ ok: true, records: state.records });
});

app.get("/api/status", async (req, res) => {
  const state = updater.getState();
  let publicIp = state.lastIp;
  if (!publicIp) {
    try {
      publicIp = await updater.getPublicIp();
    } catch {
      publicIp = null;
    }
  }

  res.json({
    publicIp,
    lastRun: state.lastRun,
    nextRun: updater.nextRunEstimate(),
    isRunning: state.isRunning,
    records: state.records,
    logs: log.recent(50),
  });
});

async function main() {
  await config.load();
  app.listen(PORT, "0.0.0.0", () => {
    log.info(`listening on 0.0.0.0:${PORT}`);
  });
  updater.start();
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
