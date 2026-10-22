// Scheduler + sync logic: figures out the current public IPv4 and reconciles
// each configured domain's A record against it.

import * as config from "./config.js";
import * as cf from "./cloudflare.js";
import * as log from "./log.js";

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function isValidIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split(".").every((part) => Number(part) <= 255);
}

async function fetchIpFrom(url, extract) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const text = await res.text();
  const ip = extract(text);
  if (!ip || !isValidIpv4(ip)) throw new Error(`${url} did not return a valid IPv4 address`);
  return ip;
}

export async function getPublicIp() {
  try {
    return await fetchIpFrom("https://cloudflare.com/cdn-cgi/trace", (text) => {
      const match = text.match(/^ip=(.+)$/m);
      return match?.[1];
    });
  } catch (err) {
    log.warn(`primary IP lookup (cloudflare trace) failed: ${err.message}, trying fallback`);
    return await fetchIpFrom("https://api.ipify.org", (text) => text.trim());
  }
}

const state = {
  isRunning: false,
  lastRun: null,
  lastIp: null,
  records: [], // [{ domain, status: 'created'|'updated'|'up to date'|'error', message }]
};

export function getState() {
  return state;
}

async function syncDomain(domain, { ip, proxied, zones, token }) {
  const zone = cf.zoneForDomain(domain, zones);
  const existing = await cf.findARecord(zone.id, domain, token);

  if (!existing) {
    await cf.createARecord(zone.id, { name: domain, ip, proxied, token });
    return { domain, status: "created", message: `created A record -> ${ip}` };
  }

  if (existing.content !== ip || existing.proxied !== proxied) {
    await cf.updateARecord(zone.id, existing.id, { name: domain, ip, proxied, token });
    return { domain, status: "updated", message: `updated A record -> ${ip}` };
  }

  return { domain, status: "up to date", message: `already ${ip}` };
}

export async function runOnce() {
  if (state.isRunning) {
    log.info("update already in progress, skipping overlapping run");
    return state;
  }

  const { apiToken, domains, proxied } = config.get();
  if (!apiToken || domains.length === 0) {
    log.info("not configured yet (missing API token or domain list) — skipping run");
    return state;
  }

  state.isRunning = true;
  try {
    let ip;
    try {
      ip = await getPublicIp();
    } catch (err) {
      log.error(`could not determine public IP: ${err.message}`);
      return state;
    }
    state.lastIp = ip;

    let zones;
    try {
      zones = await cf.listZones(apiToken);
    } catch (err) {
      log.error(`could not list Cloudflare zones: ${err.message}`);
      state.records = domains.map((domain) => ({
        domain,
        status: "error",
        message: err.message,
      }));
      return state;
    }

    const results = [];
    for (const domain of domains) {
      try {
        const result = await syncDomain(domain, { ip, proxied, zones, token: apiToken });
        results.push(result);
        if (result.status !== "up to date") log.info(`${domain}: ${result.message}`);
      } catch (err) {
        // One bad domain must not abort the rest of the batch.
        results.push({ domain, status: "error", message: err.message });
        log.error(`${domain}: ${err.message}`);
      }
    }

    state.records = results;
    return state;
  } finally {
    state.lastRun = new Date().toISOString();
    state.isRunning = false;
  }
}

let intervalHandle = null;

export function start() {
  const minutes = Number(process.env.UPDATE_INTERVAL_MINUTES) || 5;
  log.info(`updater starting, checking every ${minutes} minute(s)`);

  runOnce();
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(runOnce, minutes * 60 * 1000);
}

export function nextRunEstimate() {
  const minutes = Number(process.env.UPDATE_INTERVAL_MINUTES) || 5;
  if (!state.lastRun) return null;
  return new Date(new Date(state.lastRun).getTime() + minutes * 60 * 1000).toISOString();
}
