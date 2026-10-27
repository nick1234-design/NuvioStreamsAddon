const axios = require('axios');
const cheerio = require('cheerio');
const { URLSearchParams, URL } = require('url');
const FormData = require('form-data');
const { CookieJar } = require('tough-cookie');
const fs = require('fs').promises;
const path = require('path');
const RedisCache = require('../utils/redisCache');
const { followRedirectToFilePage, extractFinalDownloadFromFilePage } = require('../utils/linkResolver');

// Debug logging flag - set DEBUG=true to enable verbose logging
const DEBUG = process.env.DEBUG === 'true' || process.env.UHDMOVIES_DEBUG === 'true';
const log = DEBUG ? console.log : () => { };
const logWarn = DEBUG ? console.warn : () => { };

// Always-on diagnostics: concise, one-line and secret-free (verbose detail stays behind DEBUG above).
// Never pass API keys, cookies, tokens or the proxy URL to these helpers.
const LOG_FULL_URLS = process.env.UHDMOVIES_LOG_FULL_URLS === 'true';
const diag = (message) => console.log(`[UHDMovies] ${message}`);
const diagWarn = (message) => console.warn(`[UHDMovies] ${message}`);

// Log-safe URL: origin + (shortened) path only. Query strings can carry tokens, so they are omitted
// unless UHDMOVIES_LOG_FULL_URLS=true is set.
function safeUrl(value) {
  if (!value) return '(none)';
  const str = String(value);
  if (LOG_FULL_URLS) return str;
  try {
    const parsed = new URL(str);
    const pathname = parsed.pathname.length > 80 ? `${parsed.pathname.substring(0, 77)}...` : parsed.pathname;
    return `${parsed.origin}${pathname}${parsed.search ? '?<query omitted>' : ''}`;
  } catch (e) {
    return '(unparseable url)';
  }
}

// Browser-like headers used by the standalone UHDMovies source (the version known to work).
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

// Dynamic import for axios-cookiejar-support
let axiosCookieJarSupport = null;
const getAxiosCookieJarSupport = async () => {
  if (!axiosCookieJarSupport) {
    axiosCookieJarSupport = await import('axios-cookiejar-support');
  }
  return axiosCookieJarSupport;
};

// --- Proxy Configuration ---
const UHDMOVIES_PROXY_URL = process.env.UHDMOVIES_PROXY_URL;
if (UHDMOVIES_PROXY_URL) {
  log('[UHDMovies] Proxy support enabled (UHDMOVIES_PROXY_URL is set)');
} else {
  log('[UHDMovies] No proxy configured, using direct connections');
}

// --- Domain Fetching ---
let uhdMoviesDomain = 'https://uhdmovies.beauty'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function getUHDMoviesDomain() {
  const now = Date.now();
  if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
    return uhdMoviesDomain;
  }

  try {
    log('[UHDMovies] Fetching latest domain...');
    const response = await makeRequest('https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json', { timeout: 10000 });
    let domainData = response.data;
    if (typeof domainData === 'string') {
      try { domainData = JSON.parse(domainData); } catch (e) { domainData = null; }
    }
    if (domainData && domainData.UHDMovies) {
      // Normalise: ensure protocol and drop trailing slash(es) so `${baseUrl}/?s=...` is well-formed
      let latestDomain = String(domainData.UHDMovies).trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(latestDomain)) latestDomain = `https://${latestDomain}`;
      uhdMoviesDomain = latestDomain;
      domainCacheTimestamp = now;
      log(`[UHDMovies] Updated domain to: ${uhdMoviesDomain}`);
    } else {
      logWarn('[UHDMovies] Domain JSON fetched, but "UHDMovies" key was not found. Using fallback.');
    }
  } catch (error) {
    console.error(`[UHDMovies] Failed to fetch latest domain, using fallback. Error: ${error.message}`);
  }
  return uhdMoviesDomain;
}

