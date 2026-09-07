# How Tube turns a search into a playable stream

A plain-English walkthrough with **concrete values** at every step, plus a **tutorial** at
the end showing exactly which function and which values to change to change the result.

If you’re new here, **read Section 1 and Section 3 first** — those give you the whole shape
without drowning in names. The middle sections just repeat Section 3 in more detail with
the actual file/function names so you can find the code.

> Main idea, memorise this one sentence:
> **Tube answers “give me links for title X” by (a) asking “which indexers have X, and are
> those copies cached on my debrid account?” then (b) turning each cached copy into a
> *direct* file URL.** It never downloads or streams video itself.

---

## 1. What actually happens when a user presses play — as a story

You search “Dune” in Stremio. Stremio shows you poster cards. You tap one, then tap play.
Here’s the story of what Tube does — the words in **bold** are the pieces of data flowing
between functions:

1. Stremio hits Tube’s **search page** with the word `Dune`. Tube forwards “Dune” to 2–4
   torrent-index websites and asks each: “do you know Dune?” Each indexer answers with a
   **list of releases** — e.g. one entry is `{infoHash, title:"Dune Part One 2021", quality:"2160p",
   isSeries:false, …}`. Tube merges them, drops duplicates, keeps only movies, and sorts by
   how well the title matches “Dune”.
2. Tube asks your debrid account: “of these hashes, which ones do you already have cached?”
   The answer is a **set of hashes**. Cached copies float to the top; uncached ones are
   removed (unless the addon is set to allow downloads).
3. Tube collapses all the releases for the same title into **one poster card**, and hides a
   pointer inside the card’s id that records *which specific release* that card means.
4. You tap play on that card. Stremio now asks Tube’s **stream page** for the card’s id.
   Tube reads the id, works out which release it is, and asks the debrid “give me the direct
   download URL for that torrent’s video file”. That **direct URL** is put in the response
   as `streams[].url`.
5. Stremio plays that URL straight from the debrid. Tube’s job is done.

That’s it. Everything else in the code is just details of those five steps, plus handling
two flavours of the same thing (browsing your *own* debrid library vs *searching the whole
internet*).

---

## 2. The two kinds of “where does a title come from?”

There are two entry points that both end up at the same place (the `/stream` route):

| User action | Stremio calls | Tube handles with |
|---|---|---|
| Tap a result in **your debrid cloud** (files you already added) | `catalog/{type}/rd-library` then `stream` | `LibraryCatalog` → then resolve the `rd:…` id |
| **Search the internet** for a title you don’t own | `catalog/{type}/rd-search` then `stream` | `SearchCatalog` → then resolve the `sr:…` id |
| Open a **normal title** straight from Stremio’s own Cinemeta row (most common on phone) | `stream` with a `tt…` id | `TtStreamProvider` (auto: cloud first, then index) |

Don’t fixate on these yet. They all funnel into **three shared building blocks** described
in the next section.

---

## 3. The three building blocks (the only functions you really need to know)

Every flow reduces to these. Learn their **inputs → outputs** and you can read any of the
flows below without getting lost.

### Building block A — `parseFilename(filename) → ParsedMedia`
File: `src/meta/parser.ts:174`

Turns a release filename into structured data:

```
input : "Dune.Part.One.2021.2160p.HINDI.7.1.WEB-DL.mkv"
output: {
  title: "Dune Part One",        // cleaned title
  year: 2021,
  isSeries: false,
  quality: "2160p",              // uppercase-ish
  season: undefined, episode: undefined,
  languages: ["Hindi"],          // detected audio languages
  raw: "Dune.Part.One.2021.2160p.HINDI.7.1.WEB-DL.mkv",
}
```

This is how Tube knows a torrent named `Dune...2160p.HINDI` is a 2160p Hindi *movie*.
Nearly every decision downstream starts here. If you change how filenames are understood,
you change everything.

### Building block B — `rd` (the debrid gateway)
Interface: `src/services/realdebrid.ts` (`RdGateway`), impls `realdebrid.ts` + `torbox.ts`.

Every “talk to the user’s debrid account” call goes through this one object. The four you’ll
care about most:

| method | question it answers | returns |
|---|---|---|
| `rd.listTorrents()` | what’s in my cloud? | `[{id, filename, hash, status: 'downloaded'|'downloading', …}]` |
| `rd.instantAvailability(hashes)` | which of these hashes are cached? | `Set<hash>` (or `null` if unknown) |
| `rd.addMagnet(magnet)` | please fetch this torrent | `{id}` |
| `rd.unrestrict(link)` | give me the *direct* file URL | `{download, filename}` |

Note RD and TorBox both implement this, so the rest of the app doesn’t care which one you
use. This is the seam to understand: **`rd` is Tube’s whole interface to debrid.**

### Building block C — `torrentStreams(rd, torrent) → Stream[]`
File: `src/stream/resolver.ts:96`

Turns one *already-downloaded* torrent into playable URLs:

```
input : (rd, a torrent whose files = [ {path:"...mkv", ...}, ... ], maybe season/episode)
output: [ Stream, Stream, ... ]   each: { url: <direct file url>, name, description, ... }
```

Inside it calls `rd.unrestrict` on each video file to get the direct URL. The **label**
(`TB 2160P · Hindi ⚡`) is made here by `playableStream` (`resolver.ts:41`).

---

## 4. A full worked example with real values

Let’s trace one request: a movie you searched on the internet, opening the 2160p Hindi copy.

### Step 1 — Stremio asks for the search catalog
```
GET /{credential}/catalog/movie/rd-search?search=Dune
```
- `credential` is like `torbox:<token>~hindi,tamil` — `routes.ts` decodes it, builds `rd`,
  reads preferred languages `['hindi','tamil']`.
- `SearchCatalog.catalog('movie','Dune',baseUrl)` (`catalogs/search.ts:34`) runs.

### Step 2 — fan the query out to indexers
`searchService.search('Dune','movie')` → `src/services/search.ts:96`.

Each indexer returns releases (their `.search` methods). Say PirateBay + YTS return:

```
[
 { infoHash:"aaaa…", title:"Dune Part One (2021)", raw:"Dune.Part.One.2021.2160p.HINDI.mkv",
   year:2021, isSeries:false, quality:"2160p", sizeBytes:…, seeders:42, source:"yts" },
 { infoHash:"bbbb…", title:"Dune 1984", raw:"Dune.1984.1080p.mkv", year:1984, isSeries:false,
   quality:"1080p", … },
 { infoHash:"cccc…", title:"Dune Part One", raw:"Dune.Part.One.2021.720p.mkv", … },
]
```
`SearchService` dedupes by `infoHash`, keeps only `isSeries === false`, then sorts by
relevance. **Output = ordered list.** (The 1984 movie usually scores lower than a clean
2021 title match, so it lands later.)

### Step 3 — which are cached on your account?
`SearchCatalog.catalog` calls `rd.instantAvailability(hashes)`. Suppose your TorBox has
`aaaa` and `cccc` cached, not `bbbb`. Cached float to the top; uncached `bbbb` is dropped
(no downloads enabled here).

### Step 4 — collapse to one poster card
All “Dune Part One” rows collapse to one card. Its id becomes something like
`sr:aaaa…:<base64 of {title,year,isSeries}>`. `metaService.preview` adds the poster.

**Response to Stremio:** `{ metas: [ { id:"sr:aaaa…:…", name:"Dune: Part One", poster:"…" } ] }`

### Step 5 — you tap play, Stremio asks for streams
```
GET /{credential}/stream/movie/sr:aaaa…:<base64>
```
`routes.ts`: `id` does not start with `tt`, so it goes to `StreamResolver.resolve(id)`
(`stream/resolver.ts:165`) → `parseSearchId` → `resolveSearch`.

### Step 6 — resolve that specific release to a direct URL
`findCachedStreams(rd, [thatRelease], …)` (`cacheProbe.ts:161`):
- TorBox path: `rd.instantAvailability` confirms cached → keep it.
- `rd.addMagnet("magnet:?xt=urn:btih:aaaa…")` → get `{id}`.
- poll `rd.getTorrentInfo(id)` until `downloaded` → gives the torrent’s `files[]`+`links[]`.
- `torrentStreams(rd, info, undefined, undefined)` → for the `…2160p.HINDI.mkv` file, call
  `rd.unrestrict(link)` → direct URL.
