#!/usr/bin/env node
/**
 * Mock backend for rate-limit-free integration testing.
 *
 * Mimics the three external APIs Tube talks to:
 *   - Real-Debrid   (http://127.0.0.1:PORT/rest/1.0/...)
 *   - Zilean search (http://127.0.0.1:PORT/dmm/search)
 *   - Cinemeta meta (http://127.0.0.1:PORT/meta/:type/:id.json)
 *
 * Usage:
 *   node mock/mock-backends.mjs [port]            # default 8100
 *   MOCK_DISABLE_IA=1 node mock/mock-backends.mjs # instantAvailability -> 403 disabled_endpoint
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8100);
const DISABLE_IA = process.env.MOCK_DISABLE_IA === '1';

// ---------------------------------------------------------------- RD dataset
// A tiny but realistic Real-Debrid cloud. Hashes chosen to match Zilean results.
const TORRENTS = {
  IBH3ADESV5XPM: {
    id: 'IBH3ADESV5XPM',
    filename: 'The Boy in the Striped Pyjamas (2008) (1080p BluRay x265 HEVC 10bit AAC 5.1 RZeroX)',
    original_filename: 'The.Boy.in.the.Striped.Pyjamas.2008.1080p.BluRay.x265-RZeroX.mkv',
    hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c',
    bytes: 1_700_000_000,
    status: 'downloaded',
    progress: 100,
    added: '2024-01-02T10:00:00.000Z',
    files: [
      { id: 0, path: 'The.Boy.in.the.Striped.Pyjamas.2008.1080p.BluRay.x265.mkv', bytes: 1_700_000_000, selected: 1 },
    ],
    links: ['http://127.0.0.1:8100/stream/a1b2c3d4e5f6.mkv'],
  },
  TOYSTORY5: {
    id: 'KS6PVTQSKUDJQ',
    filename: 'Toy.Story.5.2026.1080p.DCPRIP.LTE.x264-SPLiCE.mkv',
    original_filename: 'Toy.Story.5.2026.1080p.DCPRIP.LTE.x264-SPLiCE.mkv',
    hash: 'c0ffee0000000000000000000000000000000001',
    bytes: 3_700_000_000,
    status: 'downloaded',
    progress: 100,
    added: '2026-05-01T10:00:00.000Z',
    files: [
      { id: 0, path: 'Toy.Story.5.2026.1080p.DCPRIP.LTE.x264-SPLiCE.mkv', bytes: 3_700_000_000, selected: 1 },
    ],
    links: ['http://127.0.0.1:8100/stream/c0ffee0000000001.mkv'],
  },
  PRESIDENT_E06: {
    id: '34RVY2ZA2YNJI',
    filename: 'President Curtis - S01E06 - Hollow - 2160p HDR Ai Upscale -Mesc.mkv',
    original_filename: 'President.Curtis.S01E06.Hollow.2160p.Mesc.mkv',
    hash: '1111111111111111111111111111111111111111',
    bytes: 6_000_000_000,
    status: 'downloaded',
    progress: 100,
    added: '2026-06-10T10:00:00.000Z',
    files: [
      { id: 0, path: 'President.Curtis.S01E06.Hollow.2160p.Mesc.mkv', bytes: 6_000_000_000, selected: 1 },
    ],
    links: ['http://127.0.0.1:8100/stream/1111111111111111.mkv'],
  },
  DOWNLOADING: {
    id: 'DL01',
    filename: 'Some.New.Show.S01E02.720p.WEB-DL.mkv',
    original_filename: 'Some.New.Show.S01E02.720p.WEB-DL.mkv',
    hash: '2222222222222222222222222222222222222222',
    bytes: 900_000_000,
    status: 'downloading',
    progress: 40,
    added: '2026-07-01T10:00:00.000Z',
    files: [{ id: 0, path: 'Some.New.Show.S01E02.720p.WEB-DL.mkv', bytes: 900_000_000, selected: 1 }],
    links: [],
  },
};

const DOWNLOADS = [
  {
    id: 'H1',
    filename: 'random-hoster-file.mkv',
    filesize: 1_200_000_000,
    link: 'https://hoster.example/f',
    host: 'hoster.example',
    download: 'http://127.0.0.1:8100/stream/hoster1.mkv',
    generated: '2024-03-01T10:00:00.000Z',
  },
];

// Hashes the mock "RD" has cached (used by instantAvailability + addMagnet).
const CACHED = new Set(Object.values(TORRENTS).map((t) => t.hash.toLowerCase()));
CACHED.add('e6c919376404fdc03212c8b7ec7dccf47b4102f9'); // The Matrix (cached)

function torrentSummary(t) {
  return {
    id: t.id,
    filename: t.filename,
    hash: t.hash,
    bytes: t.bytes,
    status: t.status,
    progress: t.progress,
    added: t.added,
  };
}

// ------------------------------------------------------------------ Zilean
const ZILEAN_DB = [
  {
    raw_title: 'The Matrix 1999 1080p BluRay x264-GROUP',
    cleaned_parsed_title: 'The Matrix',
    year: 1999,
    resolution: '1080p',
    category: 'movie',
    imdb_id: 'tt0133093',
    info_hash: 'e6c919376404fdc03212c8b7ec7dccf47b4102f9',
    size: '3.1 GB',
  },
  {
    raw_title: 'Slow Horses S04E03 2160p ATVP WEB-DL',
    cleaned_parsed_title: 'Slow Horses',
    category: 'tv',
    seasons: [4],
    episodes: [3],
    info_hash: '92593811555bf29ff0c79e2cf0d4f7690a7eb819',
    size: '8.0 GB',
  },
  {
    raw_title: 'The Boy in the Striped Pajamas 2008 1080p BluRay',
    cleaned_parsed_title: 'The Boy in the Striped Pajamas',
    year: 2008,
    resolution: '1080p',
    category: 'movie',
    imdb_id: 'tt0914798',
    info_hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c',
    size: '1.7 GB',
  },
];

// ----------------------------------------------------------------- helpers
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// ------------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const auth = req.headers.authorization || '';

  // Real-Debrid
  if (path.startsWith('/rest/1.0/')) {
    if (!auth.startsWith('Bearer ')) return sendJson(res, 401, { error: 'bad_token' });
    if (auth === 'Bearer BADTOKEN') return sendJson(res, 401, { error: 'bad_token' });

    const rest = path.slice('/rest/1.0'.length);

    if (rest === '/user') return sendJson(res, 200, { id: 1, username: 'mock-user' });

    if (rest.startsWith('/torrents/info/')) {
      const t = TORRENTS[rest.slice('/torrents/info/'.length)];
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: 'unknown_torrent' });
    }

    if (rest.startsWith('/torrents/instantAvailability/')) {
      if (DISABLE_IA) return sendJson(res, 403, { error: 'disabled_endpoint', error_code: 37 });
      const hashes = rest.slice('/torrents/instantAvailability/'.length).split('/');
      const body = {};
      for (const h of hashes) {
        const lower = h.toLowerCase();
        body[lower] = CACHED.has(lower)
          ? { rd: [{ filename: 'cached.mkv', filesize: 1_000_000 }] }
          : {};
      }
      return sendJson(res, 200, body);
    }

    if (rest === '/torrents/selectFiles/ALL') return sendJson(res, 204, null);

    if (rest === '/unrestrict/link') {
      const body = await readBody(req);
      const link = new URLSearchParams(body).get('link') || '';
      return sendJson(res, 200, { download: link, filename: 'mock-file.mkv' });
    }

    if (rest.startsWith('/torrents/delete/')) {
      const id = rest.slice('/torrents/delete/'.length);
      delete TORRENTS[id];
      return sendJson(res, 204, null);
    }

    if (rest === '/torrents/addMagnet') {
      const body = await readBody(req);
      const magnet = new URLSearchParams(body).get('magnet') || '';
      const hash = (magnet.match(/btih:([0-9a-fA-F]{40})/) || [])[1]?.toLowerCase();
      const existing = Object.values(TORRENTS).find((t) => t.hash.toLowerCase() === hash);
      if (existing) return sendJson(res, 201, { id: existing.id, uri: magnet });
      // Unknown hash: cached ⇒ instantly downloadable; otherwise it downloads slowly.
      if (hash && CACHED.has(hash)) {
        TORRENTS.NEWTORRENT = {
          id: 'NEWTORRENT', filename: 'new-cached.mkv', hash,
          bytes: 2_000_000_000, status: 'downloaded', progress: 100, added: '2026-01-01',
          files: [{ id: 0, path: 'new-cached.mkv', bytes: 2_000_000_000, selected: 1 }],
          links: [`http://127.0.0.1:${PORT}/stream/${hash}.mkv`],
        };
        return sendJson(res, 201, { id: 'NEWTORRENT', uri: magnet });
      }
      TORRENTS.NEWTORRENT = {
        id: 'NEWTORRENT', filename: 'new-uncached.mkv', hash,
        bytes: 2_000_000_000, status: 'downloading', progress: 5, added: '2026-01-01',
        files: [{ id: 0, path: 'new-uncached.mkv', bytes: 2_000_000_000, selected: 1 }], links: [],
      };
      return sendJson(res, 201, { id: 'NEWTORRENT', uri: magnet });
    }

    if (rest === '/torrents' && req.method === 'GET') {
      return sendJson(res, 200, Object.values(TORRENTS).map(torrentSummary));
    }

    if (rest === '/downloads' && req.method === 'GET') return sendJson(res, 200, DOWNLOADS);

    return sendJson(res, 404, { error: 'unknown_route', path });
  }

  // Zilean
  if (path === '/dmm/search' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const q = (body.QueryText || '').toLowerCase();
    const hits = ZILEAN_DB.filter((t) => t.cleaned_parsed_title.toLowerCase().includes(q));
    return sendJson(res, 200, hits);
  }
  if (path === '/healthchecks/ping') return sendJson(res, 200, 'Pong');

  // Cinemeta-lite
  const metaMatch = path.match(/^\/meta\/(movie|series)\/(tt\d+)(?::\d+:\d+)?\.json$/);
  if (metaMatch) {
    const [, , tt] = metaMatch;
    const names = {
      tt0133093: { name: 'The Matrix', year: 1999 },
      tt0914798: { name: 'The Boy in the Striped Pajamas', year: 2008 },
    };
    const hit = names[tt] || { name: 'Unknown', year: 2000 };
    return sendJson(res, 200, {
      meta: { id: tt, type: 'movie', name: hit.name, year: String(hit.year), releaseInfo: String(hit.year) },
    });
  }

  return sendJson(res, 404, { error: 'not_found', path });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock backends listening on http://127.0.0.1:${PORT}`);
  console.log(`  RD base:      http://127.0.0.1:${PORT}/rest/1.0`);
  console.log(`  instantAvailability: ${DISABLE_IA ? 'DISABLED (403 disabled_endpoint)' : 'enabled'}`);
});