// Constants
const TMDB_API_KEY_UHDMOVIES = "439c478a771f35c05022f9feabcca01c"; // Public TMDB API key

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true'; // Set to true to disable caching for this provider
log(`[UHDMovies] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.uhd_cache') : path.join(__dirname, '.cache', 'uhdmovies'); // Cache directory inside providers/uhdmovies

// Initialize Redis cache
const redisCache = new RedisCache('UHDMovies');

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
  if (!CACHE_ENABLED) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`[UHDMovies Cache] Error creating cache directory: ${error.message}`);
    }
  }
};

const getFromCache = async (key) => {
  if (!CACHE_ENABLED) return null;

  // Try Redis cache first, then fallback to file system
  const cachedData = await redisCache.getFromCache(key, '', CACHE_DIR);
  if (cachedData) {
    return cachedData.data || cachedData; // Support both new format (data field) and legacy format
  }

  return null;
};

const saveToCache = async (key, data) => {
  if (!CACHE_ENABLED) return;

  const cacheData = {
    data: data
  };

  // Save to both Redis and file system
  await redisCache.saveToCache(key, cacheData, '', CACHE_DIR);
};

// Initialize cache directory on startup
ensureCacheDir();

// Configure axios with headers to mimic a browser
// Configure axios instance with optional proxy support
const createAxiosInstance = () => {
  const config = {
    headers: { ...BROWSER_HEADERS },
    timeout: 30000
  };

  // Add proxy configuration if UHDMOVIES_PROXY_URL is set
  if (UHDMOVIES_PROXY_URL) {
    log('[UHDMovies] Using proxy for outbound requests');
    // For proxy URLs that expect the destination URL as a parameter
    config.transformRequest = [(data, headers) => {
      return data;
    }];
  }

  return axios.create(config);
};

const axiosInstance = createAxiosInstance();

// Proxy wrapper function
const makeRequest = async (url, options = {}) => {
  if (UHDMOVIES_PROXY_URL) {
    // Route through proxy
    const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
    log(`[UHDMovies] Making proxied request to: ${url}`);
    return axiosInstance.get(proxiedUrl, options);
  } else {
    // Direct request
    log(`[UHDMovies] Making direct request to: ${url}`);
    return axiosInstance.get(url, options);
  }
};


// --- Helpers shared by the standalone-style extraction code ---

// Hosts that serve the "SID"/Hrefli gateway pages. Matching on the host keyword (as the standalone
// source does with "unblockedgames") keeps working when the tech.* subdomain/TLD rotates.
const SID_HOST_PATTERN = /unblockedgames|examzculture|creativeexpressionsblog/i;
const isSidHref = (href) => !!href && SID_HOST_PATTERN.test(href);
// cheerio .filter() callback: (index, element) => boolean
const isSidAnchor = (index, element) => isSidHref(element && element.attribs && element.attribs.href);

// Episode label matcher, in the spirit of the standalone's /Episode\s*(\d+)/i but exact on the number
// (so "Episode 1" never matches "Episode 10") and tolerant of "Ep 1" / leading icons or whitespace.
const buildEpisodeRegex = (episode) =>
  new RegExp(`(?:^|[^a-z0-9])(?:episode|ep)\\s*0*${parseInt(episode, 10)}(?!\\d)`, 'i');

// True when the "(YYYY)" years found in the text include targetYear (or when there are none).
function textMatchesYear(text, targetYear) {
  const years = String(text || '').match(/\((\d{4})\)/g);
  if (!years || years.length === 0) return true;
  return years.some((y) => parseInt(y.replace(/[()]/g, ''), 10) === targetYear);
}

function getBaseUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (e) {
    return '';
  }
}

function fixUrl(url, domain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return domain + url;
  return `${domain}/${url}`;
}

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
};

// Everything after "?url=" / "&url=" (kept raw, like the standalone source does).
const getUrlParamRaw = (value) => {
  const str = String(value || '');
  const match = /[?&]url=/.exec(str);
  return match ? str.slice(match.index + match[0].length) : null;
};

// workers.dev links may contain spaces in the filename segment.
function fixWorkersUrl(url) {
  if (url && url.includes('workers.dev')) {
    const parts = url.split('/');
    parts[parts.length - 1] = parts[parts.length - 1].replace(/ /g, '%20');
    return parts.join('/');
  }
  return url;
}

// Route a target URL through the existing UHDMOVIES_PROXY_URL wrapper (same scheme makeRequest uses).
const proxify = (url) => (UHDMOVIES_PROXY_URL ? `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}` : url);

// Generic page fetch used by the standalone-style extractors. Behaves like fetch(): follows redirects,
// never throws on HTTP status codes, and returns the body as text. Uses the same axios instance
// (and therefore the same proxy support, headers and timeout) as the rest of this provider.
async function fetchPage(url, options = {}) {
  const { method = 'GET', headers = {}, data, maxRedirects = 10, timeout = 30000 } = options;
  const response = await axiosInstance.request({
    url: proxify(url),
    method,
    headers,
    data,
    maxRedirects,
    timeout,
    responseType: 'text',
    maxContentLength: 5 * 1024 * 1024, // these are HTML/API pages; never slurp a video file into memory
    validateStatus: () => true
  });
  // Behind the proxy the post-redirect URL is not observable, so fall back to the requested URL.
  const finalUrl = UHDMOVIES_PROXY_URL ? url : ((response.request && response.request.res && response.request.res.responseUrl) || url);
  return {
    status: response.status,
    html: typeof response.data === 'string' ? response.data : String(response.data == null ? '' : response.data),
    headers: response.headers || {},
    finalUrl
  };
}

// Simple In-Memory Cache
const uhdMoviesCache = {
  search: {},
  movie: {},
  show: {}
};

// Function to search for movies
async function searchMovies(query) {
  try {
    const baseUrl = await getUHDMoviesDomain();
    diag(`Searching for "${query}" on ${baseUrl}`);

    // `/?s=` is the WordPress search the standalone source uses successfully; `/search/<query>` is the
    // path this provider used before and is kept as a fallback.
    const searchUrls = [
      `${baseUrl}/?s=${encodeURIComponent(query)}`,
      `${baseUrl}/search/${encodeURIComponent(query)}`
    ];

    const searchResults = [];
    const addResult = (title, href) => {
      if (!href || !title) return;
      let link;
      try {
        link = new URL(href, baseUrl).href;
      } catch (e) {
        return;
      }
      if (!searchResults.some(item => item.link === link)) {
        searchResults.push({ title: String(title).trim(), link });
      }
    };

    for (const searchUrl of searchUrls) {
      let html;
      try {
        const response = await makeRequest(searchUrl);
        html = response.data;
      } catch (error) {
        diagWarn(`Search request failed for "${query}" via ${searchUrl.includes('/?s=') ? '/?s=' : '/search/'}: ${error.message}`);
        continue;
      }
      if (typeof html !== 'string') {
        diagWarn(`Search response for ${safeUrl(searchUrl)} was not HTML, skipping.`);
        continue;
      }

      const $ = cheerio.load(html);

      // Grid-based results. Selectors cover both layouts used by the standalone source
      // (article.gridlove-post / article.latestPost).
      $('article.gridlove-post, article.latestPost').each((index, element) => {
        const $article = $(element);
        const downloadAnchor = $article.find('a[href*="/download-"]').first();
        const fallbackAnchor = $article.find('div.entry-image > a, h2.title a, a').first();
        const anchor = downloadAnchor.length > 0 ? downloadAnchor : fallbackAnchor;
        const title = downloadAnchor.attr('title') ||
          $article.find('h1.sanket, h2.title a').first().text() ||
          anchor.attr('title') || '';
        addResult(title, anchor.attr('href'));
      });

      // Fallback for original list-based search if the grid logic finds nothing
      if (searchResults.length === 0) {
        log('[UHDMovies] Grid search logic found no results, trying original list-based logic...');
        $('a[href*="/download-"]').each((index, element) => {
          addResult($(element).text().trim(), $(element).attr('href'));
        });
      }

      if (searchResults.length > 0) break;
      diag(`No results parsed from ${safeUrl(searchUrl)} (${html.length} bytes of HTML)`);
    }

    diag(`Search "${query}": ${searchResults.length} result(s)`);
    searchResults.slice(0, 5).forEach((result, i) => {
      diag(`  result ${i + 1}: ${result.title.substring(0, 100)} -> ${safeUrl(result.link)}`);
    });
    return searchResults;
  } catch (error) {
    console.error(`[UHDMovies] Error searching movies: ${error.message}`);
    return [];
  }
}

// Function to extract clean quality information from verbose text
function extractCleanQuality(fullQualityText) {
  if (!fullQualityText || fullQualityText === 'Unknown Quality') {
    return 'Unknown Quality';
  }

  const cleanedFullQualityText = fullQualityText.replace(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g, '').trim();
  const text = cleanedFullQualityText.toLowerCase();
  let quality = [];

  // Extract resolution
  if (text.includes('2160p') || text.includes('4k')) {
    quality.push('4K');
  } else if (text.includes('1080p')) {
    quality.push('1080p');
  } else if (text.includes('720p')) {
    quality.push('720p');
  } else if (text.includes('480p')) {
    quality.push('480p');
  }

  // Extract special features
  if (text.includes('hdr')) {
    quality.push('HDR');
  }
  if (text.includes('dolby vision') || text.includes('dovi') || /\bdv\b/.test(text)) {
    quality.push('DV');
  }
  if (text.includes('imax')) {
    quality.push('IMAX');
  }
  if (text.includes('bluray') || text.includes('blu-ray')) {
    quality.push('BluRay');
  }

  // If we found any quality indicators, join them
  if (quality.length > 0) {
    return quality.join(' | ');
  }

  // Fallback: try to extract a shorter version of the original text
  // Look for patterns like "Movie Name (Year) Resolution ..."
  const patterns = [
    /(\d{3,4}p.*?(?:x264|x265|hevc).*?)[\[\(]/i,
    /(\d{3,4}p.*?)[\[\(]/i,
    /((?:720p|1080p|2160p|4k).*?)$/i
  ];

  for (const pattern of patterns) {
    const match = cleanedFullQualityText.match(pattern);
    if (match && match[1].trim().length < 100) {
      return match[1].trim().replace(/x265/ig, 'HEVC');
    }
  }

  // Final fallback: truncate if too long
  if (cleanedFullQualityText.length > 80) {
    return cleanedFullQualityText.substring(0, 77).replace(/x265/ig, 'HEVC') + '...';
  }

  return cleanedFullQualityText.replace(/x265/ig, 'HEVC');
}

// Function to extract download links for TV shows from a page
async function extractTvShowDownloadLinks(showPageUrl, season, episode) {
  // Callers may pass strings; the season/episode comparisons below need numbers.
  season = parseInt(season, 10);
  episode = parseInt(episode, 10);
  try {
    log(`[UHDMovies] Extracting TV show links from: ${showPageUrl} for S${season}E${episode}`);
    const response = await makeRequest(showPageUrl);
    const $ = cheerio.load(response.data);

    const showTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // --- NEW LOGIC TO SCOPE SEARCH TO THE CORRECT SEASON ---
    let inTargetSeason = false;
    let qualityText = '';

    $('.entry-content').find('*').each((index, element) => {
      const $el = $(element);
      const text = $el.text().trim();
      const seasonMatch = text.match(/^SEASON\s*0*(\d+)\b/i) || (text.length <= 12 ? text.match(/^S0*(\d+)$/i) : null);

      // Check if we are entering a new season block
      if (seasonMatch) {
        const currentSeasonNum = parseInt(seasonMatch[1], 10);
        if (currentSeasonNum == season) {
          inTargetSeason = true;
          log(`[UHDMovies] Entering Season ${season} block.`);
        } else if (inTargetSeason) {
          // We've hit the next season, so we stop.
          log(`[UHDMovies] Exiting Season ${season} block, now in Season ${currentSeasonNum}.`);
          inTargetSeason = false;
          return false; // Exit .each() loop
        }
      }

      if (inTargetSeason) {
        // This element is within the correct season's block.

        // Is this a quality header? (e.g., a <pre> or a <p> with <strong>)
        // It often contains resolution, release group, etc.
        const isQualityHeader = $el.is('pre, p:has(strong), p:has(b), h3, h4');
        if (isQualityHeader) {
          const headerText = $el.text().trim();
          // Filter out irrelevant headers. We can be more aggressive here.
          if (headerText.length > 5 && !/plot|download|screenshot|trailer|join|powered by|season/i.test(headerText) && !($el.find('a').length > 0)) {
            qualityText = headerText; // Store the most recent quality header
          }
        }

        // Is this a paragraph with episode links?
        if ($el.is('p') && $el.find('a').filter(isSidAnchor).length > 0) {
          const linksParagraph = $el;
          const episodeRegex = buildEpisodeRegex(episode);
          const targetEpisodeLink = linksParagraph.find('a').filter((i, el) => {
            return episodeRegex.test($(el).text().trim());
          }).first();

          if (targetEpisodeLink.length > 0) {
            const link = targetEpisodeLink.attr('href');
            if (link && !downloadLinks.some(item => item.link === link)) {
              const sizeMatch = qualityText.match(/\[\s*([0-9.,]+\s*[KMGT]B)/i);
              const size = sizeMatch ? sizeMatch[1] : 'Unknown';

              const cleanQuality = extractCleanQuality(qualityText);
              const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

              log(`[UHDMovies] Found match: Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
            }
          }
        }

        // --- ENHANCED: Check for maxbutton-gdrive-episode structure ---
        if ($el.is('p') && $el.find('a.maxbutton-gdrive-episode').length > 0) {
          const episodeRegex = buildEpisodeRegex(episode);
          const targetEpisodeLink = $el.find('a.maxbutton-gdrive-episode').filter((i, el) => {
            const episodeText = $(el).find('.mb-text').text().trim();
            return episodeRegex.test(episodeText);
          }).first();

          if (targetEpisodeLink.length > 0) {
            const link = targetEpisodeLink.attr('href');
            if (link && !downloadLinks.some(item => item.link === link)) {
              const sizeMatch = qualityText.match(/\[\s*([0-9.,]+\s*[KMGT]B)/i);
              const size = sizeMatch ? sizeMatch[1] : 'Unknown';

              const cleanQuality = extractCleanQuality(qualityText);
              const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

              log(`[UHDMovies] Found match (maxbutton): Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
            }
          }
        }
      }
    });

    if (downloadLinks.length === 0) {
      log('[UHDMovies] Main extraction logic failed. Checking if requested season exists on page before fallback.');

      // Check if the requested season exists on the page at all
      let seasonExists = false;
      let actualSeasonsOnPage = new Set(); // Track what seasons actually have content

      // First pass: Look for actual episode content to see what seasons are available
      $('.entry-content').find('a').filter((i, el) => isSidAnchor(i, el) || /maxbutton-gdrive-episode/.test((el.attribs && el.attribs.class) || '')).each((index, element) => {
        const $el = $(element);
        const linkText = $el.text().trim();
        const episodeText = $el.find('.mb-text').text().trim() || linkText;

        // Look for season indicators in episode links
        const seasonMatches = [
          episodeText.match(/S(\d{1,2})/i), // S01, S02, etc.
          episodeText.match(/Season\s+(\d+)/i), // Season 1, Season 2, etc.
          episodeText.match(/S(\d{1,2})E(\d{1,3})/i) // S01E01 format
        ];

        for (const match of seasonMatches) {
          if (match && match[1]) {
            const foundSeason = parseInt(match[1], 10);
            actualSeasonsOnPage.add(foundSeason);
          }
        }
      });

      log(`[UHDMovies] Actual seasons found on page: ${Array.from(actualSeasonsOnPage).sort((a, b) => a - b).join(', ')}`);

      // Check if requested season is in the actual content
      if (actualSeasonsOnPage.has(season)) {
        seasonExists = true;
        log(`[UHDMovies] Season ${season} confirmed to exist in actual episode content`);
      } else {
        // Fallback: Check page descriptions/titles for season mentions
        $('.entry-content').find('*').each((index, element) => {
          const $el = $(element);
          const text = $el.text().trim();
          // Match various season formats: "SEASON 2", "Season 2", "(Season 1 – 2)", "Season 1-2", etc.
          const seasonMatches = [
            text.match(/^SEASON\s+(\d+)/i),
            text.match(/\bSeason\s+(\d+)/i),
            text.match(/\(Season\s+\d+\s*[–-]\s*(\d+)\)/i), // Matches "(Season 1 – 2)"
            text.match(/Season\s+\d+\s*[–-]\s*(\d+)/i), // Matches "Season 1-2"
            text.match(/\bS(\d+)/i) // Matches "S2", "S02", etc.
          ];

          for (const match of seasonMatches) {
            if (match) {
              const currentSeasonNum = parseInt(match[1], 10);
              if (currentSeasonNum == season) {
                seasonExists = true;
                log(`[UHDMovies] Season ${season} found in page description: "${text.substring(0, 100)}..."`);
                return false; // Exit .each() loop
              }
              // For range formats like "Season 1 – 2", check if requested season is in range
              if (match[0].includes('–') || match[0].includes('-')) {
                const rangeMatch = match[0].match(/Season\s+(\d+)\s*[–-]\s*(\d+)/i);
                if (rangeMatch) {
                  const startSeason = parseInt(rangeMatch[1], 10);
                  const endSeason = parseInt(rangeMatch[2], 10);
                  if (season >= startSeason && season <= endSeason) {
                    seasonExists = true;
                    log(`[UHDMovies] Season ${season} found in range ${startSeason}-${endSeason} in page description`);
                    return false; // Exit .each() loop
                  }
                }
              }
            }
          }
        });
      }

      if (!seasonExists) {
        log(`[UHDMovies] Season ${season} not found on page. Available seasons may not include the requested season.`);
        // Don't use fallback if the season doesn't exist to avoid wrong episodes
        return { title: showTitle, links: [], seasonNotFound: true };
      }

      log(`[UHDMovies] Season ${season} exists on page but episode extraction failed. Trying fallback method with season filtering.`);

      // --- ENHANCED FALLBACK LOGIC FOR NEW HTML STRUCTURE ---
      // Try the new maxbutton-gdrive-episode structure first
      $('.entry-content').find('a.maxbutton-gdrive-episode').each((i, el) => {
        const linkElement = $(el);
        const episodeText = linkElement.find('.mb-text').text().trim();
        const episodeRegex = buildEpisodeRegex(episode);

        if (episodeRegex.test(episodeText)) {
          const link = linkElement.attr('href');
          if (link && !downloadLinks.some(item => item.link === link)) {
            let qualityText = 'Unknown Quality';

            // Look for quality info in the preceding paragraph or heading
            const parentP = linkElement.closest('p, div');
            const prevElement = parentP.prev();
            if (prevElement.length > 0) {
              const prevText = prevElement.text().trim();
              if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
                qualityText = prevText;
              }
            }

            // Check if this episode belongs to the correct season
            // Enhanced season check - look for various season formats
            const seasonCheckRegexes = [
              new RegExp(`\\.S0*${season}[\\.]`, 'i'),  // .S01.
              new RegExp(`S0*${season}[\\.]`, 'i'),     // S01.
              new RegExp(`S0*${season}\\b`, 'i'),       // S01 (word boundary)
              new RegExp(`Season\\s+0*${season}\\b`, 'i'), // Season 1
              new RegExp(`S0*${season}`, 'i')           // S01 anywhere
            ];

            const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
            if (!seasonMatch) {
              log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
              return; // Skip this episode as it's from a different season
            }

            const sizeMatch = qualityText.match(/\[([0-9.,]+[KMGT]B[^\]]*)\]/i);
            const size = sizeMatch ? sizeMatch[1] : 'Unknown';
            const cleanQuality = extractCleanQuality(qualityText);
            const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

            log(`[UHDMovies] Found match via enhanced fallback (maxbutton): Quality='${qualityText}', Link='${link}'`);
            downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
          }
        }
      });

      // If still no results, try the original fallback logic
      if (downloadLinks.length === 0) {
        log(`[UHDMovies] Enhanced fallback failed, trying original fallback logic.`);
        $('.entry-content').find('a').filter(isSidAnchor).each((i, el) => {
          const linkElement = $(el);
          const episodeRegex = buildEpisodeRegex(episode);

          if (episodeRegex.test(linkElement.text().trim())) {
            const link = linkElement.attr('href');
            if (link && !downloadLinks.some(item => item.link === link)) {
              let qualityText = 'Unknown Quality';
              const parentP = linkElement.closest('p, div');
              const prevElement = parentP.prev();
              if (prevElement.length > 0) {
                const prevText = prevElement.text().trim();
                if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
                  qualityText = prevText;
                }
              }

              // Check if this episode belongs to the correct season
              // Enhanced season check - look for various season formats
              const seasonCheckRegexes = [
                new RegExp(`\\.S0*${season}[\\.]`, 'i'),  // .S01.
                new RegExp(`S0*${season}[\\.]`, 'i'),     // S01.
                new RegExp(`S0*${season}\\b`, 'i'),       // S01 (word boundary)
                new RegExp(`Season\\s+0*${season}\\b`, 'i'), // Season 1
                new RegExp(`S0*${season}`, 'i')           // S01 anywhere
              ];

              const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
              if (!seasonMatch) {
                log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
                return; // Skip this episode as it's from a different season
              }

              const sizeMatch = qualityText.match(/\[([0-9.,]+[KMGT]B[^\]]*)\]/i);
              const size = sizeMatch ? sizeMatch[1] : 'Unknown';
              const cleanQuality = extractCleanQuality(qualityText);
              const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

              log(`[UHDMovies] Found match via original fallback: Quality='${qualityText}', Link='${link}'`);
              downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality });
            }
          }
        });
      }
    }

    // Standalone-style fallback: walk headings/paragraphs/anchors in page order, tracking the current
    // season header, and pick the anchor whose label matches the requested episode.
    if (downloadLinks.length === 0) {
      log('[UHDMovies] Trying standalone-style episode scan fallback.');
      const scanEpisodeRegex = buildEpisodeRegex(episode);
      let scanSeason = null;
      let scanQualityText = '';

      $('.entry-content').find('pre, p, h3, h4, a').each((index, element) => {
        const $el = $(element);
        const text = $el.text().trim();

        if (!$el.is('a')) {
          // Paragraphs containing links are handled through their own <a> elements below.
          if ($el.find('a').length > 0) return;
          const headerMatch = text.match(/^SEASON\s*0*(\d+)\b/i) || (text.length <= 12 ? text.match(/^S0*(\d+)$/i) : null);
          if (headerMatch) {
            scanSeason = parseInt(headerMatch[1], 10);
          } else if (text.length > 5 && !/plot|download|screenshot|trailer|join|powered by|season/i.test(text)) {
            scanQualityText = text;
          }
          return;
        }

        const href = $el.attr('href');
        if (!href || !/^https?:\/\//i.test(href)) return;
        if (!isSidHref(href) && !/driveseed|driveleech/i.test(href)) return;
        const label = ($el.find('.mb-text').text() || text).trim();
        if (/zip/i.test(label) || !scanEpisodeRegex.test(label)) return;
        if (scanSeason !== null && scanSeason !== season) return;
        if (downloadLinks.some(item => item.link === href)) return;

        const sizeMatch = scanQualityText.match(/\[\s*([0-9.,]+\s*[KMGT]B)/i);
        downloadLinks.push({
          quality: extractCleanQuality(scanQualityText),
          size: sizeMatch ? sizeMatch[1] : 'Unknown',
          link: href,
          rawQuality: scanQualityText.replace(/(\r\n|\n|\r)/gm, ' ').replace(/\s+/g, ' ').trim()
        });
        log(`[UHDMovies] Found match via standalone-style scan: Quality='${scanQualityText}'`);
      });
    }

    if (downloadLinks.length > 0) {
      log(`[UHDMovies] Found ${downloadLinks.length} links for S${season}E${episode}.`);
    } else {
      log(`[UHDMovies] Could not find links for S${season}E${episode}. It's possible the logic needs adjustment or the links aren't on the page.`);
    }

    return { title: showTitle, links: downloadLinks };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting TV show download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}

// Function to extract download links from a movie page
async function extractDownloadLinks(moviePageUrl, targetYear = null) {
  try {
    log(`[UHDMovies] Extracting links from: ${moviePageUrl}`);
    const response = await makeRequest(moviePageUrl);
    const $ = cheerio.load(response.data);

    const movieTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // Find all download links (the new SID links) and their associated quality information
    $('a').filter(isSidAnchor).each((index, element) => {
      const link = $(element).attr('href');

      if (link && !downloadLinks.some(item => item.link === link)) {
        let quality = 'Unknown Quality';
        let size = 'Unknown';

        // Method 1: Look for quality in the closest preceding paragraph or heading
        const prevElement = $(element).closest('p').prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 20 && !prevText.includes('Download')) {
            quality = prevText;
          }
        }

        // Method 2: Look for quality in parent's siblings
        if (quality === 'Unknown Quality') {
          const parentSiblings = $(element).parent().prevAll().first().text().trim();
          if (parentSiblings && parentSiblings.length > 20) {
            quality = parentSiblings;
          }
        }

        // Method 3: Look for bold/strong text above the link
        if (quality === 'Unknown Quality') {
          const strongText = $(element).closest('p').prevAll().find('strong, b').last().text().trim();
          if (strongText && strongText.length > 20) {
            quality = strongText;
          }
        }

        // Method 4: Look for the entire paragraph containing quality info
        if (quality === 'Unknown Quality') {
          let currentElement = $(element).parent();
          for (let i = 0; i < 5; i++) {
            currentElement = currentElement.prev();
            if (currentElement.length === 0) break;

            const text = currentElement.text().trim();
            if (text && text.length > 30 &&
              (text.includes('1080p') || text.includes('720p') || text.includes('2160p') ||
                text.includes('4K') || text.includes('HEVC') || text.includes('x264') || text.includes('x265'))) {
              quality = text;
              break;
            }
          }
        }

        // Year-based filtering for collections
        if (targetYear && quality !== 'Unknown Quality') {
          // Check for years in quality text
          const yearMatches = quality.match(/\((\d{4})\)/g);
          let hasMatchingYear = false;

          if (yearMatches && yearMatches.length > 0) {
            for (const yearMatch of yearMatches) {
              const year = parseInt(yearMatch.replace(/[()]/g, ''));
              if (year === targetYear) {
                hasMatchingYear = true;
                break;
              }
            }
            if (!hasMatchingYear) {
              log(`[UHDMovies] Skipping link due to year mismatch. Target: ${targetYear}, Found: ${yearMatches.join(', ')} in "${quality}"`);
              return; // Skip this link
            }
          } else {
            // If no year in quality text, check filename and other indicators
            const linkText = $(element).text().trim();
            const parentText = $(element).parent().text().trim();
            const combinedText = `${quality} ${linkText} ${parentText}`;

            // Look for years in combined text
            const allYearMatches = combinedText.match(/\((\d{4})\)/g) || combinedText.match(/(\d{4})/g);
            if (allYearMatches) {
              let foundTargetYear = false;
              for (const yearMatch of allYearMatches) {
                const year = parseInt(yearMatch.replace(/[()]/g, ''));
                if (year >= 1900 && year <= 2030) { // Valid movie year range
                  if (year === targetYear) {
                    foundTargetYear = true;
                    break;
                  }
                }
              }
              if (!foundTargetYear && allYearMatches.length > 0) {
                log(`[UHDMovies] Skipping link due to no matching year found. Target: ${targetYear}, Found years: ${allYearMatches.join(', ')} in combined text`);
                return; // Skip this link
              }
            }

            // Additional check: if quality contains movie names that don't match target year
            const lowerQuality = quality.toLowerCase();
            if (targetYear === 2015) {
              if (lowerQuality.includes('wasp') || lowerQuality.includes('quantumania')) {
                log(`[UHDMovies] Skipping link for 2015 target as it contains 'wasp' or 'quantumania': "${quality}"`);
                return; // Skip this link
              }
            }
          }
        }

        // Extract size from quality text if present
        const sizeMatch = quality.match(/\[([0-9.,]+\s*[KMGT]B[^\]]*)\]/);
        if (sizeMatch) {
          size = sizeMatch[1];
        }

        // Clean up the quality information
        const cleanQuality = extractCleanQuality(quality);

        downloadLinks.push({
          quality: cleanQuality,
          size: size,
          link: link,
          rawQuality: quality.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim()
        });
      }
    });

    // Standalone-style fallback: quality paragraphs containing "[...]" followed by a maxbutton link.
    // Used only when the host-based scan above found nothing (e.g. the gateway host changed).
    if (downloadLinks.length === 0) {
      log('[UHDMovies] Host-based link scan found nothing, trying maxbutton paragraph structure...');
      const bracketRegex = /\[.*\]/;
      $('div.entry-content > p, div.entry-content > div').each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        if (!bracketRegex.test(text)) return;

        const href = $el.next().find('a.maxbutton-1, a.maxbutton').first().attr('href') ||
          $el.find('a.maxbutton-1, a.maxbutton').first().attr('href');
        if (!href || !/^https?:\/\//i.test(href) || downloadLinks.some(item => item.link === href)) return;
        if (targetYear && !textMatchesYear(text, targetYear)) return;

        const sizeMatch = text.match(/\[([0-9.,]+\s*[KMGT]B[^\]]*)\]/);
        downloadLinks.push({
          quality: extractCleanQuality(text),
          size: sizeMatch ? sizeMatch[1] : 'Unknown',
          link: href,
          rawQuality: text.replace(/(\r\n|\n|\r)/gm, ' ').replace(/\s+/g, ' ').trim()
        });
      });
    }

    return {
      title: movieTitle,
      links: downloadLinks
    };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}

function extractCodecs(rawQuality) {
  const codecs = [];
  const text = rawQuality.toLowerCase();

  if (text.includes('hevc') || text.includes('x265')) {
    codecs.push('H.265');
  } else if (text.includes('x264')) {
    codecs.push('H.264');
  }

  if (text.includes('10bit') || text.includes('10-bit')) {
    codecs.push('10-bit');
  }

  if (text.includes('atmos')) {
    codecs.push('Atmos');
  } else if (text.includes('dts-hd')) {
    codecs.push('DTS-HD');
  } else if (text.includes('dts')) {
    codecs.push('DTS');
  } else if (text.includes('ddp5.1') || text.includes('dd+ 5.1') || text.includes('eac3')) {
    codecs.push('EAC3');
  } else if (text.includes('ac3')) {
    codecs.push('AC3');
  }

  if (text.includes('dovi') || text.includes('dolby vision') || /\bdv\b/.test(text)) {
    codecs.push('DV');
  } else if (text.includes('hdr')) {
    codecs.push('HDR');
  }

  return codecs;
}

// Function to try Instant Download method
async function tryInstantDownload($) {
  const instantDownloadLink = $('a:contains("Instant Download")').attr('href');
  const allInstantLinks = $('a:contains("Instant Download"), a:contains("Instant")');
  log(`[UHDMovies] tryInstantDownload: found ${allInstantLinks.length} matching anchor(s).`);
  if (!instantDownloadLink) {
    log('[UHDMovies] tryInstantDownload: no href found on "Instant Download" element.');
    return null;
  }

  log('[UHDMovies] Found "Instant Download" link, attempting to extract final URL...');

  try {
    const parsedUrl = new URL(instantDownloadLink);
    const urlParams = new URLSearchParams(parsedUrl.search);
    const keys = urlParams.get('url');
    const hostname = parsedUrl.hostname;

    // Handle video-seed.dev and video-seed.pro wrapper URLs
    // These sites wrap direct video URLs in a ?url= parameter
    if (hostname.includes('video-seed.dev') || hostname.includes('video-seed.pro')) {
      if (keys) {
        // Check if the url parameter contains a direct video URL (Google Drive, etc.)
        const decodedUrl = decodeURIComponent(keys);
        if (decodedUrl.includes('video-downloads.googleusercontent.com') ||
          decodedUrl.includes('workers.dev') ||
          decodedUrl.includes('.r2.dev') ||
          decodedUrl.includes('.mp4') ||
          decodedUrl.includes('.mkv')) {
          log(`[UHDMovies] ✓ Extracted direct URL from ${hostname}: ${decodedUrl.substring(0, 100)}...`);
          return decodedUrl;
        }

        // Otherwise, try the API approach for video-seed sites
        log(`[UHDMovies] Trying ${hostname} API to extract final URL...`);
        const apiUrl = `${parsedUrl.origin}/api`;
        const formData = new FormData();
        formData.append('keys', keys);

        let apiResponse;
        if (UHDMOVIES_PROXY_URL) {
          const proxiedApiUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(apiUrl)}`;
          log(`[UHDMovies] Making proxied POST request for ${hostname} API`);
          apiResponse = await axiosInstance.post(proxiedApiUrl, formData, {
            headers: {
              ...formData.getHeaders(),
              'x-token': hostname
            }
          });
        } else {
          apiResponse = await axiosInstance.post(apiUrl, formData, {
            headers: {
              ...formData.getHeaders(),
              'x-token': hostname
            }
          });
        }

        if (apiResponse.data && apiResponse.data.url) {
          let finalUrl = apiResponse.data.url;
          log(`[UHDMovies] ✓ ${hostname} API returned: ${String(finalUrl).substring(0, 100)}...`);
          return finalUrl;
        }
      }

      log(`[UHDMovies] Could not extract URL from ${hostname} wrapper`);
      return null;
    }

    // Standard flow for other hosts (driveleech, driveseed, etc.)
    if (keys) {
      const apiUrl = `${parsedUrl.origin}/api`;
      const formData = new FormData();
      formData.append('keys', keys);

      let apiResponse;
      if (UHDMOVIES_PROXY_URL) {
        const proxiedApiUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(apiUrl)}`;
        log(`[UHDMovies] Making proxied POST request for Instant Download API to: ${apiUrl}`);
        apiResponse = await axiosInstance.post(proxiedApiUrl, formData, {
          headers: {
            ...formData.getHeaders(),
            'x-token': hostname
          }
        });
      } else {
        apiResponse = await axiosInstance.post(apiUrl, formData, {
          headers: {
            ...formData.getHeaders(),
            'x-token': hostname
          }
        });
      }

      if (apiResponse.data && apiResponse.data.url) {
        let finalUrl = apiResponse.data.url;
        log(`[UHDMovies] tryInstantDownload: API responded with url: ${String(finalUrl).substring(0, 200)}...`);
        // Fix spaces in workers.dev URLs by encoding them properly
        if (finalUrl.includes('workers.dev')) {
          const urlParts = finalUrl.split('/');
          const filename = urlParts[urlParts.length - 1];
          const encodedFilename = filename.replace(/ /g, '%20');
          urlParts[urlParts.length - 1] = encodedFilename;
          finalUrl = urlParts.join('/');
        }
        log('[UHDMovies] Extracted final link from API:', finalUrl);
        return finalUrl;
      }
    }

    log('[UHDMovies] Could not find a valid final download link from Instant Download.');
    return null;
  } catch (error) {
    log(`[UHDMovies] Error processing "Instant Download": ${error.message}`);
    return null;
  }
}

// Function to try Resume Cloud method
async function tryResumeCloud($, pageOrigin = 'https://driveleech.net') {
  // Look for both "Resume Cloud" and "Cloud Resume Download" buttons
  const resumeCloudButton = $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download"), a:contains("Resume Worker Bot"), a:contains("Worker")');
  log(`[UHDMovies] tryResumeCloud: found ${resumeCloudButton.length} candidate button(s).`);

  if (resumeCloudButton.length === 0) {
    // Broaden search: any anchor containing 'Resume' and 'Cloud' text
    const broadButtons = $('a').filter((_, el) => {
      const t = (el.children && el.children.length ? $(el).text() : $(el).text()).toLowerCase();
      return t.includes('resume') || t.includes('cloud');
    });
    log(`[UHDMovies] tryResumeCloud: broadened scan found ${broadButtons.length} anchor(s).`);
    if (broadButtons.length > 0) {
      const href = broadButtons.first().attr('href');
      if (href) {
        // Fall through to processing as resumeLink below by simulating
        const fake$ = $.root();
      }
    }
    // Also check for direct links on current page as last resort
    const direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (direct) {
      let link = direct;
      if (link.includes('workers.dev')) {
        const parts = link.split('/');
        const fn = parts[parts.length - 1];
        parts[parts.length - 1] = fn.replace(/ /g, '%20');
        link = parts.join('/');
      }
      log(`[UHDMovies] tryResumeCloud: direct link found on page without explicit button: ${link}`);
      return link;
    }
    return null;
  }

  const resumeLink = resumeCloudButton.attr('href');
  if (!resumeLink) {
    log('[UHDMovies] tryResumeCloud: button has no href attribute.');
    return null;
  }

  // Check if it's already a direct download link (workers.dev)
  if (resumeLink.includes('workers.dev') || resumeLink.startsWith('http')) {
    let directLink = resumeLink;
    // Fix spaces in workers.dev URLs by encoding them properly
    if (directLink.includes('workers.dev')) {
      const urlParts = directLink.split('/');
      const filename = urlParts[urlParts.length - 1];
      const encodedFilename = filename.replace(/ /g, '%20');
      urlParts[urlParts.length - 1] = encodedFilename;
      directLink = urlParts.join('/');
    }
    log(`[UHDMovies] Found direct "Cloud Resume Download" link: ${directLink}`);
    return directLink;
  }

  // Otherwise, follow the link to get the final download
  try {
    const resumeUrl = new URL(resumeLink, pageOrigin).href;
    log(`[UHDMovies] Found 'Resume Cloud' page link. Following to: ${resumeUrl}`);

    // "Click" the link by making another request
    const finalPageResponse = await makeRequest(resumeUrl, { maxRedirects: 10 });
    const $$ = cheerio.load(finalPageResponse.data);

    // Look for direct download links
    let finalDownloadLink = $$('a.btn-success[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (!finalDownloadLink) {
      const candidateCount = $$('a[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').length;
      log(`[UHDMovies] tryResumeCloud: no primary selector matched, but found ${candidateCount} candidate link(s) on page.`);
      if (candidateCount > 0) {
        finalDownloadLink = $$('a[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').first().attr('href');
      }
    }

    if (finalDownloadLink) {
      // Fix spaces in workers.dev URLs by encoding them properly
      if (finalDownloadLink.includes('workers.dev')) {
        // Split the URL at the last slash to separate the base URL from the filename
        const urlParts = finalDownloadLink.split('/');
        const filename = urlParts[urlParts.length - 1];
        // Encode spaces in the filename part only
        const encodedFilename = filename.replace(/ /g, '%20');
        urlParts[urlParts.length - 1] = encodedFilename;
        finalDownloadLink = urlParts.join('/');
      }
      log(`[UHDMovies] Extracted final Resume Cloud link: ${finalDownloadLink}`);
      return finalDownloadLink;
    } else {
      log('[UHDMovies] Could not find the final download link on the "Resume Cloud" page.');
      return null;
    }
  } catch (error) {
    log(`[UHDMovies] Error processing "Resume Cloud": ${error.message}`);
    return null;
  }
}

// Environment variable to control URL validation
const URL_VALIDATION_ENABLED = process.env.DISABLE_URL_VALIDATION !== 'true';
log(`[UHDMovies] URL validation is ${URL_VALIDATION_ENABLED ? 'enabled' : 'disabled'}.`);

// Validate if a video URL is working (not 404 or broken)
async function validateVideoUrl(url, timeout = 10000) {
  // Skip validation if disabled via environment variable
  if (!URL_VALIDATION_ENABLED) {
    log(`[UHDMovies] URL validation disabled, skipping validation for: ${url.substring(0, 100)}...`);
    return true;
  }

  try {
    log(`[UHDMovies] Validating URL: ${url.substring(0, 100)}...`);

    // Use proxy for URL validation if enabled
    let response;
    if (UHDMOVIES_PROXY_URL) {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      log(`[UHDMovies] Making proxied HEAD request for validation to: ${url}`);
      response = await axiosInstance.head(proxiedUrl, {
        timeout,
        headers: {
          'Range': 'bytes=0-1' // Just request first byte to test
        }
      });
    } else {
      response = await axiosInstance.head(url, {
        timeout,
        headers: {
          'Range': 'bytes=0-1' // Just request first byte to test
        }
      });
    }

    // Check if status is OK (200-299) or partial content (206)
    if (response.status >= 200 && response.status < 400) {
      log(`[UHDMovies] ✓ URL validation successful (${response.status})`);
      return true;
    } else {
      log(`[UHDMovies] ✗ URL validation failed with status: ${response.status}`);
      // Fall through to GET retry
    }
  } catch (error) {
    log(`[UHDMovies] ✗ URL validation HEAD failed: ${error.message}`);
  }

  // Fallback 1: Treat some known statuses/domains as acceptable without HEAD support
  try {
    const lower = url.toLowerCase();
    if (lower.includes('workers.dev') || lower.includes('driveleech.net/d/')) {
      log('[UHDMovies] URL appears to be a direct download on workers.dev or driveleech; attempting GET fallback.');
    }

    // Fallback 2: Try GET with small range
    let getResponse;
    if (UHDMOVIES_PROXY_URL) {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      log(`[UHDMovies] Making proxied GET fallback request for validation to: ${url}`);
      getResponse = await axiosInstance.get(proxiedUrl, {
        timeout,
        responseType: 'stream',
        headers: { 'Range': 'bytes=0-1' }
      });
    } else {
      getResponse = await axiosInstance.get(url, {
        timeout,
        responseType: 'stream',
        headers: { 'Range': 'bytes=0-1' }
      });
    }

    if (getResponse.status >= 200 && getResponse.status < 500) {
      log(`[UHDMovies] ✓ GET fallback validation accepted (${getResponse.status}).`);
      return true;
    }
  } catch (err) {
    log(`[UHDMovies] ✗ GET fallback validation failed: ${err.message}`);
  }

  return false;
}

// Function to resolve cdn.video-leech.pro redirects to final Google Drive URLs
async function resolveVideoLeechRedirect(videoLeechUrl) {
  try {
    log(`[UHDMovies] Resolving video-leech redirect: ${videoLeechUrl.substring(0, 80)}...`);

    // Use HEAD request to get redirect location without downloading content
    let response;
    if (UHDMOVIES_PROXY_URL) {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(videoLeechUrl)}`;
      response = await axiosInstance.head(proxiedUrl, {
        maxRedirects: 5,
        validateStatus: () => true, // Accept all status codes
        timeout: 15000
      });
    } else {
      response = await axiosInstance.head(videoLeechUrl, {
        maxRedirects: 5,
        validateStatus: () => true, // Accept all status codes
        timeout: 15000
      });
    }

    // Check Location header for redirect
    if (response.headers && response.headers.location) {
      const location = response.headers.location;
      log(`[UHDMovies] Found redirect location: ${location.substring(0, 100)}...`);

      // Handle both video-seed.pro and video-seed.dev wrapper URLs
      if (location.includes('video-seed.pro') || location.includes('video-seed.dev')) {
        // Extract direct video URL from the ?url= parameter
        try {
          const urlParams = new URLSearchParams(new URL(location).search);
          const videoUrl = urlParams.get('url');

          if (videoUrl) {
            const decodedUrl = decodeURIComponent(videoUrl);
            // Check for various direct video URL patterns
            if (decodedUrl.includes('video-downloads.googleusercontent.com') ||
              decodedUrl.includes('workers.dev') ||
              decodedUrl.includes('.r2.dev') ||
              decodedUrl.includes('.mp4') ||
              decodedUrl.includes('.mkv')) {
              const hostname = new URL(location).hostname;
              log(`[UHDMovies] ✓ Extracted direct video URL from ${hostname} redirect`);
              return decodedUrl;
            }
          }
        } catch (parseError) {
          log(`[UHDMovies] Error parsing redirect URL: ${parseError.message}`);
        }
      }
    }

    // Try following the redirect chain with GET request if HEAD didn't work
    try {
      let getResponse;
      if (UHDMOVIES_PROXY_URL) {
        const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(videoLeechUrl)}`;
        getResponse = await axiosInstance.get(proxiedUrl, {
          maxRedirects: 5,
          validateStatus: () => true,
          timeout: 15000
        });
      } else {
        getResponse = await axiosInstance.get(videoLeechUrl, {
          maxRedirects: 5,
          validateStatus: () => true,
          timeout: 15000
        });
      }

      // Check the final request URL after redirects
      const finalUrl = getResponse.request?.res?.responseUrl || getResponse.request?.responseURL;
      if (finalUrl && (finalUrl.includes('video-seed.pro') || finalUrl.includes('video-seed.dev'))) {
        const urlParams = new URLSearchParams(new URL(finalUrl).search);
        const videoUrl = urlParams.get('url');
        if (videoUrl) {
          const decodedUrl = decodeURIComponent(videoUrl);
          if (decodedUrl.includes('video-downloads.googleusercontent.com') ||
            decodedUrl.includes('workers.dev') ||
            decodedUrl.includes('.r2.dev') ||
            decodedUrl.includes('.mp4') ||
            decodedUrl.includes('.mkv')) {
            log(`[UHDMovies] ✓ Extracted direct video URL from GET redirect chain`);
            return decodedUrl;
          }
        }
      }
    } catch (getError) {
      log(`[UHDMovies] GET redirect follow failed: ${getError.message}`);
    }

    // If we can't extract Google Drive URL, return original URL (it might work directly)
    log(`[UHDMovies] Could not extract Google Drive URL, returning original URL`);
    return videoLeechUrl;

  } catch (error) {
    console.error(`[UHDMovies] Error resolving video-leech redirect: ${error.message}`);
    // Return original URL on error
    return videoLeechUrl;
  }
}

// Function to follow redirect links and get the final download URL with size info
async function getFinalLink(redirectUrl) {
  try {
    log(`[UHDMovies] Following redirect: ${redirectUrl}`);

    // Request the driveleech page
    let response = await makeRequest(redirectUrl, { maxRedirects: 10 });
    let $ = cheerio.load(response.data);

    // --- Check for JavaScript redirect ---
    const scriptContent = $('script').html();
    const redirectMatch = scriptContent && scriptContent.match(/window\.location\.replace\("([^"]+)"\)/);

    if (redirectMatch && redirectMatch[1]) {
      const newPath = redirectMatch[1];
      const newUrl = new URL(newPath, 'https://driveleech.net/').href;
      log(`[UHDMovies] Found JavaScript redirect. Following to: ${newUrl}`);
      response = await makeRequest(newUrl, { maxRedirects: 10 });
      $ = cheerio.load(response.data);
    }

    // Extract size and filename information from the page
    let sizeInfo = 'Unknown';
    let fileName = null;

    const sizeElement = $('li.list-group-item:contains("Size :")').text();
    if (sizeElement) {
      const sizeMatch = sizeElement.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
      if (sizeMatch) sizeInfo = sizeMatch[1];
    }

    const nameElement = $('li.list-group-item:contains("Name :")').text();
    if (nameElement) {
      fileName = nameElement.replace('Name :', '').trim();
    }

    // Try each download method in order until we find a working one
    const downloadMethods = [
      { name: 'Resume Cloud', func: (dom) => tryResumeCloud(dom, new URL(finalFilePageUrl).origin) },
      { name: 'Instant Download', func: tryInstantDownload }
    ];

    for (const method of downloadMethods) {
      try {
        log(`[UHDMovies] Trying ${method.name}...`);
        const finalUrl = await method.func($);

        if (finalUrl) {
          // Validate the URL before using it
          const isValid = await validateVideoUrl(finalUrl);
          if (isValid) {
            log(`[UHDMovies] ✓ Successfully resolved using ${method.name}`);
            return { url: finalUrl, size: sizeInfo, fileName: fileName };
          } else {
            log(`[UHDMovies] ✗ ${method.name} returned invalid/broken URL, trying next method...`);
          }
        } else {
          log(`[UHDMovies] ✗ ${method.name} failed to resolve URL, trying next method...`);
        }
      } catch (error) {
        log(`[UHDMovies] ✗ ${method.name} threw error: ${error.message}, trying next method...`);
      }
    }

    // Final fallback: scan current page for any plausible direct links
    const anyDirect = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
    if (anyDirect) {
      let direct = anyDirect;
      if (direct.includes('workers.dev')) {
        const parts = direct.split('/');
        const fn = parts[parts.length - 1];
        parts[parts.length - 1] = fn.replace(/ /g, '%20');
        direct = parts.join('/');
      }
      const ok = await validateVideoUrl(direct);
      if (ok) {
        log('[UHDMovies] ✓ Final fallback found a direct link on page.');
        return { url: direct, size: sizeInfo, fileName: fileName };
      }
    }

    log('[UHDMovies] ✗ All download methods failed.');
    return null;

  } catch (error) {
    console.error(`[UHDMovies] Error in getFinalLink: ${error.message}`);
    return null;
  }
}

// Compare media to find matching result
function compareMedia(mediaInfo, searchResult) {
  const normalizeString = (str) => String(str || '').toLowerCase().replace(/[^a-zA-Z0-9]/g, '');

  const titleWithAnd = mediaInfo.title.replace(/\s*&\s*/g, ' and ');
  const normalizedMediaTitle = normalizeString(titleWithAnd);
  // TMDB original title (e.g. a different-language release name); skipped when it normalises to nothing
  const altNormalizedTitles = [mediaInfo.originalTitle]
    .filter(Boolean)
    .map(alt => normalizeString(String(alt).replace(/\s*&\s*/g, ' and ')))
    .filter(alt => alt && alt !== normalizedMediaTitle);
  const normalizedResultTitle = normalizeString(searchResult.title);

  log(`[UHDMovies] Comparing: "${mediaInfo.title}" (${mediaInfo.year}) vs "${searchResult.title}"`);
  log(`[UHDMovies] Normalized: "${normalizedMediaTitle}" vs "${normalizedResultTitle}"`);

  // Check if titles match or result title contains media title
  let titleMatches = normalizedResultTitle.includes(normalizedMediaTitle) ||
    altNormalizedTitles.some(alt => normalizedResultTitle.includes(alt));

  // If direct match fails, try checking for franchise/collection matches
  if (!titleMatches) {
    const mainTitle = normalizedMediaTitle.split('and')[0];
    const isCollection = normalizedResultTitle.includes('duology') ||
      normalizedResultTitle.includes('trilogy') ||
      normalizedResultTitle.includes('quadrilogy') ||
      normalizedResultTitle.includes('collection') ||
      normalizedResultTitle.includes('saga');

    if (isCollection && normalizedResultTitle.includes(mainTitle)) {
      log(`[UHDMovies] Found collection match: "${mainTitle}" in collection "${searchResult.title}"`);
      titleMatches = true;
    }
  }

  if (!titleMatches) {
    log(`[UHDMovies] Title mismatch: "${normalizedResultTitle}" does not contain "${normalizedMediaTitle}"`);
    return false;
  }

  // NEW: Negative keyword check for spinoffs
  const negativeKeywords = ['challenge', 'conversation', 'story', 'in conversation'];
  const originalTitleLower = mediaInfo.title.toLowerCase();
  for (const keyword of negativeKeywords) {
    if (normalizedResultTitle.includes(keyword.replace(/\s/g, '')) && !originalTitleLower.includes(keyword)) {
      log(`[UHDMovies] Rejecting spinoff due to keyword: "${keyword}"`);
      return false; // It's a spinoff, reject it.
    }
  }

  // Check year if both are available
  if (mediaInfo.year && searchResult.title) {
    const yearRegex = /\b(19[89]\d|20\d{2})\b/g; // Look for years 1980-2099
    const yearMatchesInResult = searchResult.title.match(yearRegex);
    const yearRangeMatch = searchResult.title.match(/\((\d{4})\s*-\s*(\d{4})\)/);

    let hasMatchingYear = false;

    if (yearMatchesInResult) {
      log(`[UHDMovies] Found years in result: ${yearMatchesInResult.join(', ')}`);
      if (yearMatchesInResult.some(yearStr => Math.abs(parseInt(yearStr) - mediaInfo.year) <= 1)) {
        hasMatchingYear = true;
      }
    }

    if (!hasMatchingYear && yearRangeMatch) {
      log(`[UHDMovies] Found year range in result: ${yearRangeMatch[0]}`);
      const startYear = parseInt(yearRangeMatch[1]);
      const endYear = parseInt(yearRangeMatch[2]);
      if (mediaInfo.year >= startYear - 1 && mediaInfo.year <= endYear + 1) {
        hasMatchingYear = true;
      }
    }

    // If there are any years found in the title, one of them MUST match.
    if ((yearMatchesInResult || yearRangeMatch) && !hasMatchingYear) {
      log(`[UHDMovies] Year mismatch. Target: ${mediaInfo.year}, but no matching year found in result.`);
      return false;
    }
  }

  log(`[UHDMovies] Match successful!`);
  return true;
}

// Function to score search results based on quality keywords and season coverage
function scoreResult(title, requestedSeason = null) {
  let score = 0;
  const lowerTitle = title.toLowerCase();

  // Quality scoring
  if (lowerTitle.includes('remux')) score += 10;
  if (lowerTitle.includes('bluray') || lowerTitle.includes('blu-ray')) score += 8;
  if (lowerTitle.includes('imax')) score += 6;
  if (lowerTitle.includes('4k') || lowerTitle.includes('2160p')) score += 5;
  if (lowerTitle.includes('dovi') || lowerTitle.includes('dolby vision') || /\bdv\b/.test(lowerTitle)) score += 4;
  if (lowerTitle.includes('hdr')) score += 3;
  if (lowerTitle.includes('1080p')) score += 2;
  if (lowerTitle.includes('hevc') || lowerTitle.includes('x265')) score += 1;

  // Season coverage scoring (for TV shows)
  if (requestedSeason !== null) {
    // Check for season range formats like "Season 1 – 2" or "Season 1-2"
    const seasonRangeMatch = lowerTitle.match(/season\s+(\d+)\s*[–-]\s*(\d+)/i);
    if (seasonRangeMatch) {
      const startSeason = parseInt(seasonRangeMatch[1], 10);
      const endSeason = parseInt(seasonRangeMatch[2], 10);
      if (requestedSeason >= startSeason && requestedSeason <= endSeason) {
        score += 50; // High bonus for season range that includes requested season
        log(`[UHDMovies] Season range bonus (+50): ${startSeason}-${endSeason} includes requested season ${requestedSeason}`);
      }
    }

    // Check for specific season mentions
    const specificSeasonMatch = lowerTitle.match(/season\s+(\d+)/i);
    if (specificSeasonMatch) {
      const mentionedSeason = parseInt(specificSeasonMatch[1], 10);
      if (mentionedSeason === requestedSeason) {
        score += 30; // Good bonus for exact season match
        log(`[UHDMovies] Exact season bonus (+30): Season ${mentionedSeason} matches requested season ${requestedSeason}`);
      } else if (mentionedSeason < requestedSeason) {
        score -= 20; // Penalty for older season when requesting newer season
        log(`[UHDMovies] Season penalty (-20): Season ${mentionedSeason} is older than requested season ${requestedSeason}`);
      }
    }

    // Check for "Season X Added" or similar indicators
    if (lowerTitle.includes('season') && lowerTitle.includes('added')) {
      const addedSeasonMatch = lowerTitle.match(/season\s+(\d+)\s+added/i);
      if (addedSeasonMatch) {
        const addedSeason = parseInt(addedSeasonMatch[1], 10);
        if (addedSeason === requestedSeason) {
          score += 40; // High bonus for newly added season
          log(`[UHDMovies] Added season bonus (+40): Season ${addedSeason} was recently added`);
        }
      }
    }
  }

  return score;
}

// Function to parse size string into MB
function parseSize(sizeString) {
  if (!sizeString || typeof sizeString !== 'string') {
    return 0;
  }

  const upperCaseSizeString = sizeString.toUpperCase();

  // Regex to find a number (integer or float) followed by GB, MB, or KB
  const match = upperCaseSizeString.match(/([0-9.,]+)\s*(GB|MB|KB)/);

  if (!match) {
    return 0;
  }

  const sizeValue = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(sizeValue)) {
    return 0;
  }

  const unit = match[2];

  if (unit === 'GB') {
    return sizeValue * 1024;
  } else if (unit === 'MB') {
    return sizeValue;
  } else if (unit === 'KB') {
    return sizeValue / 1024;
  }

  return 0;
}

// Helper function to extract cookies from jar for a specific URL
const getCookiesForUrl = async (jar, url) => {
  try {
    const cookies = await jar.getCookies(url);
    if (cookies && cookies.length > 0) {
      return cookies.map(cookie => cookie.toString()).join('; ');
    }
  } catch (error) {
    log(`[UHDMovies] Error extracting cookies for ${url}: ${error.message}`);
  }
  return null;
};

// Helper function to create a proxied session for SID resolution
const createProxiedSession = async (jar) => {
  const { wrapper } = await getAxiosCookieJarSupport();

  const sessionConfig = {
    jar,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  };

  const session = wrapper(axios.create(sessionConfig));

  // If proxy is enabled, wrap the session methods to use proxy
  if (UHDMOVIES_PROXY_URL) {
    log('[UHDMovies] Creating SID session with proxy');
    const originalGet = session.get.bind(session);
    const originalPost = session.post.bind(session);

    session.get = async (url, options = {}) => {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      log(`[UHDMovies] Making proxied SID GET request to: ${url}`);

      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        log('[UHDMovies] Adding cookies to proxied request');
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }

      return originalGet(proxiedUrl, options);
    };

    session.post = async (url, data, options = {}) => {
      const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
      log(`[UHDMovies] Making proxied SID POST request to: ${url}`);

      // Extract cookies from jar and add to headers
      const cookieString = await getCookiesForUrl(jar, url);
      if (cookieString) {
        log('[UHDMovies] Adding cookies to proxied request');
        options.headers = {
          ...options.headers,
          'Cookie': cookieString
        };
      }

      return originalPost(proxiedUrl, data, options);
    };
  }

  return session;
};

// New function to resolve the tech.unblockedgames.world links
async function resolveSidToDriveleech(sidUrl) {
  log(`[UHDMovies] Resolving SID link: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const jar = new CookieJar();

  // Create session with proxy support
  const session = await createProxiedSession(jar);

  try {
    // Step 0: Get the _wp_http value
    log("  [SID] Step 0: Fetching initial page...");
    const responseStep0 = await session.get(sidUrl);
    let $ = cheerio.load(responseStep0.data);
    const initialForm = $('#landing');
    const wp_http_step1 = initialForm.find('input[name="_wp_http"]').val();
    const action_url_step1 = initialForm.attr('action');

    if (!wp_http_step1 || !action_url_step1) {
      console.error("  [SID] Error: Could not find _wp_http in initial form.");
      return null;
    }

    // Step 1: POST to the first form's action URL
    log("  [SID] Step 1: Submitting initial form...");
    const step1Data = new URLSearchParams({ '_wp_http': wp_http_step1 });
    const responseStep1 = await session.post(action_url_step1, step1Data, {
      headers: { 'Referer': sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // Step 2: Parse verification page for second form
    log("  [SID] Step 2: Parsing verification page...");
    $ = cheerio.load(responseStep1.data);
    const verificationForm = $('#landing');
    const action_url_step2 = verificationForm.attr('action');
    const wp_http2 = verificationForm.find('input[name="_wp_http2"]').val();
    const token = verificationForm.find('input[name="token"]').val();

    if (!action_url_step2) {
      console.error("  [SID] Error: Could not find verification form.");
      return null;
    }

    // Step 3: POST to the verification URL
    log("  [SID] Step 3: Submitting verification...");
    const step2Data = new URLSearchParams({ '_wp_http2': wp_http2, 'token': token });
    const responseStep2 = await session.post(action_url_step2, step2Data, {
      headers: { 'Referer': responseStep1.request.res.responseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // Step 4: Find dynamic cookie and link from JavaScript
    log("  [SID] Step 4: Parsing final page for JS data...");
    let finalLinkPath = null;
    let cookieName = null;
    let cookieValue = null;

    const scriptContent = responseStep2.data;
    const cookieMatch = scriptContent.match(/s_343\('([^']+)',\s*'([^']+)'/);
    const linkMatch = scriptContent.match(/c\.setAttribute\("href",\s*"([^"]+)"\)/);

    if (cookieMatch) {
      cookieName = cookieMatch[1].trim();
      cookieValue = cookieMatch[2].trim();
    }
    if (linkMatch) {
      finalLinkPath = linkMatch[1].trim();
    }

    if (!finalLinkPath || !cookieName || !cookieValue) {
      console.error("  [SID] Error: Could not extract dynamic cookie/link from JS.");
      return null;
    }

    const finalUrl = new URL(finalLinkPath, origin).href;
    log(`  [SID] Dynamic link found: ${finalUrl}`);
    log(`  [SID] Dynamic cookie found: ${cookieName}`);

    // Step 5: Set cookie and make final request
    log("  [SID] Step 5: Setting cookie and making final request...");
    await jar.setCookie(`${cookieName}=${cookieValue}`, origin);

    const finalResponse = await session.get(finalUrl, {
      headers: { 'Referer': responseStep2.request.res.responseUrl }
    });

    // Step 6: Extract driveleech URL from meta refresh tag
    $ = cheerio.load(finalResponse.data);
    const metaRefresh = $('meta[http-equiv="refresh"]');
    if (metaRefresh.length > 0) {
      const content = metaRefresh.attr('content');
      const urlMatch = content.match(/url=(.*)/i);
      if (urlMatch && urlMatch[1]) {
        const driveleechUrl = urlMatch[1].replace(/"/g, "").replace(/'/g, "");
        log(`  [SID] SUCCESS! Resolved Driveleech URL: ${driveleechUrl}`);
        return driveleechUrl;
      }
    }

    console.error("  [SID] Error: Could not find meta refresh tag with Driveleech URL.");
    return null;

  } catch (error) {
    console.error(`  [SID] Error during SID resolution: ${error.message}`);
    if (error.response) {
      console.error(`  [SID] Status: ${error.response.status}`);
    }
    return null;
  }
}

// ============================================================================
// Extraction logic ported from the working standalone UHDMovies source:
//   - bypassHrefli   (generic form#landing loop, ?go= token flow, meta/JS redirects)
//   - extractVideoSeed (urlencoded POST to <host>/api, text/regex response parsing)
//   - Driveseed file page handling (Instant / Resume Cloud / Cloud Download buttons)
// They run on this provider's axios instance, so UHDMOVIES_PROXY_URL is honoured.
// Cookies are tracked in memory per bypass call and are never logged.
// ============================================================================

// Resolve an unblockedgames-style gateway link. Returns { driveUrl, filePageUrl } or null.
//   driveUrl    - the URL the gateway redirects to (driveseed/driveleech "r?key=..." page)
//   filePageUrl - the final Driveseed file page, when the redirect page exposes it
async function bypassHrefli(url) {
  const host = getBaseUrl(url);
  const cookies = new Map();

  const absorbCookies = (response) => {
    const raw = response.headers && response.headers['set-cookie'];
    const setCookie = Array.isArray(raw) ? raw.join('\n') : String(raw || '');
    for (const item of setCookie.split(/\n|,(?=[^;,]+=)/)) {
      const pair = item.split(';')[0].trim();
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!value || value.toLowerCase() === 'deleted') cookies.delete(name);
      else cookies.set(name, value);
    }
  };

  const request = async (requestUrl, options = {}) => {
    const headers = { ...BROWSER_HEADERS, ...(options.headers || {}) };
    if (cookies.size > 0) {
      headers.Cookie = Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
    }
    const response = await fetchPage(requestUrl, { ...options, headers });
    absorbCookies(response);
    return response;
  };

  const getMetaRefreshUrl = (html) => {
    const content = cheerio.load(html)("meta[http-equiv='refresh']").attr('content') || '';
    return (content.match(/url\s*=\s*['"]?([^'";]+)/i) || [])[1] || '';
  };

  try {
    let currentUrl = url;
    let response = await request(currentUrl);
    let html = response.html;
    let lastFormData = {};
    let formSteps = 0;
    diag(`Hrefli: landing page HTTP ${response.status} (${html.length} bytes) from ${safeUrl(url)}`);

    // Submit each form#landing (hidden inputs) in turn; the gateway chains up to a few of them.
    for (let step = 0; step < 5; step++) {
      const $step = cheerio.load(html);
      const form = $step('form#landing').first();
      const action = form.attr('action');
      if (!action) break;

      const formData = {};
      form.find('input[name]').each((_, el) => {
        const name = $step(el).attr('name');
        if (name) formData[name] = $step(el).attr('value') || '';
      });
      if (Object.keys(formData).length === 0) break;

      lastFormData = formData;
      const referer = response.finalUrl || currentUrl;
      currentUrl = new URL(action, currentUrl).toString();
      response = await request(currentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': referer
        },
        data: new URLSearchParams(formData).toString()
      });
      html = response.html;
      formSteps++;
      if (!cheerio.load(html)('form#landing').length) break;
    }
    log(`[UHDMovies] Hrefli: submitted ${formSteps} landing form(s), last HTTP ${response.status}`);

    // 1) meta refresh
    let redirectUrl = getMetaRefreshUrl(html);

    // 2) "?go=<token>" flow: the token becomes a cookie name whose value is _wp_http2
    if (!redirectUrl) {
      const goMatch = html.match(/[?&]go=([^"'&\s]+)/i);
      if (goMatch) {
        const skToken = safeDecode(goMatch[1]);
        const wpHttp2 = lastFormData._wp_http2 || '';
        if (wpHttp2) cookies.set(skToken, wpHttp2);
        log('[UHDMovies] Hrefli: following ?go= token step');
        response = await request(`${host}?go=${encodeURIComponent(skToken)}`);
        html = response.html;
        redirectUrl = getMetaRefreshUrl(html);
      }
    }

    // 3) JavaScript redirect
    if (!redirectUrl) {
      redirectUrl = (html.match(/(?:location(?:\.href)?\s*=|replace\()\s*['"]([^'"]+)['"]/i) || [])[1] || '';
    }

    if (!redirectUrl) {
      diagWarn(`Hrefli: no redirect found after landing forms (last HTTP ${response.status}, ${html.length} bytes)`);
      return null;
    }

    const driveUrl = new URL(redirectUrl.trim(), response.finalUrl || currentUrl).toString();
    log(`[UHDMovies] Hrefli: gateway redirects to ${safeUrl(driveUrl)}`);
    const driveRes = await request(driveUrl);
    const path = (driveRes.html.match(/replace\(\s*['"]([^'"]+)['"]\s*\)/i) || [])[1];

    if (path === '/404') {
      diagWarn(`Hrefli: ${safeUrl(driveUrl)} reports 404 (file removed?)`);
      return null;
    }
    if (!path) {
      diagWarn(`Hrefli: no file-page redirect on ${safeUrl(driveUrl)} (HTTP ${driveRes.status}); returning intermediate URL`);
      return { driveUrl, filePageUrl: null };
    }
    return { driveUrl, filePageUrl: new URL(path, driveRes.finalUrl || driveUrl).toString() };
  } catch (error) {
    diagWarn(`Hrefli bypass failed: ${error.message}`);
    return null;
  }
}

// VideoSeed-style "Instant Download" API. finalLink looks like https://<host>/?url=<token>.
// Returns the direct media URL or null. The token is never logged.
async function extractVideoSeed(finalLink) {
  try {
    const urlObj = new URL(finalLink);
    const host = urlObj.host || 'video-seed.xyz';
    const rawToken = getUrlParamRaw(finalLink);
    if (!rawToken) {
      diagWarn(`VideoSeed: no url= token in ${safeUrl(finalLink)}`);
      return null;
    }
    const decodedToken = safeDecode(rawToken);

    // Standalone behaviour first (urlencoded body, raw token), then the decoded token, then the
    // multipart body this provider used before.
    const attempts = [{ token: rawToken, mode: 'urlencoded' }];
    if (decodedToken !== rawToken) attempts.push({ token: decodedToken, mode: 'urlencoded' });
    attempts.push({ token: decodedToken, mode: 'multipart' });

    const apiUrl = `${urlObj.protocol}//${host}/api`;
    for (const attempt of attempts) {
      try {
        let response;
        if (attempt.mode === 'urlencoded') {
          response = await fetchPage(apiUrl, {
            method: 'POST',
            headers: {
              ...BROWSER_HEADERS,
              'Content-Type': 'application/x-www-form-urlencoded',
              'x-token': host,
              'Referer': finalLink
            },
            data: `keys=${encodeURIComponent(attempt.token)}`,
            maxRedirects: 5,
            timeout: 20000
          });
        } else {
          const formData = new FormData();
          formData.append('keys', attempt.token);
          response = await fetchPage(apiUrl, {
            method: 'POST',
            headers: { ...BROWSER_HEADERS, ...formData.getHeaders(), 'x-token': host, 'Referer': finalLink },
            data: formData,
            maxRedirects: 5,
            timeout: 20000
          });
        }

        const text = response.html || '';
        let streamUrl = null;
        try {
          const json = JSON.parse(text);
          if (json && typeof json.url === 'string') streamUrl = json.url;
        } catch (e) {
          // Not JSON (some hosts answer text/html) - fall back to the standalone regex.
        }
        if (!streamUrl) {
          const match = text.match(/"url"\s*:\s*"([^"]+)"/);
          if (match) streamUrl = match[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
        }

        log(`[UHDMovies] VideoSeed ${host} (${attempt.mode}): HTTP ${response.status}, url ${streamUrl ? 'found' : 'not found'}`);
        if (streamUrl && /^https?:\/\//i.test(streamUrl)) {
          return fixWorkersUrl(streamUrl);
        }
      } catch (error) {
        log(`[UHDMovies] VideoSeed ${host} (${attempt.mode}) request error: ${error.message}`);
      }
    }
    diagWarn(`VideoSeed: API at ${host} returned no usable URL`);
    return null;
  } catch (error) {
    diagWarn(`VideoSeed extraction failed: ${error.message}`);
    return null;
  }
}

// Load a Driveseed/Driveleech page, following the "r?key=" JavaScript redirect to the real file page.
// Returns { $, pageUrl } or null.
async function loadDriveseedFilePage(startUrl) {
  let pageUrl = startUrl;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetchPage(pageUrl, { headers: BROWSER_HEADERS });
    const currentUrl = res.finalUrl || pageUrl;
    const $ = cheerio.load(res.html);

    if ($('li.list-group-item').length > 0 || $('div.text-center > a').length > 0) {
      diag(`Driveseed file page loaded (HTTP ${res.status}): ${safeUrl(currentUrl)}`);
      return { $, pageUrl: currentUrl };
    }

    const redirectMatch = res.html.match(/replace\(\s*['"]([^'"]+)['"]\s*\)/i);
    if (!redirectMatch || redirectMatch[1] === '/404') {
      diagWarn(`Driveseed page has no file info and no redirect (HTTP ${res.status}, ${res.html.length} bytes): ${safeUrl(currentUrl)}`);
      return null;
    }
    pageUrl = new URL(redirectMatch[1], currentUrl).toString();
    log(`[UHDMovies] Driveseed: following page redirect to ${safeUrl(pageUrl)}`);
  }
  diagWarn(`Driveseed: too many page redirects starting from ${safeUrl(startUrl)}`);
  return null;
}

// Size / filename from a Driveseed file page.
function readFileMeta($) {
  let sizeInfo = 'Unknown';
  let fileName = null;

  const sizeText = $('li.list-group-item:contains("Size :")').text() || '';
  const sizeMatch = sizeText.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
  if (sizeMatch) sizeInfo = sizeMatch[1];

  const nameElement = $('li.list-group-item:contains("Name :")');
  if (nameElement.length > 0) {
    fileName = nameElement.text().replace('Name :', '').trim();
  } else {
    const h5Title = $('div.card-header h5').clone().children().remove().end().text().trim();
    if (h5Title) {
      fileName = h5Title.replace(/\[.*\]/, '').trim();
    }
  }
  return { sizeInfo, fileName };
}

// Collect the download buttons of a Driveseed file page (standalone selector: div.text-center > a).
function listDriveseedActions($, pageUrl) {
  const baseDomain = getBaseUrl(pageUrl);
  const actions = [];
  const seen = new Set();
  const scoped = $('div.text-center > a');
  const anchors = scoped.length > 0 ? scoped : $('a');

  anchors.each((index, element) => {
    const label = $(element).text().replace(/\s+/g, ' ').trim();
    const lower = label.toLowerCase();
    const href = $(element).attr('href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;

    let type = null;
    if (lower.includes('instant')) type = 'instant';
    else if (/resume\s*cloud|cloud\s*resume|resume\s*worker|worker\s*bot/.test(lower)) type = 'resume';
    else if (/cloud\s*download/.test(lower)) type = 'cloud';
    if (!type) return;

    const absolute = fixUrl(href, baseDomain);
    const key = `${type}|${absolute}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push({ type, label, url: absolute });
  });
  return actions;
}

// Follow an "Instant Download" button until a URL carrying ?url= appears (redirect hops are read from
// the Location header, so this also works when the final host is not observable through the proxy).
async function followToUrlParam(startUrl, maxHops = 5) {
  let current = startUrl;
  for (let hop = 0; hop < maxHops; hop++) {
    if (getUrlParamRaw(current)) return current;
    const res = await fetchPage(current, { headers: BROWSER_HEADERS, maxRedirects: 0, timeout: 20000 });
    const location = res.headers && (res.headers.location || res.headers.Location);
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return getUrlParamRaw(res.finalUrl) ? res.finalUrl : null;
  }
  return getUrlParamRaw(current) ? current : null;
}

// "Resume Cloud" / "Cloud Download": the button opens a page that holds the real (workers.dev) link.
async function resolveCloudPage(url) {
  if (/workers\.dev|\.r2\.dev|googleusercontent\.com/i.test(url)) return fixWorkersUrl(url);

  const res = await fetchPage(url, { headers: BROWSER_HEADERS, maxRedirects: 10 });
  if (res.status >= 400) {
    diagWarn(`Driveseed cloud page returned HTTP ${res.status}: ${safeUrl(url)}`);
    return null;
  }
  const $ = cheerio.load(res.html);
  const directSelector = 'a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]';
  const link = $('a.btn-success[href*="workers.dev"]').first().attr('href') ||
    $(directSelector).first().attr('href') ||
    $('a.btn-success').first().attr('href');
  if (!link || link.startsWith('#')) {
    diagWarn(`Driveseed cloud page has no download link: ${safeUrl(url)}`);
    return null;
  }
  return fixWorkersUrl(fixUrl(link, getBaseUrl(res.finalUrl || url)));
}

async function resolveDriveseedAction(action) {
  if (action.type === 'instant') {
    const finalLink = await followToUrlParam(action.url);
    if (!finalLink) {
      diagWarn('Driveseed Instant: no url= parameter found after following the button');
      return null;
    }
    const decoded = safeDecode(getUrlParamRaw(finalLink));
    // Some hosts put the direct media URL in ?url=; others put a token for the /api endpoint.
    if (/^https?:\/\//i.test(decoded)) return fixWorkersUrl(decoded);
    return extractVideoSeed(finalLink);
  }
  return resolveCloudPage(action.url);
}

const DRIVESEED_ACTION_PRIORITY = { resume: 0, instant: 1, cloud: 2 };

// Standalone-style Driveseed extraction. Returns { url, sizeInfo, fileName, method } or null.
async function extractFromDriveseed(startUrl) {
  if (!startUrl) return null;
  const page = await loadDriveseedFilePage(startUrl);
  if (!page) return null;

  const { $, pageUrl } = page;
  const { sizeInfo, fileName } = readFileMeta($);
  const actions = listDriveseedActions($, pageUrl)
    .sort((a, b) => DRIVESEED_ACTION_PRIORITY[a.type] - DRIVESEED_ACTION_PRIORITY[b.type])
    .slice(0, 4);
  diag(`Driveseed page: size=${sizeInfo}, name="${(fileName || 'n/a').substring(0, 80)}", buttons=[${actions.map(a => a.label).join(' | ') || 'none'}]`);

  for (const action of actions) {
    try {
      const resolved = await resolveDriveseedAction(action);
      if (!resolved) {
        diagWarn(`Driveseed ${action.type} ("${action.label}") produced no URL`);
        continue;
      }
      if (!(await validateVideoUrl(resolved))) {
        diagWarn(`Driveseed ${action.type} URL failed validation: ${safeUrl(resolved)}`);
        continue;
      }
      diag(`Driveseed ${action.type} OK: ${safeUrl(resolved)}`);
      return { url: resolved, sizeInfo, fileName, method: `driveseed-${action.type}` };
    } catch (error) {
      diagWarn(`Driveseed ${action.type} failed: ${error.message}`);
    }
  }
  return null;
}

// Previous NuvioStreams resolution path (shared linkResolver utils), kept as a fallback.
async function extractViaLinkResolver(redirectUrl) {
  const { $, finalFilePageUrl } = await followRedirectToFilePage({
    redirectUrl: redirectUrl,
    get: (url, opts) => makeRequest(url, opts),
    log: console
  });
  log(`[UHDMovies] Resolved redirect to final file page: ${finalFilePageUrl}`);

  const { sizeInfo, fileName } = readFileMeta($);

  // Use shared util to extract final download URL from file page
  const origin = new URL(finalFilePageUrl).origin;
  const finalUrl = await extractFinalDownloadFromFilePage($, {
    origin,
    get: (url, opts) => makeRequest(url, opts),
    post: (url, data, opts) => axiosInstance.post(url.startsWith('http') ? (UHDMOVIES_PROXY_URL ? `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}` : url) : url, data, opts),
    validate: (url) => validateVideoUrl(url),
    log: console
  });

  if (!finalUrl) return null;
  return { url: finalUrl, sizeInfo, fileName, method: 'linkResolver' };
}

// Resolve a gateway (SID/Hrefli) link. Tries the standalone bypass first, then the previous
// step-by-step resolver. Returns { redirectUrl, filePageUrl } or null.
async function resolveSidLink(sidUrl) {
  try {
    const result = await bypassHrefli(sidUrl);
    if (result && (result.filePageUrl || result.driveUrl)) {
      diag(`SID resolved via Hrefli bypass -> ${safeUrl(result.filePageUrl || result.driveUrl)}`);
      return { redirectUrl: result.driveUrl || result.filePageUrl, filePageUrl: result.filePageUrl || null };
    }
    diagWarn('Hrefli bypass produced no link; trying legacy SID resolver...');
  } catch (error) {
    diagWarn(`Hrefli bypass threw: ${error.message}; trying legacy SID resolver...`);
  }

  const legacyUrl = await resolveSidToDriveleech(sidUrl);
  if (legacyUrl) {
    diag(`SID resolved via legacy resolver -> ${safeUrl(legacyUrl)}`);
    return { redirectUrl: legacyUrl, filePageUrl: null };
  }
  diagWarn(`SID link could not be resolved by either method: ${safeUrl(sidUrl)}`);
  return null;
}

// Best-effort resolution label from a file name when the listing page gave no quality.
function deriveQualityFromName(name) {
  if (!name) return null;
  const text = String(name).toLowerCase();
  if (/2160p|4k|uhd/.test(text)) return '4K';
  const match = text.match(/(1080|720|480)p/);
  return match ? `${match[1]}p` : null;
}

// Main function to get streams for TMDB content
async function getUHDMoviesStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const isTv = mediaType === 'tv';
  const seasonNum = isTv && season !== null && season !== undefined && season !== '' ? parseInt(season, 10) : null;
  const episodeNum = isTv && episode !== null && episode !== undefined && episode !== '' ? parseInt(episode, 10) : null;

  log(`[UHDMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${isTv ? `, S:${seasonNum}E:${episodeNum}` : ''}`);
  diag(`Request: TMDB ${tmdbId}, type=${mediaType}${isTv ? `, S${seasonNum}E${episodeNum}` : ''}`);

  if (isTv && (!Number.isInteger(seasonNum) || !Number.isInteger(episodeNum))) {
    diagWarn(`TV request needs a numeric season and episode (got season=${season}, episode=${episode}); returning no streams.`);
    return [];
  }

  const cacheKey = `uhd_final_v24_${tmdbId}_${mediaType}${isTv ? `_s${seasonNum}e${episodeNum}` : ''}`;

  try {
    // 1. Check cache first
    let cachedLinks = await getFromCache(cacheKey);
    if (cachedLinks && cachedLinks.length > 0) {
      diag(`Cache HIT for ${cacheKey}: ${cachedLinks.length} resolved link(s).`);
    } else {
      if (cachedLinks && cachedLinks.length === 0) {
        log(`[UHDMovies] Cache contains empty data for ${cacheKey}. Refetching from source.`);
      }
      diag(`Cache MISS for ${cacheKey}. Fetching from source.`);

      // 2. If cache miss, get TMDB info to perform search
      const tmdbUrl = `https://api.themoviedb.org/3/${isTv ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY_UHDMOVIES}`;
      const tmdbResponse = await axios.get(tmdbUrl, { timeout: 15000 });
      const tmdbData = tmdbResponse.data;
      const mediaInfo = {
        title: isTv ? tmdbData.name : tmdbData.title,
        originalTitle: isTv ? tmdbData.original_name : tmdbData.original_title,
        year: parseInt(((isTv ? tmdbData.first_air_date : tmdbData.release_date) || '').split('-')[0], 10)
      };

      if (!mediaInfo.title) throw new Error('Could not extract title from TMDB response.');
      diag(`TMDB: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})${mediaInfo.originalTitle && mediaInfo.originalTitle !== mediaInfo.title ? `, original "${mediaInfo.originalTitle}"` : ''}`);

      // 3. Search for the media on UHDMovies. Queries are tried in order until one yields a title/year match:
      //    full title, main title (before ":" / "and the"), then the original title.
      const searchQueries = [];
      const addQuery = (value) => {
        const query = String(value || '').trim();
        if (query && !searchQueries.some(existing => existing.toLowerCase() === query.toLowerCase())) {
          searchQueries.push(query);
        }
      };
      addQuery(mediaInfo.title.replace(/:/g, '').replace(/\s*&\s*/g, ' and '));
      let fallbackTitle = mediaInfo.title.split(':')[0].trim();
      if (fallbackTitle.includes('and the')) {
        fallbackTitle = fallbackTitle.split('and the')[0].trim();
      }
      addQuery(fallbackTitle);
      if (mediaInfo.originalTitle) {
        addQuery(mediaInfo.originalTitle.replace(/:/g, '').replace(/\s*&\s*/g, ' and '));
      }

      let searchResults = [];
      let matchingResults = [];
      for (const query of searchQueries) {
        const results = await searchMovies(query);
        if (searchResults.length === 0) searchResults = results;
        matchingResults = results.filter(result => compareMedia(mediaInfo, result));
        if (matchingResults.length > 0) break;
        if (results.length > 0) {
          diag(`None of the ${results.length} result(s) for "${query}" matched "${mediaInfo.title}" (${mediaInfo.year || 'N/A'}).`);
        }
      }

      if (searchResults.length === 0) {
        diagWarn(`No search results found for "${mediaInfo.title}" (queries tried: ${searchQueries.length}).`);
        // Don't cache empty results to allow retrying later
        return [];
      }

      // 4. Find the best matching result
      if (matchingResults.length === 0) {
        diagWarn(`No matching content found for "${mediaInfo.title}" (${mediaInfo.year || 'N/A'}).`);
        // Don't cache empty results to allow retrying later
        return [];
      }

      let scoredResults = null;
      if (matchingResults.length > 1) {
        log(`[UHDMovies] Found ${matchingResults.length} matching results. Scoring to find the best...`);

        scoredResults = matchingResults.map(result => {
          const score = scoreResult(result.title, isTv ? seasonNum : null);
          log(`  - Score ${score}: ${result.title}`);
          return { ...result, score };
        }).sort((a, b) => b.score - a.score);
      }
      const rankedResults = scoredResults || matchingResults;
      diag(`Matched ${matchingResults.length} result(s); best: "${rankedResults[0].title.substring(0, 100)}"`);

      // 5. Extract SID links from the movie/show page. If the best page has none (wrong season, layout
      //    change, ...) try the next-best matches before giving up.
      let downloadInfo = { title: '', links: [] };
      for (const candidate of rankedResults.slice(0, 3)) {
        diag(`Extracting ${isTv ? `S${seasonNum}E${episodeNum}` : 'movie'} links from "${candidate.title.substring(0, 100)}" (${safeUrl(candidate.link)})`);
        downloadInfo = await (isTv ? extractTvShowDownloadLinks(candidate.link, seasonNum, episodeNum) : extractDownloadLinks(candidate.link, mediaInfo.year));
        if (downloadInfo.links.length > 0) break;
        diagWarn(downloadInfo.seasonNotFound
          ? `Season ${seasonNum} not present on this page.`
          : 'No download links found on this page.');
      }

      if (downloadInfo.links.length === 0) {
        diagWarn('No download links found on any matched page.');
        // Don't cache empty results to allow retrying later
        return [];
      }

      diag(`Found ${downloadInfo.links.length} download link(s):`);
      downloadInfo.links.forEach((linkInfo, i) => {
        diag(`  link ${i + 1}: ${linkInfo.quality} | ${linkInfo.size} | ${safeUrl(linkInfo.link)}`);
      });

      // 6. Resolve all gateway links to driveleech/driveseed URLs (intermediate step)
      log(`[UHDMovies] Resolving ${downloadInfo.links.length} SID link(s) to driveleech redirect URLs...`);
      const resolutionPromises = downloadInfo.links.map(async (linkInfo) => {
        try {
          let redirectUrl = null;
          let filePageUrl = null;

          if (linkInfo.link && isSidHref(linkInfo.link)) {
            const resolved = await resolveSidLink(linkInfo.link);
            if (resolved) {
              redirectUrl = resolved.redirectUrl || resolved.filePageUrl;
              filePageUrl = resolved.filePageUrl || null;
            }
          } else if (linkInfo.link && /driveseed|driveleech/i.test(linkInfo.link)) {
            // If it's already a direct driveseed/driveleech link, use it
            redirectUrl = linkInfo.link;
          } else {
            diagWarn(`Unsupported link host, skipping: ${safeUrl(linkInfo.link)}`);
          }

          if (!redirectUrl) {
            diagWarn(`Could not resolve link for ${linkInfo.quality}.`);
            return null;
          }

          log(`[UHDMovies] Caching driveleech redirect URL for ${linkInfo.quality}: ${redirectUrl}`);
          return { ...linkInfo, driveleechRedirectUrl: redirectUrl, driveseedFilePageUrl: filePageUrl };
        } catch (error) {
          console.error(`[UHDMovies] Error resolving ${linkInfo.quality}: ${error.message}`);
          return null;
        }
      });

      cachedLinks = (await Promise.all(resolutionPromises)).filter(Boolean);

      // 7. Save the successfully resolved driveleech redirect URLs to the cache
      if (cachedLinks.length > 0) {
        log(`[UHDMovies] Caching ${cachedLinks.length} resolved driveleech redirect URLs for key: ${cacheKey}`);
        await saveToCache(cacheKey, cachedLinks);
      } else {
        diagWarn('No gateway links could be resolved. Not caching to allow retrying later.');
        return [];
      }
    }

    if (!cachedLinks || cachedLinks.length === 0) {
      log('[UHDMovies] No final file page URLs found after scraping/cache check.');
      return [];
    }

    // Avoid processing the same file page twice (duplicate links on the source page)
    const seenPages = new Set();
    const uniqueLinks = cachedLinks.filter(linkInfo => {
      const key = linkInfo.driveseedFilePageUrl || linkInfo.driveleechRedirectUrl;
      if (!key || seenPages.has(key)) return false;
      seenPages.add(key);
      return true;
    });

    // 8. Process all resolved driveleech/driveseed URLs to get streaming links
    diag(`Processing ${uniqueLinks.length} resolved link(s) into streams.`);
    const streamPromises = uniqueLinks.map(async (linkInfo) => {
      try {
        // Stage 1: standalone-style Driveseed extraction (file page -> Resume Cloud / Instant / Cloud)
        let resolved = null;
        try {
          resolved = await extractFromDriveseed(linkInfo.driveseedFilePageUrl || linkInfo.driveleechRedirectUrl);
        } catch (error) {
          diagWarn(`Driveseed extraction threw for ${linkInfo.quality}: ${error.message}`);
        }

        // Stage 2: previous shared-util resolution path
        if (!resolved) {
          diagWarn(`Driveseed extraction found nothing for ${linkInfo.quality}; trying linkResolver fallback...`);
          try {
            resolved = await extractViaLinkResolver(linkInfo.driveleechRedirectUrl);
          } catch (error) {
            diagWarn(`linkResolver fallback failed for ${linkInfo.quality}: ${error.message}`);
          }
        }

        if (!resolved) {
          diagWarn(`No working method produced a valid final URL for ${linkInfo.quality} / ${linkInfo.size}.`);
          return null;
        }

        let finalUrl = resolved.url;
        const sizeInfo = resolved.sizeInfo || 'Unknown';
        const fileName = resolved.fileName;

        // If the URL is a cdn.video-leech.pro link, resolve it to get the final Google Drive URL
        if (finalUrl && finalUrl.includes('cdn.video-leech.pro')) {
          log(`[UHDMovies] Detected cdn.video-leech.pro URL, resolving redirect to Google Drive...`);
          const resolvedUrl = await resolveVideoLeechRedirect(finalUrl);
          if (resolvedUrl && resolvedUrl !== finalUrl) {
            log(`[UHDMovies] ✓ Resolved to Google Drive URL: ${resolvedUrl.substring(0, 100)}...`);
            finalUrl = resolvedUrl;
          }
        }

        if (!finalUrl) return null;

        const rawQuality = linkInfo.rawQuality || '';
        const quality = (!linkInfo.quality || linkInfo.quality === 'Unknown Quality')
          ? (deriveQualityFromName(fileName) || linkInfo.quality)
          : linkInfo.quality;
        const codecs = extractCodecs(rawQuality || fileName || '');
        const cleanFileName = fileName ? fileName.replace(/\.[^/.]+$/, "").replace(/[._]/g, ' ') : (quality || 'Unknown');

        diag(`Playable URL [${resolved.method}] ${quality} | ${sizeInfo}: ${safeUrl(finalUrl)}`);

        return {
          name: `UHDMovies`,
          title: `${cleanFileName}\n${sizeInfo}`,
          url: finalUrl,
          quality: quality,
          size: sizeInfo,
          fileName: fileName,
          fullTitle: rawQuality,
          codecs: codecs,
          behaviorHints: { bingeGroup: `uhdmovies-${quality}` }
        };
      } catch (error) {
        console.error(`[UHDMovies] Error processing resolved link ${safeUrl(linkInfo.driveleechRedirectUrl)}: ${error.message}`);
        return null;
      }
    });

    // Drop failures and duplicate playable URLs
    const seenUrls = new Set();
    const streams = (await Promise.all(streamPromises)).filter(Boolean).filter(stream => {
      if (seenUrls.has(stream.url)) {
        log(`[UHDMovies] Dropping duplicate stream URL for ${stream.quality}`);
        return false;
      }
      seenUrls.add(stream.url);
      return true;
    });

    if (streams.length === 0) {
      diagWarn(`No playable streams could be produced from ${uniqueLinks.length} resolved link(s).`);
    } else {
      diag(`Returning ${streams.length} playable stream(s) for TMDB ${tmdbId}:`);
    }

    // Sort final streams by size
    streams.sort((a, b) => {
      const sizeA = parseSize(a.size);
      const sizeB = parseSize(b.size);
      return sizeB - sizeA;
    });

    streams.forEach((stream, i) => {
      diag(`  stream ${i + 1}: ${stream.quality} | ${stream.size} | ${safeUrl(stream.url)}`);
    });

    return streams;
  } catch (error) {
    console.error(`[UHDMovies] A critical error occurred in getUHDMoviesStreams for ${tmdbId}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return [];
  }
}

module.exports = { getUHDMoviesStreams };