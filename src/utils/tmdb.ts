import { Mutex } from 'async-mutex';
import { NotFoundError } from '../error';
import { Context } from '../types';
import { envGetRequired } from './env';
import { CustomRequestConfig, Fetcher } from './Fetcher';
import { ImdbId, KitsuId, KitsuMappedTmdbId, TmdbId } from './id';

interface FindResponsePartial {
  movie_results: {
    id: number;
  }[];
  tv_results: {
    id: number;
  }[];
}

interface ExternalIdsResponsePartial {
  imdb_id: string;
}

interface MovieDetailsResponsePartial {
  original_title: string;
  release_date: string;
  title: string;
  original_language?: string;
}

interface TvDetailsResponsePartial {
  first_air_date: string;
  name: string;
  original_name: string;
  original_language?: string;
}

interface TvEpisodeDetailsResponsePartial {
  air_date: string;
  name: string;
}

interface KitsuAnimeAttributes {
  canonicalTitle: string;
  titles: Record<string, string>;
  synopsis?: string;
  episodeCount: number | null;
  subtype: string;
  startDate: string | null;
  status: string;
  posterImage?: { original?: string; large?: string; medium?: string; small?: string } | null;
  coverImage?: { original?: string; large?: string; medium?: string; small?: string } | null;
}

interface KitsuAnimeResponse {
  data: {
    id: string;
    type: string;
    attributes: KitsuAnimeAttributes;
  };
}

interface TmdbSearchResult {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  first_air_date?: string;
  release_date?: string;
}

interface TmdbSearchResponse {
  results?: TmdbSearchResult[];
}

const mutexes = new Map<string, Mutex>();
const kitsuMetaCache = new Map<string, KitsuAnimeResponse['data']>();
const kitsuTmdbCache = new Map<string, TmdbId>();
const tmdbFetch = async (ctx: Context, fetcher: Fetcher, path: string, searchParams?: Record<string, string | undefined>): Promise<unknown> => {
  const config: CustomRequestConfig = {
    headers: {
      'Authorization': 'Bearer ' + envGetRequired('TMDB_ACCESS_TOKEN'),
      'Content-Type': 'application/json',
    },
    queueLimit: 50,
    queueTimeout: 60000,
    timeout: 30000,
  };

  const url = new URL(`https://api.themoviedb.org/3${path}`);

  Object.entries(searchParams ?? {}).forEach(([name, value]) => {
    if (value) {
      url.searchParams.set(name, value);
    }
  });

  let mutex = mutexes.get(url.href);
  if (!mutex) {
    mutex = new Mutex();
    mutexes.set(url.href, mutex);
  }

  const data = await mutex.runExclusive(async () => {
    return await fetcher.json(ctx, url, config);
  });

  if (!mutex.isLocked()) {
    mutexes.delete(url.href);
  }

  return data;
};

const imdbTmdbMap = new Map<string, number>();
export const getTmdbIdFromImdbId = async (ctx: Context, fetcher: Fetcher, imdbId: ImdbId): Promise<TmdbId> => {
  // Manual mismatch fixes
  if (imdbId.id === 'tt13207736' && imdbId.season === 2) {
    // Monsters: The Lyle and Erik Menendez Story (2024)
    return new TmdbId(225634, imdbId.season - 1, imdbId.episode);
  }
  if (imdbId.id === 'tt13207736' && imdbId.season === 3) {
    // Monster: The Ed Gein Story (2025)
    return new TmdbId(286801, imdbId.season - 2, imdbId.episode);
  }

  if (imdbTmdbMap.has(imdbId.id)) {
    return new TmdbId(imdbTmdbMap.get(imdbId.id) as number, imdbId.season, imdbId.episode);
  }

  const response = await tmdbFetch(ctx, fetcher, `/find/${imdbId.id}?external_source=imdb_id`) as FindResponsePartial;

  const id = (imdbId.season ? response.tv_results[0] : response.movie_results[0])?.id;

  if (!id) {
    throw new NotFoundError(`Could not get TMDB ID of IMDb ID "${imdbId.id}"`);
  }

  imdbTmdbMap.set(imdbId.id, id);
  return new TmdbId(id, imdbId.season, imdbId.episode);
};

const tmdbImdbMap = new Map<number, string>();
export const getImdbIdFromTmdbId = async (ctx: Context, fetcher: Fetcher, tmdbId: TmdbId): Promise<ImdbId> => {
  if (tmdbImdbMap.has(tmdbId.id)) {
    return new ImdbId(tmdbImdbMap.get(tmdbId.id) as string, tmdbId.season, tmdbId.episode);
  }

  const type = tmdbId.season ? 'tv' : 'movie';

  const response = await tmdbFetch(ctx, fetcher, `/${type}/${tmdbId.id}/external_ids`) as ExternalIdsResponsePartial;

  tmdbImdbMap.set(tmdbId.id, response.imdb_id);
  return new ImdbId(response.imdb_id, tmdbId.season, tmdbId.episode);
};

export const getKitsuAnimeMeta = async (ctx: Context, fetcher: Fetcher, kitsuId: KitsuId): Promise<KitsuAnimeResponse['data']> => {
  const cacheKey = kitsuId.id;
  const cached = kitsuMetaCache.get(cacheKey);
  if (cached) return cached;

  const url = new URL(`https://kitsu.io/api/edge/anime/${kitsuId.id}`);
  const response = await fetcher.json(ctx, url) as KitsuAnimeResponse;

  if (!response?.data) {
    throw new NotFoundError(`Could not get Kitsu metadata for ID "${kitsuId.id}"`);
  }

  kitsuMetaCache.set(cacheKey, response.data);
  return response.data;
};

