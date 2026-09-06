# How Tube resolves streams — a code walkthrough

This document traces what actually happens in the code when someone **searches** for a
title and then **opens it to stream it** inside Stremio, so you can find your way around
and know where to start coding. It matches the current source (routes split into
`src/routes.ts` / `src/app.ts`, `PirateBay` + `YTS` always-on indexers, plus optional
`Zilean` / `Torznab`).

Read it top to bottom once, then jump to **“Where do I start coding?”** at the end.

---

## 1. The big picture

Tube is a Stremio **addon**: Stremio calls a few HTTP endpoints on our server and renders
the JSON we return. There are three resources (see `src/manifest.ts`):

| Endpoint (mounted in `src/routes.ts`) | What Stremio asks for | What we return |
|---|---|---|
| `/:token/manifest.json` | “who are you, what can you do” | addon id, name, catalog list |
| `/:token/catalog/{type}/{id}/...` | “list some titles” (browse/search rows) | `{ metas: [poster cards] }` |
| `/:token/meta/{type}/{id}` | “detail page for one title / episode list” | `{ meta }` |
| `/:token/stream/{type}/{id}` | “give me playable links for this title” | `{ streams: [...] }` |

The single most important invariant, repeated all over the code comments:

> **Video never flows through the addon.** Tube only hands Stremio *direct* debrid URLs.
> It does the work of *finding* which release is cached and *resolving* it to a direct
> file URL, but once you press play, Stremio talks straight to Real-Debrid/TorBox.

`/stream` is the heart of the addon. Everything else (catalog/meta) exists so Stremio has
poster cards whose ids we can turn into streams later.

### Where the files live

```
src/
  index.ts          entry point: loads config, listens on a port (binds nothing itself)
  app.ts            composition root: builds long-lived services + wires routes
  routes.ts         HTTP layer: all Stremio endpoints + /configure
  manifest.ts       the manifest JSON
  configure.ts      the /configure setup page (picker HTML/JS)
  config.ts         reads .env into typed Config
  types.ts          domain types (TorrentResult, RdTorrent, Config, …)
  stremio.ts        minimal Stremio protocol types (Stream, Meta, CatalogResponse, …)
  constants.ts      catalog ids, page size, timeouts
  id.ts             encode/decode this addon's own ids (rd:…, sr:…)
  meta/
    parser.ts       filename -> ParsedMedia (title, season, quality, languages)  [key!]
    meta.ts         MetaService: builds poster/detail cards (TMDB/Cinemeta)
  services/
    realdebrid.ts   RdGateway interface + RealDebridClient (REST client)
    torbox.ts       TorBoxClient: adapts TorBox API to the same RdGateway interface
    debrid.ts       parse the token in the URL -> pick RD vs TorBox client
    cachedRd.ts     CachedRealDebrid: TTL-cache wrapper over any RdGateway
    cache.ts        TtlCache + CacheSet (the in-memory caches)
    negativeStore.ts persisted set of hashes blocked as infringing
    search.ts       SearchService: fan a query out to all indexers, dedupe, rank
    piratebay.ts / yts.ts / zilean.ts / torznab.ts   the torrent indexers
    tmdb.ts         optional poster/name enrichment
  stream/
    tt.ts           resolve a tt… Cinemeta id into streams (cloud + index)
    resolver.ts     StreamResolver: resolve this addon's own rd:/sr: ids
    cacheProbe.ts   findCachedStreams: probe index results against the debrid
  catalogs/
    library.ts      LibraryCatalog: "my cloud" rows
    search.ts       SearchCatalog: advanced index search rows
tests/              vitest specs (mocks of fetch, one per module)
```

---

## 2. The debrid gateway abstraction (read this first — everything hangs off it)

Almost every layer talks to the debrid through one interface, `RdGateway`
(`src/services/realdebrid.ts`). Two implementations implement it:

- `RealDebridClient` (`realdebrid.ts`) — calls Real-Debrid’s REST API.
- `TorBoxClient` (`torbox.ts`) — adapts TorBox’s API into the *same* shape.

