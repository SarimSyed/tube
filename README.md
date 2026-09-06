Logo attribution: <a href="https://www.flaticon.com/free-icons/stage" title="stage icons">Stage icons created by Magnific - Flaticon</a>

# Tube — Self-hosted Stremio addon for Real-Debrid and TorBox

A self-hosted [Stremio](https://www.stremio.com/) addon that works with your
[Real-Debrid](https://real-debrid.com/) or [TorBox](https://torbox.app/) account. It's a reliable alternative to
[Torrentio](https://torrentio.strem.fun/) whose uptime you control yourself, and it
takes inspiration from [Debrid Media Manager](https://debridmediamanager.com/)
(DMM) — but everything lives inside Stremio, so it's fully operable with a remote
on a smart TV or Chromecast.

## What it does

Select your provider on `/configure`, then search normally in Stremio. Open a movie or episode from Cinemeta or another catalog using IMDb IDs; Tube contributes streams alongside your other stream addons. Tube adds no separate search or library rows by default. Each provider has a separate addon identity, so you can install both. Existing Real-Debrid install URLs still work.

Search is not limited to your account: the index discovers torrents, Tube checks the selected provider, adds an available torrent, and returns its direct playback URL. Normal Stremio movie/episode pages also use this search fallback when your cloud has no match.

Optional catalogs (enable `SHOW_LIBRARY_CATALOGS=true` for Library/Downloads or `SHOW_SEARCH_CATALOGS=true` for advanced torrent search):

| Catalog | What it shows |
| --- | --- |
| **RD Library** | Everything already in your Real-Debrid torrents (movies & series) |
| **RD Downloads** | Your unrestricted Real-Debrid hoster links / downloads |
| **RD Search** | One card per title from the search index; available releases appear in the stream picker, ordered by quality with multiple cached options listed |

TorBox offers the equivalent **TB Library** and **TB Search** catalogs; it has no hoster-download catalog. These server settings apply to all installs on that server. Reinstall Tube in Stremio after changing catalog settings so Stremio refreshes its installed manifest.

### Optional TorBox downloads

On `/configure`, choose **TorBox** and enable **Download when no cached stream is available** before generating your install link. Replace your previous Tube TorBox installation with that link. Existing installs remain cached-only; the option is stored per installation, not as a server-wide switch.

With this option enabled, when Tube cannot find a playable cached stream for a
title it lists the uncached releases as **"Download ⬇" rows** (with quality,
size and seeders) below the cached streams. Nothing is started just by opening
a title — clicking one of those rows adds *that* release to your TorBox
account and takes you to the TorBox dashboard. While it downloads, reopening
the title shows a status row for it; reopen again once it finishes to play it.
Tube prefers an existing cached stream and never submits an uncached torrent
unless you click its download row.

The default sends `add_only_if_cached=true`. Only the opted-in installs show
download rows, and only the clicked release is submitted. No uncached torrent
is submitted if the provider cache or library check fails.

Key properties:

- **No video passes through the addon.** The addon serves JSON and redirectable URLs;
  video streams come directly from Real-Debrid or TorBox, so the addon is tiny and
  cheap to run.
- **Token-in-URL.** Your provider token is embedded in your install URL (the same
  model as Torrentio / DMM Cast). Keep the URL private. The server persists blocked
  torrent hashes; account response caches are isolated by provider and token. One
  instance can serve many users.
- **Degrades gracefully.** If the search index is down, your RD Library and
  Downloads still play — the "library" half never depends on external scrapers.

## How it works

- **Normal Stremio title/episode** → cached Cinemeta title lookup → match your cloud or search the torrent index → provider cache check → direct stream. This path does not call TMDB or build custom search cards. Discovery includes torrents outside your account.
- **Library browse** → `Real-Debrid /torrents` + `/downloads`, filenames parsed and
  enriched with posters from TMDB.
- **Library play** → provider torrent details → direct download URL. Real-Debrid
  landing-page links must be unrestricted first.
- **Search** → a [Zilean](https://github.com/iPromKnight/zilean) index plus the
  built-in [The Pirate Bay](https://apibay.org) JSON API (live releases + seeders),
  optionally Jackett/Prowlarr via Torznab → title grouping → provider availability checks.
  TorBox uses its own `/torrents/checkcached` API. If RD instant availability is
  disabled, titles remain visible and bounded probing determines which releases play.
- **Search play** → reuse an existing cloud torrent or add an available magnet,
  resolve the requested video, and return its direct URL. Cached probes are cleaned
  up; existing cloud torrents are retained. An explicitly enabled TorBox download
  is retained while it completes and appears as a dashboard status entry. Confirmed
  blocked hashes are skipped on later attempts; transient API failures are not
  permanently blacklisted.

## Prerequisites

- A **TorBox** account with API access ([API token in settings](https://torbox.app/settings)),
  or a **Real-Debrid** account and its API token:
  <https://real-debrid.com/apitoken>
- An optional **TMDB API key** for enriching the extra catalogs; standard title playback does not need it:
  <https://www.themoviedb.org/settings/api>
- A **search index** (see below).

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: change POSTGRES_PASSWORD; TMDB_API_KEY is optional

# Library + Downloads only (no search index):
docker compose up -d

# Full stack with torrent discovery (Zilean + Postgres):
docker compose --profile search up -d
```

> This runs the published, actively-maintained Zilean image
> (`ghcr.io/solidrhino/zilean`). First start performs a full DMM-hashlist import —
> it takes a while and several GB of RAM once; later syncs are incremental.
> (We plan our own fork later; see `zilean-fork/docs/OUR-FORK.md`.)

### Docker Compose notes

- **`docker compose up -d`** runs Tube only, with the built-in The Pirate Bay
  indexer for discovery — no Postgres involved.
- **`docker compose --profile search up -d`** additionally starts the bundled
  Zilean index and its PostgreSQL database. `POSTGRES_PASSWORD` is only used here.
- The Tube image is built from this repository (`build: .`), so the first `up`
  compiles it; later starts are quick.
- **`POSTGRES_PASSWORD` defaults to `postgres`** if left unset (the compose
  default is `${POSTGRES_PASSWORD:-postgres}`). Set it in `.env` **before the
  first start** — the password is baked into the `zilean-db-data` volume at init,
  so changing it later means recreating the volume:
  `docker compose --profile search down -v`.
- The database is **not published to the host** (no host port mapping); it is only
  reachable by the `zilean` container on the internal Docker network, so the
  default password is low-risk for local use — still, change it as good practice.

Then open `http://<server-ip>:7000/configure`, select your provider, paste its API token, and
click **Install in Stremio** (or copy the manual URL into Stremio → Addons → paste
URL).

### Choosing a search index

Torrent discovery from standard titles and the optional separate search catalog uses these sources:

- **Built-in**: The Pirate Bay (apibay.org JSON API) is enabled by default — live
  releases with seeder counts and IMDb ids, no setup required. YTS (yts.mx) is
  also enabled by default for dedicated movie coverage (quality, seeders, size,
  IMDb ids).
- **Bundled**: enable the `search` compose profile above — it runs the published,
  actively-maintained Zilean image (SolidRhino line) plus PostgreSQL.
- **Any other Zilean instance**: set `ZILEAN_URL` to it.
- **Jackett / Prowlarr**: set `TORZNAB_URL=http://jackett:9117` and
  `TORZNAB_API_KEY=...` to use your own indexers (Torznab protocol).

Without Zilean, discovery still works through The Pirate Bay (and Torznab if configured); Zilean adds the DMM shared-hashlist coverage. Optional library catalogs still work.

## Deploying on your always-on server / NAS / VPS

The addon must run on a machine Stremio can reach over the network (your TV /
Chromecast just runs Stremio and connects to it — it does **not** run the addon).
You only need the **Tube project files**; the search stack is pulled as images.

1. **Get Docker + Compose** on the server (if not present). Debian/Ubuntu:
   `sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2`.

2. **Put the Tube code on the server.** The simplest is version control. From your
   laptop/workspace, put these under git and push, then on the server:
   ```bash
   git clone <your-tube-repo> tube && cd tube
   ```
   (or just copy the folder: `rsync -av --exclude node_modules --exclude .npm-cache --exclude zilean-fork ./ <user>@<server>:~/tube/`)

3. **Configure:**
   ```bash
   cp .env.example .env
   nano .env        # set TMDB_API_KEY, change POSTGRES_PASSWORD
   ```

4. **Start the whole stack** (Tube + Zilean search + Postgres):
   ```bash
   docker compose --profile search up -d
   docker compose --profile search ps     # all three should be healthy/up
   ```
   First start runs a full DMM-hashlist import (several GB RAM, then incremental).

5. **Point Stremio at it.** On the server, get its LAN IP (`hostname -I`), then on
   your phone/PC open `http://<server-ip>:7000/configure`, paste your Real-Debrid
   token, and click **Install in Stremio** (or add the shown URL in Stremio). The
   same addon is then usable from any Stremio client — including your TV/Chromecast.
   (If Stremio says *manifest not found* for the generated `http://` link even
   though a browser shows the manifest, see "Stremio requires HTTPS" below.)

> **Same LAN:** use the server's LAN IP (e.g. `192.168.1.50`). **VPS in the cloud:**
> open/firewall port `7000` (and `8184` for the Zilean dashboard if you want it)
> and use the VPS's public IP or a domain. Video is streamed directly from
> Real-Debrid, so the addon itself carries almost no bandwidth.

### Stremio requires HTTPS (plain-HTTP installs show "manifest not found")

Stremio only installs an addon whose manifest URL is served over **HTTPS**, or
from `127.0.0.1` (see the [addon SDK docs](https://stremio.github.io/stremio-addon-sdk/testing.html)).
A browser will happily display the manifest at a plain
`http://192.168.x.x:7000/<token>/manifest.json` link — that's why the generated
link "looks fine" — but Stremio refuses to fetch an insecure, non-localhost
addon and reports **manifest not found**. Tube's own-machine installs work only
because Stremio treats addresses of the machine it runs on as local.

Options, in increasing order of effort:

- **Just testing, Stremio running on the same machine as Tube:** install
  `http://127.0.0.1:7000/<token>/manifest.json` (localhost is allowed).
- **LAN-only server, no public ports (recommended):** run the bundled Caddy
  front door with a free DuckDNS name (steps below). Every Stremio device on the
  LAN then installs from `https://yourname.duckdns.org/...` — a publicly-trusted
  Let's Encrypt cert is obtained with the DNS-01 challenge, so **no inbound
  internet ports are required**.
- **Cloud/VPS with a domain:** put any HTTPS reverse proxy in front and set
  `BASE_URL=https://your-domain` in `.env`. Tube already honors
  `X-Forwarded-Proto`, so generated links become `https://` automatically.
- **No domain / behind CGNAT:** Tailscale HTTPS (`*.ts.net` certificates are
  publicly trusted) or a Cloudflare Tunnel both provide an HTTPS URL without
  opening ports.

#### Caddy + DuckDNS on a LAN-only server

1. Create a free name at <https://www.duckdns.org> (e.g. `tube.duckdns.org`) and
   copy its token.
2. In `.env`, add:
   ```bash
   TUBE_DOMAIN=tube.duckdns.org
   DUCKDNS_API_TOKEN=<your-token>
   BASE_URL=https://tube.duckdns.org
   ```
3. Start the stack with the Caddy override (also works with `--profile search`):
   ```bash
   docker compose --profile search \
     -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
   ```
   First start compiles a Caddy image with the DuckDNS module, then obtains the
   certificate — check `docker logs caddy`; DNS propagation can take a minute.
4. LAN devices must resolve `tube.duckdns.org` to the server's **LAN** IP:
   DuckDNS points the name at your router's public (WAN) IP, which LAN clients
   cannot use unless the router supports NAT loopback. Either enable loopback,
   add a local DNS override (router dnsmasq / AdGuard Home), or — for a single
   Stremio PC — a hosts-file entry:
   ```
   192.168.0.125  tube.duckdns.org
   ```
5. Open `https://tube.duckdns.org/configure`, generate the install link, and
   install it in Stremio. `/configure` builds `https://` links from `BASE_URL`
   and Caddy forwards the manifest/stream requests to the `tube` container.

> **No Docker for the search backend?** You can still run **Tube alone** (Library +
> Downloads only, no RD Search) with plain Node: `npm ci && npm run build && node
> dist/index.js`. Zilean itself needs Postgres + .NET + Python, so it's only
> practical via its container.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `7000` | HTTP port |
| `RD_API_KEY` | *(empty)* | Optional singleton token; when set, the URL token may be omitted |
| `BASE_URL` | *(auto)* | Force the base URL used in generated links (reverse-proxy friendly) |
| `TMDB_API_KEY` | *(empty)* | Optional poster/name enrichment for extra catalogs; unused by standard-title streams |
| `SHOW_LIBRARY_CATALOGS` | `false` | Show cloud Library and supported Downloads catalogs |
| `SHOW_SEARCH_CATALOGS` | `false` | Show a separate advanced torrent search section |
| `ZILEAN_URL` | *(empty)* | Zilean search index URL |
| `TORZNAB_URL` | *(empty)* | Jackett/Prowlarr Torznab endpoint |
| `TORZNAB_API_KEY` | *(empty)* | Torznab API key |
| `INCLUDE_UNCACHED` | `true` | List uncached search titles too (cached ones stay first); playback of uncached still requires a ready video |
| `MIN_QUALITY` | *(empty)* | Drop standard-title releases below this resolution (e.g. `1080p`) |
| `EXCLUDE_QUALITY` | *(empty)* | Comma-separated source tokens to hide (e.g. `hdcam,cam,ts`) |
| `CACHE_TTL_SECONDS` | `120` | TTL for cached Real-Debrid/TMDB responses |

## Development

```bash
npm install
npm run dev          # tsx watch, http://localhost:7000
npm test             # vitest
npm run typecheck
npm run build        # emit dist/
```

## Limitations / notes

- **Real-Debrid and TorBox** torrent playback are supported. Hoster downloads are
  currently Real-Debrid only. TorBox adds only cached torrents unless the installation explicitly enables the download fallback described above.
- A token URL grants access to that provider account — keep it private, the same
  way you would with a Torrentio or DMM Cast install link.
- Use Stremio's normal search and select a movie or episode. Resolving streams can add
  *cached* torrents to your provider account (that is how instant links are made);
  nothing uncached is ever queued unless you click one of the explicit
  **Download ⬇** rows on a TorBox download-enabled install.
- An uncached or provider-blocked file cannot be played immediately. Tube tries
  matching alternatives and never presents an HTML landing page as a video.
- The stream picker lists several cached releases (sorted by quality). Seeders are
  shown when the source provides them (Torznab indexers and Real-Debrid cloud
  torrents); Zilean/DMM hashlists carry no seeder counts.
- Newly generated search IDs retain title context across restarts. Re-run old
  searches to replace legacy hash-only cards that have lost their cached metadata.
- MKV/HTTP streams carry Stremio playback compatibility hints. Browser playback
  may require a connected Stremio streaming server; the addon does not transcode.
- Zilean or Torznab is still required for discovery. A debrid API key alone is
  not a searchable media index. The Docker `search` profile runs the bundled index.

## Updating an existing Docker install

```bash
docker compose up -d --build --no-deps tube
```

Then open `/configure`, remove the previous Tube addon in Stremio, and install the generated link. This refreshes Stremio's saved manifest and removes the old separate search rows. No API-key change is required for this update. The old `probe-neg.json`
file is ignored because it mixed blocked files with temporary failures; the new
blocked-only store starts fresh automatically.