const searchTmdbByTitle = async (
  ctx: Context,
  fetcher: Fetcher,
  title: string,
  year: number | undefined,
  isMovie: boolean,
): Promise<number | undefined> => {
  const path = isMovie ? '/search/movie' : '/search/tv';

  const runSearch = async (params: Record<string, string | undefined>) => {
    const response = await tmdbFetch(ctx, fetcher, path, params) as TmdbSearchResponse;
    return response.results?.[0]?.id;
  };

  let id = await runSearch({ query: title });
  if (!id && year !== undefined) {
    const yearParams = isMovie
      ? { query: title, year: String(year) }
      : { query: title, first_air_date_year: String(year) };
    id = await runSearch(yearParams);
  }

  return id;
};

export const getTmdbIdFromKitsuId = async (ctx: Context, fetcher: Fetcher, kitsuId: KitsuId): Promise<TmdbId> => {
  const cacheKey = `${kitsuId.id}:${kitsuId.episode ?? ''}`;
  const cached = kitsuTmdbCache.get(cacheKey);
  if (cached) return cached;

  const meta = await getKitsuAnimeMeta(ctx, fetcher, kitsuId);
  const attrs = meta.attributes;
  const isMovie = String(attrs.subtype).toLowerCase() === 'movie';

  const primaryTitle = attrs.titles?.['en']
    || attrs.canonicalTitle
    || attrs.titles?.['en_jp']
    || attrs.titles?.['ja_jp']
    || '';
  const year = attrs.startDate ? new Date(attrs.startDate).getFullYear() : undefined;

  const titlesToTry = [
    primaryTitle,
    attrs.titles?.['en'],
    attrs.titles?.['en_jp'],
    attrs.titles?.['ja_jp'],
  ].filter((t): t is string => !!t);

  let tmdbNumericId: number | undefined;
  try {
    for (const title of [...new Set(titlesToTry)]) {
      tmdbNumericId = await searchTmdbByTitle(ctx, fetcher, title, year, isMovie);
      if (tmdbNumericId) break;
    }
  } catch (e) {
    // TMDB may be unreachable or the access token may be missing. Fall back to Kitsu-only metadata
    // so the request can still be serviced by sources that search by title.
    tmdbNumericId = undefined;
  }

  const season = isMovie ? undefined : (kitsuId.episode !== undefined ? 1 : undefined);
  const episode = isMovie ? undefined : kitsuId.episode;

  let result: TmdbId;
  if (tmdbNumericId) {
    result = new TmdbId(tmdbNumericId, season, episode);
  } else {
    // No TMDB match: carry the Kitsu metadata so anime sources can still search by title.
    result = new KitsuMappedTmdbId(
      0,
      season,
      episode,
      primaryTitle,
      year,
      attrs.titles?.['en_jp'] || attrs.titles?.['ja_jp'] || primaryTitle,
      'ja',
    );
  }

  kitsuTmdbCache.set(cacheKey, result);
  return result;
};

const getTmdbMovieDetails = async (ctx: Context, fetcher: Fetcher, tmdbId: TmdbId, language?: string): Promise<MovieDetailsResponsePartial> => {
  return await tmdbFetch(ctx, fetcher, `/movie/${tmdbId.id}`, { language }) as MovieDetailsResponsePartial;
};

const getTmdbTvDetails = async (ctx: Context, fetcher: Fetcher, tmdbId: TmdbId, language?: string): Promise<TvDetailsResponsePartial> => {
  return await tmdbFetch(ctx, fetcher, `/tv/${tmdbId.id}`, { language }) as TvDetailsResponsePartial;
};

export const getTmdbNameAndYear = async (ctx: Context, fetcher: Fetcher, tmdbId: TmdbId, language?: string): Promise<[string, number, string, string | undefined]> => {
  if (tmdbId instanceof KitsuMappedTmdbId) {
    return [
      tmdbId.kitsuName,
      tmdbId.kitsuYear ?? NaN,
      tmdbId.kitsuOriginalName ?? tmdbId.kitsuName,
      tmdbId.kitsuOriginalLanguage,
    ];
  }

  if (tmdbId.season) {
    const tmdbDetails = await getTmdbTvDetails(ctx, fetcher, tmdbId, language);

    return [tmdbDetails.name, (new Date(tmdbDetails.first_air_date)).getFullYear(), tmdbDetails.original_name, tmdbDetails.original_language];
  }

  const tmdbDetails = await getTmdbMovieDetails(ctx, fetcher, tmdbId, language);

  return [tmdbDetails.title, (new Date(tmdbDetails.release_date)).getFullYear(), tmdbDetails.original_title, tmdbDetails.original_language];
};

export const getTmdbEpisodeAirDate = async (ctx: Context, fetcher: Fetcher, tmdbId: TmdbId, language?: string): Promise<string | undefined> => {
  if (!tmdbId.season || !tmdbId.episode) return undefined;

  const response = await tmdbFetch(
    ctx,
    fetcher,
    `/tv/${tmdbId.id}/season/${tmdbId.season}/episode/${tmdbId.episode}`,
    { language },
  ) as TvEpisodeDetailsResponsePartial;

  return response.air_date;
};

export const getTmdbMovieReleaseDate = async (ctx: Context, fetcher: Fetcher, tmdbId: TmdbId, language?: string): Promise<string | undefined> => {
  if (tmdbId.season) return undefined;

  const details = await getTmdbMovieDetails(ctx, fetcher, tmdbId, language);
  return details.release_date || undefined;
};