`CachedRealDebrid` (`cachedRd.ts`) wraps either one and adds TTL caching.

This is why the rest of the code barely knows whether you use RD or TorBox. The
interface methods you’ll meet in the flows below:

```ts
interface RdGateway {
  provider?: 'realdebrid' | 'torbox';      // used to label streams TB / RD
  allowUncached?: boolean;                 // may queue uncached downloads
  listTorrents(): RdTorrentSummary[];      // what's in my cloud
  getTorrentInfo(id): RdTorrent;           // status + files + links of one torrent
  listDownloads(): RdDownload[];           // RD web-downloads (TorBox returns [])
  addMagnet(magnet, cachedOnly?): {id};    // ask the debrid to fetch a magnet
  selectAllFiles(id); deleteTorrent(id);
  unrestrict(link): {download, filename};  // landing page -> DIRECT file url  [key]
  instantAvailability(hashes): Set|null;   // which hashes are already cached
}
```

The **credential string** in the URL (the `:token` segment) decides which client gets
built — see `createDebridClient` in `services/debrid.ts`:

- `torbox-download:<token>~langs` → TorBox, downloads allowed
- `torbox:<token>~langs`        → TorBox
- `<token>~langs`               → Real-Debrid

---

## 3. Flow: the configure/install step

1. User opens `/configure` → `renderConfigurePage` (`configure.ts`) returns HTML; the page
   JS builds an install URL like
   `https://…/torbox-download%3A<token>~hindi%2Ctamil/manifest.json`.
2. Stremio installs that URL → fetches `manifest.json`. The `:token` segment carries the
   credential. `manifestHandler` (`routes.ts`) calls `createDebridClient(token,…)` just to
   read `.provider` and builds a manifest whose addon id/name/catalog set differ for RD vs
   TorBox.
3. All later catalog/meta/stream requests carry the same `:token`, so handlers can rebuild
   the right client per request via `resolveToken` → `clientFor` (`routes.ts`).

---

## 4. Flow: SEARCHING (getting title cards)

There are actually **two search surfaces**, and they feed streams differently:

### A) Your own cloud: `catalog/{type}/rd-library` (and `rd-downloads`)

Handled by `LibraryCatalog` (`catalogs/library.ts`):

1. `rd.listTorrents()` (and/or `listDownloads()`) → raw filenames.
2. Each filename → `parseFilename()` (`meta/parser.ts`) → `ParsedMedia`
   (title, year, `isSeries`, season/episode, quality, languages).
3. Filter to the requested `type`, paginate (`PAGE_SIZE`, `skip`).
4. Each entry becomes a **meta card** with an id built by `id.ts`:
   - torrent → `rd:<torrentId>`
   - download → `rd:dl:<downloadId>`
   - series single episode later → `rd:<torrentId>:<season>:<episode>`
5. Cards are enriched into posters/names by `MetaService.preview` (`meta/meta.ts`,
   TMDB if a key is set, else Cinemeta).

### B) Index search: `catalog/{type}/rd-search` (the “search anything” path)

Handled by `SearchCatalog` (`catalogs/search.ts`) — this is the DMM-like live search:

1. `extra.search` query → `searchService.search(query, type)` (`services/search.ts`).
2. `SearchService` fans the query out to every registered `TorrentProvider` in parallel
   (`Promise.allSettled`), dedupes by `infoHash` (preferring copies that carry an IMDb id),
   applies a title-token filter, restricts to movie/series, re-ranks by query relevance,
   caches the result.
3. The providers are registered once in `app.ts`:
   `ZileanProvider` (opt-in, needs URL+key) → `PirateBayProvider` → `YtsProvider` (movies)
   → `TorznabProvider` (opt-in). Each returns `TorrentResult[]` — one object per release
   with `infoHash`, `title`, `sizeBytes`, `quality`, `season/episode`, `seeders`, `imdbId`,
   `isSeries`, `raw`, `source`.
4. Back in `SearchCatalog.catalog`, availability is checked with
   `rd.instantAvailability(hashes)` — results already cached are floated to the top.
   Unless `includeUncached` is on, uncached results are dropped.
