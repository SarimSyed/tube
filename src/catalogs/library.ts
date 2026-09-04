import type { RdDownload, RdTorrentSummary } from '../types.js';
import type { CatalogResponse, ContentType, Meta } from '../stremio.js';
import { parseFilename, guessType } from '../meta/parser.js';
import { MetaService } from '../meta/meta.js';
import type { RdGateway } from '../services/realdebrid.js';
import { downloadId, torrentId, episodeId, parseLibraryId } from '../id.js';
import { mapLimit } from '../util.js';
import { PAGE_SIZE } from '../constants.js';

interface LibraryEntry {
  kind: 'torrent' | 'download';
  id: string;
  filename: string;
  status?: string;
  added: string;
}

function seriesLabel(season?: number, episode?: number, quality?: string): string | undefined {
  const parts: string[] = [];
  if (season !== undefined) parts.push(`S${String(season).padStart(2, '0')}`);
  if (episode !== undefined) parts.push(`E${String(episode).padStart(2, '0')}`);
  if (quality) parts.push(quality);
  return parts.length ? parts.join(' ') : undefined;
}

export class LibraryCatalog {
  constructor(
    private rd: RdGateway,
    private metaService: MetaService,
  ) {}

  private async torrents(): Promise<LibraryEntry[]> {
    const list = await this.rd.listTorrents();
    return list.map((t: RdTorrentSummary) => ({
      kind: 'torrent' as const,
      id: t.id,
      filename: t.filename,
      status: t.status,
      added: t.added ?? '',
    }));
  }

  private async downloads(): Promise<LibraryEntry[]> {
    const list = await this.rd.listDownloads();
    return list.map((d: RdDownload) => ({
      kind: 'download' as const,
      id: d.id,
      filename: d.filename,
      added: d.generated ?? '',
    }));
  }

  async list(
    catalogId: string,
    type: ContentType,
    skip: number,
    search: string | undefined,
    baseUrl: string,
  ): Promise<CatalogResponse> {
    const rawEntries =
      catalogId === 'rd-downloads' ? await this.downloads() : await this.torrents();

    const entries = rawEntries
      .map((e) => ({ ...e, parsed: parseFilename(e.filename) }))
      .filter((e) => {
        if (e.parsed.isSeries && type !== 'series') return false;
        if (!e.parsed.isSeries && type !== 'movie') return false;
        if (search) {
          const q = search.toLowerCase();
          return e.filename.toLowerCase().includes(q) || e.parsed.title.toLowerCase().includes(q);
        }
        return true;
      })
      .sort((a, b) => (a.added < b.added ? 1 : -1));

    const page = entries.slice(skip, skip + PAGE_SIZE);

    const metas = await mapLimit(page, 6, async (entry) => {
      const p = entry.parsed;
      const id = entry.kind === 'download' ? downloadId(entry.id) : torrentId(entry.id);
      const label = entry.kind === 'download'
        ? seriesLabel(p.season, p.episode, p.quality)
        : seriesLabel(p.isSeries ? p.season : undefined, p.isSeries ? p.episode : undefined, p.quality);
      return this.metaService.preview({
        id,
        type,
        title: p.title,
        year: p.year,
        labelSuffix: label,
        baseUrl,
      });
    });

    return { metas };
  }

  async meta(id: string, baseUrl: string): Promise<Meta | null> {
    const parsed = parseLibraryId(id);
    if (!parsed) return null;

    if (parsed.kind === 'download') {
      const downloads = await this.downloads();
      const found = downloads.find((d) => d.id === parsed.downloadId);
      if (!found) return null;
      const p = parseFilename(found.filename);
      const type: ContentType = p.isSeries ? 'series' : 'movie';
      return this.metaService.fullMeta({
        id,
        type,
        title: p.title,
        year: p.year,
        baseUrl,
        videos: type === 'series'
          ? [{ id, title: p.title, season: p.season, episode: p.episode }]
          : undefined,
      });
    }

    // Torrent (movie, single-episode series, or season pack).
    const info = await this.rd.getTorrentInfo(parsed.torrentId);
    const p = parseFilename(info.original_filename ?? info.filename);
    const type: ContentType = guessType(info.original_filename ?? info.filename) === 'series'
      ? 'series'
      : 'movie';

    if (type === 'movie') {
      return this.metaService.fullMeta({
        id,
        type,
        title: p.title,
        year: p.year,
        baseUrl,
      });
    }

    // Series: build videos from the files present in the torrent.
    const videoFiles = (info.files ?? [])
      .map((f) => f.path.split('/').pop() ?? f.path)
      .filter(
        (path) =>
          /\.(mkv|mp4|avi|mov|wmv|webm|m4v|ts|m2ts)$/i.test(path) &&
          !/sample/i.test(path),
      );

    const episodes: Array<{ id: string; title: string; season?: number; episode?: number }> = [];
    const seen = new Set<string>();
    for (const file of videoFiles) {
      const fp = parseFilename(file);
      if (fp.season !== undefined && fp.episode !== undefined) {
        const key = `${fp.season}:${fp.episode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        episodes.push({
          id: episodeId(parsed.torrentId, fp.season, fp.episode),
          title: `S${String(fp.season).padStart(2, '0')}E${String(fp.episode).padStart(2, '0')}`,
          season: fp.season,
          episode: fp.episode,
        });
      }
    }

    if (episodes.length === 0) {
      // Fall back to a single playable video for the whole torrent.
      episodes.push({
        id,
        title: info.original_filename ?? info.filename,
        season: p.season,
        episode: p.episode,
      });
    }

    const videos = episodes.map((e) => ({
      id: e.id,
      title: e.title,
      season: e.season,
      episode: e.episode,
    }));

    return this.metaService.fullMeta({
      id,
      type: 'series',
      title: p.title,
      year: p.year,
      baseUrl,
      videos,
    });
  }
}
