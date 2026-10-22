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

app.get("/api/config", (req, res) => {
  const { apiToken, domains, proxied } = config.get();
  res.json({
    tokenSet: Boolean(apiToken),
    tokenHint: apiToken ? apiToken.slice(-4) : "",
    domains,
    proxied,
  });
});

app.post("/api/config", async (req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.domains)) {
    return res.status(400).json({ error: "domains must be an array" });
  }

  const domains = [
    ...new Set(
      body.domains
        .map((d) => (typeof d === "string" ? d.trim().toLowerCase() : ""))
        .filter(Boolean)
    ),
  ];

  if (domains.length === 0) {
    return res.status(400).json({ error: "at least one domain is required" });
  }

  const invalid = domains.filter((d) => !HOSTNAME_RE.test(d));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `invalid domain(s): ${invalid.join(", ")}` });
  }

  const proxied = Boolean(body.proxied);

  const current = config.get();
  let apiToken = current.apiToken;
  const rawToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";
  if (rawToken) {
    if (/[\s=]/.test(rawToken)) {
      return res.status(400).json({ error: "API token must not contain whitespace or '='" });
    }
    apiToken = rawToken;
  }

  if (!apiToken) {
    return res.status(400).json({ error: "an API token is required" });
  }

  try {
    await cf.verifyToken(apiToken);
  } catch (err) {
    return res.status(400).json({ error: `token verification failed: ${err.message}` });
  }

  if (apiToken !== current.apiToken) {
    cf.clearZoneCache();
  }

  await config.save({ apiToken, domains, proxied });
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