5. Duplicate *titles* collapse to **one poster card**; the releases stay hidden for later.
   The card’s id encodes the specific release via `searchId()` → `sr:<infoHash>:<base64 context>`
   (the base64 keeps title/imdb info recoverable even after the cache clears).
6. `metaService.preview` gives the card a poster/name.

> **Why ids matter:** the poster card’s `id` is what Stremio later asks `/stream` for.
> `rd:` ids point at a specific torrent in your cloud; `sr:` ids point at a specific
> indexed release (by info hash). When you search for a *series*, cards get episodes via
> `meta` (see next).

### Meta for a card: `meta/{type}/{id}`

`metaHandler` (`routes.ts`) routes:
- `tt…` ids → proxied to Cinemeta (posters/detail).
- `sr:` ids → `SearchCatalog.meta` builds a detail (series episodes come from canonical
  Cinemeta via `MetaService.seriesMeta`, else from re-searching same-title results).
- `rd:` ids → `LibraryCatalog.meta` builds a detail; a season-pack torrent is expanded
  into per-episode `videos` each with an `rd:…:s:e` id.

---

## 5. Flow: VIEWING A STREAM (`stream/{type}/{id}`)  ← the core

`streamHandler` in `routes.ts` does:

```ts
const rd = clientFor(token);                     // build RD/TorBox client (+cache)
const negatives = rd.provider === 'torbox' ? torboxNegatives : negativeStore;
const langs = preferredLanguages(token);         // the ~hindi,tamil list
const resolver  = new StreamResolver(rd, { search, caches, negatives, preferredLanguages: langs });
const ttProvider = new TtStreamProvider(rd, caches, { search, negatives, preferredLanguages: langs, qualityFilters });

const promise = id.startsWith('tt')
  ? ttProvider.resolve(type, id)      // standard Cinemeta title/episode
  : resolver.resolve(id);             // our own rd:/sr: ids
```

So there are **two resolution engines** depending on the id shape.

### Engine 1 — `TtStreamProvider.resolve(type, id)` (`stream/tt.ts`)

Used when Stremio opens a **normal Cinemeta title** (`tt123…` or `tt…:season:episode`).

1. Fetch the title’s name/year from Cinemeta (`cinemetaMeta`, TTL-cached) so we can match.
2. `rd.listTorrents()` and scan your **cloud** for matching releases:
   - `parseFilename(t.filename)` → title/year/isSeries/season/episode/quality/languages;
   - compare normalized title to the Cinemeta name (`normTitle` + bigram similarity);
   - enforce movie vs series and the requested season/episode.
3. Only `status === 'downloaded'` torrents qualify (only those have playable links).
4. `rd.getTorrentInfo(id)` then `torrentStreams(rd, info, season, episode)` → one `Stream`
   per playable file (details in §6). Cloud streams go first, deduped by URL, capped at 30.
5. **Top-up:** if fewer than 30 so far and an indexer is available, `searchAndAdd`:
   - searches the index by title (`searchService.search`),
   - also searches each preferred language explicitly (`"Title hindi"`, `skipTitleFilter`)
     so dubbed releases surface,
   - ranks candidates (title/episode score, then quality→seeders→size→language),
   - pre-filters to index-known-cached hashes when possible (avoids debrid add-throttling),
   - calls `findCachedStreams(...)` to *probe* them against the debrid (see §7).
6. Series + downloads-on: if this episode was itself queued as a download, also pre-fetch
   the next episode (`queueNextEpisode`) for binge continuity.

### Engine 2 — `StreamResolver.resolve(id)` (`stream/resolver.ts`)

Used when Stremio asks about one of **our own ids** (from a catalog card).

- `parseLibraryId(id)` → `resolveLibrary`:
  - `rd:dl:<id>` → look up in `rd.listDownloads()`, direct URL → one stream.
  - `rd:<torrentId>` or `rd:<tid>:<s>:<e>` → `rd.getTorrentInfo`; if not `downloaded`,
    return an explanatory empty list; else `torrentStreams(rd, info, season?, episode?)`.
