import { ContentType } from 'stremio-addon-sdk';
import { Context, CountryCode } from '../types';
import { Fetcher, getKitsuAnimeMeta, getTmdbId, getTmdbNameAndYear, Id, KitsuId } from '../utils';
import { Source, SourceResult } from './Source';

interface KitsuAnime {
  id: string;
  type: string;
  attributes: {
    slug: string;
    canonicalTitle: string;
    titles: Record<string, string>;
    synopsis: string;
    episodeCount: number | null;
    episodeLength: number | null;
    status: string;
    startDate: string;
    endDate: string | null;
    coverImage: {
      original: string;
      large: string;
      small: string;
      medium: string;
    };
  };
}

export class Kitsu extends Source {
  public readonly id = 'kitsu';

  public readonly label = 'Kitsu';

  public readonly contentTypes: ContentType[] = ['movie', 'series'];

  public readonly countryCodes: CountryCode[] = [CountryCode.multi];

  public readonly baseUrl = 'https://kitsu.io';
  public override readonly category = 'anime' as const;

  private readonly fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    super();

    this.fetcher = fetcher;
  }

  private async searchAnime(ctx: Context, name: string): Promise<KitsuAnime | null> {
    try {
      const url = new URL('/api/edge/anime', this.baseUrl);
      url.searchParams.append('filter[text]', name);
      url.searchParams.append('page[limit]', '5');

      const response = await this.fetcher.json(ctx, url) as { data: any[] };

      if (!response.data || response.data.length === 0) {
        return null;
      }

      return response.data[0];
    } catch {
      return null;
    }
  }

  private async getEpisodes(ctx: Context, animeId: string, season?: number): Promise<string[]> {
    try {
      const url = new URL(`/api/edge/anime/${animeId}/episodes`, this.baseUrl);
      // API rejects page[limit] > 20 (400) since ~Oct 2026; follow links.next instead.
      url.searchParams.append('page[limit]', '20');

      const episodes: string[] = [];
      let urlToFetch: URL | null = url;
      let pages = 0;

      while (urlToFetch && pages < 10) {
        pages++;
        const response = await this.fetcher.json(ctx, urlToFetch) as { data: any[]; links: { next: string | null } };

        for (const episode of response.data) {
          if (season && episode.attributes.seasonNumber !== undefined && episode.attributes.seasonNumber !== season) continue;
          episodes.push(`/api/edge/anime/${animeId}/episodes/${episode.id}`);
        }

        urlToFetch = response.links.next ? new URL(response.links.next) : null;
      }

      return episodes;
    } catch {
      return [];
    }
  }

  public async handleInternal(ctx: Context, _type: string, id: Id): Promise<SourceResult[]> {
    let anime: KitsuAnime | { id: string; attributes: { canonicalTitle: string } } | null = null;
    let season: number | undefined;

    if (id instanceof KitsuId) {
      // Use the Kitsu ID directly: the title search based on a TMDB-converted name often fails
      // for anime because Kitsu canonical titles differ from TMDB names.
      anime = await getKitsuAnimeMeta(ctx, this.fetcher, id);
      season = id.episode !== undefined ? 1 : undefined;
    } else {
      const tmdbId = await getTmdbId(ctx, this.fetcher, id);
      const [name] = await getTmdbNameAndYear(ctx, this.fetcher, tmdbId);
      season = tmdbId.season;
      anime = await this.searchAnime(ctx, name);
    }

    if (!anime) {
      return [];
    }

    const animeId = anime.id;
    const episodeUrls = await this.getEpisodes(ctx, animeId, season);

    if (episodeUrls.length === 0) {
      return [];
    }

    return episodeUrls.map(url => ({
      url: new URL(url, this.baseUrl),
      meta: {
        title: anime!.attributes.canonicalTitle,
        countryCodes: [CountryCode.multi],
      },
    }));
  }
}