- `playableStream(url, "…HINDI.mkv", bytes, 'torbox', seeders)` → builds:

```
{ url: "https://…/file.mkv?token=…",   // DIRECT debrid URL — this is what plays
  name: "TB 2160P · Hindi ⚡",
  description: "…HINDI.mkv\n24.5 GB\n42 seeds",
  behaviorHints: { … } }
```

**Response to Stremio:** `{ streams: [ { url: "https://…", name: "TB 2160P · Hindi ⚡" } ] }`
Stremio plays that URL directly. Done.

---

## 5. The two resolution engines in more detail (only if you need it)

Everything hits `/stream` (`routes.ts`, `streamHandler`). It branches on the id prefix:

### Engine 1 — normal `tt…` titles → `TtStreamProvider.resolve` (`stream/tt.ts:166`)
Used when you open a title straight from Cinemeta (you did *not* use Tube’s search). Logic:

1. Ask Cinemeta for the title’s real name/year (`cinemetaMeta`).
2. **Cloud pass:** scan `rd.listTorrents()`. For each torrent, `parseFilename` it and compare
   title/year/season/episode to the Cinemeta meta. If it’s `downloaded`, resolve it to
   streams (`torrentStreams`). Cloud streams go first.
3. **Index top-up:** if fewer than ~30 streams and an indexer exists (`searchAndAdd`,
   `tt.ts:318`): search the index for the title (+ each preferred language), rank, then
   `findCachedStreams` to check/probe caching. Anything cached streams instantly.

This is why, even for a title you don’t own, the phone search page shows streams: Tube
finds index releases for it and, if your debrid has them cached, returns direct links.

### Engine 2 — our own `rd:`/`sr:` ids → `StreamResolver.resolve` (`stream/resolver.ts:165`)
For cards that came from Tube’s own catalogs.
- `rd:` ids → `resolveLibrary` (`resolver.ts:180`): fetch that exact cloud torrent/download.
- `sr:` ids → `resolveSearch` (`resolver.ts:207`): resolve the specific release from the
  search card, probing sibling cached copies if the clicked one is unavailable.

### The probe helper — `findCachedStreams` (`cacheProbe.ts:161`)
Shared by both engines. Figures out which index candidates are cached and playable now.
Two behaviours by provider:
- **TorBox:** cache check is authoritative & fast; also can queue uncached downloads.
- **Real-Debrid:** classic add-magnet-then-poll, delete-if-uncached, throttle-aware.

---

## 6. TUTORIAL — “I want to change the result I get”

The fastest way to learn is to change something and see the tests react. Pick a goal below;
each tells you **which function is the key**, **what values go in/out**, and **exactly what
to edit**. All have a matching test file.

Run tests while you work:
```bash
npx vitest run tests/tt.test.ts        # or resolver / searchCatalog / cacheProbe
npm test
npm run typecheck
```

### Goal A — change the stream’s visible label (e.g. “TB 2160P · Hindi ⚡”)
**Key function:** `playableStream` — `src/stream/resolver.ts:41`.

- **In:** `url` (direct file url), `filename`, `bytes`, `provider` (`'torbox'`/`'realdebrid'`),
  `seeders`.
- **Out:** a `Stream` object whose `.name`/`.description` Stremio shows.
- **What to change:** the `name:` line, e.g.
  ```js
  name: `${label}${p.quality ? ` ${p.quality}` : ''}${langLine} ⚡`,
  ```
  Change it to `… ${p.quality} [${p.languages.join('/')}]` or drop the ⚡. Because it already
  parsed the filename (`parseFilename`), you have `p.title/p.quality/p.languages/p.isSeries`
  available right here.
- **Test:** `tests/resolver.test.ts` asserts on `.name`. Edit, run, see what breaks.

### Goal B — change which release wins when several are cached (ordering)
**Key function:** `compareStreamCandidates(a, b, preferredLanguages)` —
`src/stream/cacheProbe.ts:49`. Returns a *negative* number if `a` is better than `b`.

- **In:** two `TorrentResult`s + your preferred languages.
- **Order it currently applies:** quality rank → seeders → size → preferred language.
- **What to change:** swap the order of those `if` blocks — e.g. put preferred language
  first, or add a new criterion like “prefer larger seeders over resolution”.
