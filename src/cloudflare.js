// Thin client over the Cloudflare API v4 — only the calls this app needs:
// verifying a token, listing zones, and reading/writing a single A record.

const BASE_URL = "https://api.cloudflare.com/client/v4";

async function cf(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`Cloudflare returned a non-JSON response (HTTP ${res.status})`);
  }

  // Cloudflare can return HTTP 200 with success: false, so status code alone
  // is not a reliable success signal — always check the envelope.
  if (!payload.success) {
    const message = payload.errors?.[0]?.message || `request failed (HTTP ${res.status})`;
    throw new Error(message);
  }

  return payload;
}

export async function verifyToken(token) {
  await cf("/user/tokens/verify", { token });
}

// Cache resolved zone lists for a while so every domain in a sync doesn't
// trigger its own /zones call. Keyed by token so a token change invalidates it.
const zoneCache = new Map(); // token -> { zones, expiresAt }
const ZONE_CACHE_TTL_MS = 60 * 60 * 1000;

export function clearZoneCache() {
  zoneCache.clear();
}

export async function listZones(token) {
  const cached = zoneCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.zones;
  }

  const zones = [];
  let page = 1;
  // Cloudflare paginates at up to 50 per page; loop until result_info says we're done.
  for (;;) {
    const payload = await cf(`/zones?per_page=50&page=${page}`, { token });
    zones.push(...payload.result);
    const info = payload.result_info;
    if (!info || page >= info.total_pages) break;
    page += 1;
  }

  zoneCache.set(token, { zones, expiresAt: Date.now() + ZONE_CACHE_TTL_MS });
  return zones;
}

// Pick the zone whose name is the longest matching suffix of the domain, so
// e.g. "sub.example.co.uk" resolves to "example.co.uk" rather than "co.uk"
// if the token happens to have access to both.
export function zoneForDomain(domain, zones) {
  let best = null;
  for (const zone of zones) {
    const isMatch = domain === zone.name || domain.endsWith(`.${zone.name}`);
    if (isMatch && (!best || zone.name.length > best.name.length)) {
      best = zone;
    }
  }
  if (!best) {
    throw new Error(
      `no matching zone found for "${domain}" — does the token have Zone:Read access to it?`
    );
  }
  return best;
}

export async function findARecord(zoneId, name, token) {
  const payload = await cf(
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    { token }
  );
  return payload.result[0] || null;
}

export async function createARecord(zoneId, { name, ip, proxied, token }) {
  await cf(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    token,
    // ttl: 1 means "automatic" and is required by Cloudflare whenever proxied is true.
    body: { type: "A", name, content: ip, proxied, ttl: 1 },
  });
}

export async function updateARecord(zoneId, recordId, { name, ip, proxied, token }) {
  await cf(`/zones/${zoneId}/dns_records/${recordId}`, {
    method: "PATCH",
    token,
    body: { type: "A", name, content: ip, proxied, ttl: 1 },
  });
}