- `parseSearchId(id)` (an `sr:` id) → `resolveSearch`:
  - recover the clicked release (embedded base64 context or the search cache),
  - if we know its title, probe that title’s cached copies (clicked one first) so a
    blocked/uncached pick falls through to a sibling release,
  - else probe just the bare hash — both via `findCachedStreams` (§7).

---

## 6. How a release becomes a playable `Stream` (`torrentStreams`)

This is in `resolver.ts`. Given a downloaded `RdTorrent` with `files[]` and `links[]`:

1. `resolveFiles`: map each of the torrent’s `links[]` (download URLs) to its source file —
   filename match first, positional fallback.
2. Filter to video files (`.mkv/.mp4/…`, excluding `sample`).
3. Narrow to the requested season/episode when given.
4. For each candidate call **`rd.unrestrict(url)`**:
   - **Real-Debrid:** `links[]` are HTML landing pages, so `unrestrict` POSTs to
     `/unrestrict/link` and returns `{ download }` — the **direct** file URL.
   - **TorBox:** `links[]` are internal `torbox://{torrent}/{file}/{name}` refs (no
     credentials embedded), and `unrestrict` resolves them via `/requestdl` to a direct URL.
5. `playableStream(url, filename, bytes, provider, seeders)` builds the final object:
   ```js
   { url: <direct https file>,
     name: `TB 2160P · Hindi ⚡`,           // TB=TorBox, RD=Real-Debrid; ⚡ = cached/playable
     description: `<filename>\n<size>\n<seeders>`,
     behaviorHints: { bingeGroup, filename, videoSize, notWebReady } }
   ```
6. If `unrestrict` reports the file as blocked/infringing (`isBlockedFileError`), the
   torrent’s hash is added to the **negatives** set (persisted) so we never try it again.

---

## 7. Probing the index: `findCachedStreams` (`stream/cacheProbe.ts`)

When we have *index candidates* (not yet known to be in the cloud) we must find out which
are actually cached and instantly playable. Two provider strategies:

**TorBox fast path** (check is authoritative, no add-throttle):
1. `rd.instantAvailability(hashes)` → cached set; keep only cached ones.
2. Deterministic sort (`quality → seeders → size → preferred language` via
   `compareStreamCandidates`) and collapse true duplicates (same quality *and* known size).
3. Preferred-language releases float to the top.
4. If `allowUncached` and we’re under the target, submit a few uncached releases as
   background downloads and surface them as “TorBox — downloading” placeholder streams.

**Real-Debrid probe path** (classic add-magnet + poll):
1. For each candidate in order: `addMagnet("magnet:?xt=urn:btih:<hash>")`.
2. Poll `getTorrentInfo` until it reaches `downloaded` (or a hard terminal state like
   `error`/`dead`), within a grace window.
3. If it reaches `waiting_files_selection`, `selectAllFiles`, then keep polling.
4. `downloaded` → `torrentStreams(...)` → playable `Stream`s, deduped by URL.
5. If it stayed uncached/queued, **delete it again** (`deleteTorrent`) so the user’s
   account stays clean, and move to the next candidate.
6. Throttle/auth (429/401/403) aborts the whole probe (back off, keep what we have);
   only genuine “blocked file” errors are recorded as negatives and skipped.

Bounded throughout (`maxAttempts`, `timeoutMs`, `addDelayMs`, caps on new downloads) so one
request never hammers the debrid.

---

## 8. Supporting machinery

- **Caches** (`cache.ts`, `cachedRd.ts`): separate `TtlCache`s for torrent list, torrent
  info, downloads, instant-availability, TMDB (30× TTL), search, and misc. `CachedRealDebrid`
  namespaces entries per account (`cacheKey`) and invalidates on mutations.
- **Negatives** (`negativeStore.ts`): file-backed set of hashes blocked as infringing,
  keyed separately for RD vs TorBox so one provider’s blocks don’t poison the other
  (created in `app.ts`, passed into routes).