- **Test:** `tests/cacheProbe.test.ts` (comparator cases).

### Goal C — make Tube always show a *minimum* quality or drop cams
**Key function:** `passesQualityFilters(result, minQuality, excludeQuality)` —
`src/stream/cacheProbe.ts:81`. Runs *before* anything is added/probed.

- **In:** one `TorrentResult`, plus config `minQuality`/`excludeQuality` (from `.env`, e.g.
  `MIN_QUALITY=1080p`, `EXCLUDE_QUALITY=hdcam,cam`).
- **Out:** boolean keep/drop.
- **What to change:** add a rule, e.g. also reject results with no seeders, or parse a
  source token (CAM/HDTS) out of `result.raw`.
- **Test:** `tests/cacheProbe.test.ts`.

### Goal D — change how search ranks which *title* is the right “Dune”
**Key function:** `SearchService.search` → `rankByRelevance` — `src/services/search.ts:37`.

- **In:** a result + the raw user query.
- **Out:** a score; higher = more relevant. Currently `coverage*2 + precision`.
- **What to change:** the scoring math, or the earlier token filter at `search.ts` (the
  `queryTokens.every(...)` block) that decides whether a result is kept at all.
- **Test:** `tests/search.test.ts`.

### Goal E — make dubbed/Hindi releases surface more (or less)
Two levers, both about **preferred languages** (the `~hindi,tamil` part of your token):

1. Float-to-top: in `findCachedStreams` (`cacheProbe.ts`), `isPreferred(r)` moves up to 5
   matching releases to the front of the list. Change “5” or the match logic.
2. Extra searches: in `TtStreamProvider.searchAndAdd` (`tt.ts:318`), for each preferred
   language it also runs `search(title + " hindi")`. Add/remove there.

Test files: `cacheProbe.test.ts`, `tt.test.ts`.

### Goal F — add a brand-new torrent indexer (say, your own source)
1. Create a provider object returning `Promise<TorrentResult[]>` for `search(query)` — copy
   the shape of `src/services/yts.ts` (simplest provider, movies-only).
2. Register it in `src/app.ts` where `providers.push(...)` happen (see `piratebay`, `yts`).
3. Write `tests/<name>.test.ts` mocking `fetch`.

### Goal G — make a new provider (not debrid) the answer / add a debrid
That’s a bigger change, but the seam is `RdGateway` (Section 3B). Everything above it
(stream logic, labels, ordering, language) is provider-agnostic, so a new debrid = a new
`RdGateway` implementation + a branch in `createDebridClient` (`services/debrid.ts`).

---

## 7. “Which function should I even look at first?”

A tiny decision map:

- The **request arrives** → `src/routes.ts` (all routes live here).
- **Do we know if it’s cached?** → `rd.instantAvailability` / `findCachedStreams`.
- **Turn a filename into data** → `parseFilename` (`meta/parser.ts`).
- **Turn a downloaded torrent into URLs** → `torrentStreams` → `unrestrict`.
- **Build the visible label** → `playableStream`.
- **Talk to a debrid** → through `rd` (never call RD/TorBox APIs directly).

---

## 8. Glossary of names you’ll meet

- **`TorrentResult`** — one *indexed* release (`{infoHash,title,year,isSeries,quality,season,episode,sizeBytes,seeders,imdbId,raw,source}`).
- **`RdTorrent`/`RdTorrentSummary`** — one torrent *in your debrid cloud* (has `status`,
  and when downloaded, `files[]`+`links[]`).
- **`ParsedMedia`** — output of `parseFilename` (Section 3A).
- **`Stream`** — one playable option Stremio shows (`{url,name,description,behaviorHints}`).
- **`rd`** — the gateway object; the one seam to all debrid providers.
- **cached / ⚡** — the debrid already holds that release → instant.
- **uncached / downloading** — we queued it; only if downloads are allowed.
- **`negatives`** — hashes the debrid blocked as infringing; persisted so we never retry.
- **`rd:` / `sr:` / `tt…` ids** — the three id shapes that decide which engine resolves a
  stream (Section 5).
