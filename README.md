# Cloudflare DDNS GUI

A tiny, standalone, self-hosted GUI + updater for Cloudflare DDNS. It replaces
[favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) with a single
container that:

- serves a light-themed web UI to manage your Cloudflare API tokens (several, each
  with an alias), the list of domains and which token each one uses, and whether
  they're proxied,
- and on a timer, checks this machine's public **IPv4** address and creates/updates
  the corresponding Cloudflare A records to match.

It only handles IPv4 A records — no IPv6, no other record types, no WAF lists. If you
need those, stick with favonia.

## Quick start

The image is published on Docker Hub as
[`sivikee/cloudflare-ddns-gui`](https://hub.docker.com/r/sivikee/cloudflare-ddns-gui)
(amd64 and arm64). You only need `docker-compose.yml` and `.env.example` from this
repo — no need to build anything. To build from source instead, swap the `image:`
line in `docker-compose.yml` for `build: .`.

1. Copy the env template and set your own GUI login credentials:

   ```sh
   cp .env.example .env
   ```

   Edit `.env` and set `AUTH_USER` / `AUTH_PASSWORD` to something real — these are
   just the credentials for logging into the GUI, not the Cloudflare token.

2. Start it:

   ```sh
   docker compose up -d
   ```

   To upgrade later: `docker compose pull && docker compose up -d`.

3. Open `http://<your-server>:8080` and log in with the credentials from `.env`.
   The GUI has four tabs:
   - **Dashboard** — public IP, number of domains, health of the last run, time
     of the next run, and an **Update now** button.
   - **Domains** — click **Add Domain**, enter e.g. `home.example.org`, pick the
     Cloudflare API token it should use (or choose **+ New token…** to save a new
     one under an alias like `personal` or `work`), and set **Proxied**
     (orange cloud, on by default) or turn it off for DNS only (grey cloud).
     Each domain has its own token and proxied setting, so domains in different
     Cloudflare accounts can sit side by side. Use the ⋮ menu on a row to edit or
     remove it — removing only stops managing it; the DNS record stays in
     Cloudflare.
   - **Cloudflare API Tokens** — add, rename, replace or delete saved tokens.
     New tokens are verified with Cloudflare before they're stored. Once saved,
     a token is never sent back to the browser — the GUI only ever sees its alias
     and last 4 characters. A token can't be deleted while a domain uses it.
   - **Activity Log** — recent updates and errors.

4. Saving a domain writes the config and immediately runs an update. After that
   it re-checks and reconciles on the interval set by `UPDATE_INTERVAL_MINUTES`
   (default: every 5 minutes).

## Required Cloudflare token permissions

Create the token at **My Profile → API Tokens → Create Token** with:

- `Zone / Zone / Read`
- `Zone / DNS / Edit`

scoped to the zone(s) that contain the domains that token is used for. **Both are required** — without
`Zone:Read` the app can't figure out which zone a domain belongs to, even if the
DNS edit permission is correct, and you'll see a "no matching zone found" error.

## Migrating from favonia

Stop and remove the old favonia container first (`docker compose down` in its
project, or `docker rm -f <container>`). Running both at once means they'll fight
over the same DNS records.

## Notes on security

- Cloudflare API tokens are stored in plaintext in `data/config.json`
  (mode `0600`) so the updater can use it. Don't expose that volume, and don't
  commit it — it's already covered by `.gitignore`.
- Login is a normal login page backed by an `HttpOnly`, `SameSite=Strict`
  session cookie (valid for 7 days). Sessions are kept in memory, so restarting
  the container logs you out. After 5 failed attempts from one IP, logins from it
  are blocked for 15 minutes.
- If this GUI is reachable from anywhere you don't fully trust (i.e. anything
  other than a private LAN/VPN), put it behind a reverse proxy that terminates
  TLS — without HTTPS the password and session cookie travel in the clear. The
  cookie is marked `Secure` automatically when the proxy sends
  `X-Forwarded-Proto: https`.
- The container runs as root by default so it can write into the bind-mounted
  `./data` directory. If you'd rather run it as an unprivileged user, add
  `user: "1000:1000"` to `docker-compose.yml` and `chown -R 1000:1000 ./data` on
  the host first — otherwise it won't be able to write the config file.

## Configuration reference

Environment variables (set in `.env`, read by `docker-compose.yml`):

| Variable                  | Required | Default | Purpose                              |
|---------------------------|----------|---------|---------------------------------------|
| `AUTH_USER`                | yes      | —       | GUI login username                    |
| `AUTH_PASSWORD`            | yes      | —       | GUI login password                    |
| `UPDATE_INTERVAL_MINUTES`  | no       | `5`     | How often to reconcile DNS records    |

Everything else (tokens, domains, per-domain proxied) is set through the GUI and stored in
`data/config.json`. A config from an older single-token version is migrated
automatically on startup: the old token becomes one named `default` and every
existing domain is assigned to it. A global proxied setting from an older
version is copied onto each domain.