- **Language preference** (`debrid.ts` → `preferredLanguages`): parsed from the `~langs`
  suffix; used to float matching releases to the top and to run per-language index searches.
- **Quality filters** (`cacheProbe.ts`): `passesQualityFilters` enforces configured
  `minQuality` / `excludeQuality` before anything is added to the debrid.
- **`parseFilename`** (`meta/parser.ts`) is load-bearing everywhere — it turns release
  filenames into structured data (title, quality, season/episode, languages). Many flows
  reduce to “parse filename → compare to what we want”.

---

## 9. Where do I start coding?

Best strategy: **pick one request and follow it, writing/reading a test for it.** The test
suite is the map — every module in `tests/` mocks `fetch` (RD/TorBox/indexers) and drives a
real instance, so you can iterate fast without a debrid account.

**Orienting anchors**
- To see a request shape end-to-end, read `tests/tt.test.ts`, `tests/resolver.test.ts`,
  and `tests/cacheProbe.test.ts` — they show stream resolution with mocked debrid/index.
- `tests/configure.test.ts` runs the configure page’s JS in a VM and checks the generated
  URL.
- Read `tests/parser.test.ts` first if you plan to touch filename parsing.

**Common starting points by task**

| I want to… | Start here |
|---|---|
| Understand/change how a stream URL is produced | `torrentStreams` + `playableStream` in `stream/resolver.ts` |
| Add a torrent index source | implement `TorrentProvider` (model it on `yts.ts` / `piratebay.ts`), register it in `app.ts`, add `tests/<name>.test.ts` |
| Change how search ranks results | `SearchService.search` (`services/search.ts`) + `compareStreamCandidates` (`cacheProbe.ts`) |
| Change preferred-language behavior | `findCachedStreams` + `hasPreferredLanguage` (`cacheProbe.ts`) + `searchAndAdd` in `stream/tt.ts` |
| Change quality gating | `passesQualityFilters` (`cacheProbe.ts`) + the `qualityFilters` wiring in `routes.ts` |
| Support a new debrid provider | implement `RdGateway` (mirror `TorBoxClient`), branch in `createDebridClient` (`services/debrid.ts`), map it in `routes.ts`/`manifest.ts` |
| Add/change an id shape | `id.ts` (encode/decode) + the branches in `routes.ts` (tt vs rd:/sr:), `resolver.ts`, `SearchCatalog.meta`, `LibraryCatalog.meta` |
| Change the configure page UI | `configure.ts` (it’s one big HTML template; tests in `configure.test.ts`) |
| Change a catalog row set | `catalogs/library.ts`, `catalogs/search.ts` |

**A concrete “first exercise”** to orient yourself:
Open `tests/resolver.test.ts`. Note how the test builds a fake `RdGateway` (or mocks
`fetch`), calls `StreamResolver`/`torrentStreams`, and asserts on the returned `streams[].url`.
Then change `playableStream`’s label logic in `stream/resolver.ts` (e.g. the name format)
and watch that test — and the tt tests — tell you what you broke. That loop
(module → its test → edit → run `npm test`) is the fastest way to get productive.

```bash
npm test                 # whole suite
npx vitest run tests/resolver.test.ts   # one file
npm run typecheck        # TS errors
npm run dev              # run locally on :7000 (needs a real token to be useful)
```

---

## 10. Quick glossary

- **TorrentResult** — one indexed release (hash, title, quality, season/ep, size, seeders…).
- **RdGateway** — the debrid abstraction (RD or TorBox). Always go through it, never call a
  vendor API directly from a flow.
- **`unrestrict`** — turning a debrid *landing* link into a *direct* file URL. This is what
  makes streams actually playable.
- **negatives** — hashes the debrid blocked as infringing; persisted so we don’t retry them.
- **Cached** (vs uncached/downloading) — a release the debrid already holds vs one we must
  queue. Cached = instant ⚡ stream; uncached = only if downloads are allowed, shown as
  “downloading”.
- **`rd:` / `sr:` ids** — Tube’s self-owned stream ids (cloud item / indexed search hit).
  Normal `tt…` ids go through `TtStreamProvider` instead.
