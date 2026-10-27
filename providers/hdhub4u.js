/**
 * HDHub4u Provider for Stremio Addon
 * Based on the standalone scraper from scrapersdirect/hdhub4u-scraper.js
 * Supports both movies and TV series
 */

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { compareTwoStrings } = require('string-similarity');
const fs = require('fs').promises;
const path = require('path');
const RedisCache = require('../utils/redisCache');

// Debug logging flag - set DEBUG=true to enable verbose logging
const DEBUG = process.env.DEBUG === 'true' || process.env.HDHUB4U_DEBUG === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};

// Create an https agent to ignore SSL certificate errors
const agent = new https.Agent({
    rejectUnauthorized: false
});

let MAIN_URL = "https://new9.hdhub4u.cl"; // Default domain
const DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";

// --- Caching Configuration ---
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
log(`[HDHub4u Cache] Internal cache is ${CACHE_ENABLED ? 'enabled' : 'disabled'}.`);
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.hdhub4u_cache') : path.join(__dirname, '.cache', 'hdhub4u');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Initialize Redis cache
const redisCache = new RedisCache('HDHub4u');

// --- Caching Helper Functions ---
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.error(`[HDHub4u Cache] Error creating cache directory: ${error.message}`);
        }
    }
};

const getFromCache = async (key) => {
    if (!CACHE_ENABLED) return null;

    // Try Redis cache first, then fallback to file system
    const cachedData = await redisCache.getFromCache(key, '', CACHE_DIR);
    if (cachedData) {
        log(`[HDHub4u Cache] HIT for key: ${key}`);
        return cachedData.data || cachedData; // Support both new format (data field) and legacy format
    }

    log(`[HDHub4u Cache] MISS for key: ${key}`);
    return null;
};

const saveToCache = async (key, data) => {
    if (!CACHE_ENABLED) return;

    const cacheData = {
        data: data
    };

    // Save to both Redis and file system
    await redisCache.saveToCache(key, cacheData, '', CACHE_DIR);
    log(`[HDHub4u Cache] SAVED for key: ${key}`);
};

// Initialize cache directory on startup
ensureCacheDir();

// --- Proxy Configuration ---
const HDHUB4U_PROXY_URL = process.env.HDHUB4U_PROXY_URL;
if (HDHUB4U_PROXY_URL) {
    log(`[HDHub4u] Proxy support enabled: ${HDHUB4U_PROXY_URL}`);
} else {
    log('[HDHub4u] No proxy configured, using direct connections');
}

// The domain list used to be re-fetched 3+ times per stream request (stream fetch, search,
// download-links). It rarely changes, so refresh at most once per TTL and share in-flight calls.
const DOMAIN_REFRESH_TTL = 30 * 60 * 1000; // 30 minutes
let lastDomainCheck = 0;
let domainRefreshPromise = null;

/**
 * Fetches the latest domain for HDHub4u (rate-limited, see DOMAIN_REFRESH_TTL).
 */
async function fetchAndUpdateDomain() {
    if (Date.now() - lastDomainCheck < DOMAIN_REFRESH_TTL) return;
    if (domainRefreshPromise) return domainRefreshPromise;

    domainRefreshPromise = (async () => {
        try {
            const response = await makeRequest(DOMAINS_URL, { httpsAgent: agent, timeout: 8000 });
            if (response.data && response.data.HDHUB4u) {
                const newDomain = response.data.HDHUB4u;
                if (newDomain !== MAIN_URL) {
                    log(`[HDHub4u] Updating domain from ${MAIN_URL} to ${newDomain}`);
                    MAIN_URL = newDomain;
                    HEADERS.Referer = `${MAIN_URL}/`;
                }
            }
        } catch (e) {
            console.error("[HDHub4u] Failed to fetch latest domains, using default.", e.message);
        } finally {
            // Also set on failure so a down domains list doesn't add a failing request to every call.
            lastDomainCheck = Date.now();
            domainRefreshPromise = null;
        }
    })();
    return domainRefreshPromise;
}

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Cookie": "xla=s4t",
    "Referer": `${MAIN_URL}/`,
};

// --- Proxy Wrapper Function ---
const REQUEST_TIMEOUT = 15000;
const makeRequest = async (url, options = {}) => {
    // Without a timeout a single stalled host blocks the whole stream request.
    options = { timeout: REQUEST_TIMEOUT, ...options };
    if (HDHUB4U_PROXY_URL) {
        const proxiedUrl = `${HDHUB4U_PROXY_URL}?url=${encodeURIComponent(url)}`;
        log(`[HDHub4u] Using proxy for: ${url}`);
        return axios.get(proxiedUrl, options);
    } else {
        return axios.get(url, options);
    }
};

// =================================================================================
// UTILITY FUNCTIONS
// =================================================================================

/**
 * Applies a ROT13 cipher to a string.
 */
function rot13(value) {
    return value.replace(/[a-zA-Z]/g, function (c) {
        return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
    });
}

/**
 * Base64 encodes a string.
 */
function btoa(value) {
    return Buffer.from(value).toString('base64');
}

/**
 * Base64 decodes a string.
 */
function atob(value) {
    return Buffer.from(value, 'base64').toString('utf-8');
}

/**
 * Cleans title by extracting quality and codec information.
 */
function cleanTitle(title) {
    const parts = title.split(/[.\-_]/);

    const qualityTags = [
        "WEBRip", "WEB-DL", "WEB", "BluRay", "HDRip", "DVDRip", "HDTV",
        "CAM", "TS", "R5", "DVDScr", "BRRip", "BDRip", "DVD", "PDTV", "HD"
    ];

    const audioTags = [
        "AAC", "AC3", "DTS", "MP3", "FLAC", "DD5", "EAC3", "Atmos"
    ];
    const subTags = [
        "ESub", "ESubs", "Subs", "MultiSub", "NoSub", "EnglishSub", "HindiSub"
    ];

    const codecTags = [
        "x264", "x265", "H264", "HEVC", "AVC"
    ];

    const startIndex = parts.findIndex(part =>
        qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );

    const endIndex = parts.findLastIndex(part =>
        subTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        audioTags.some(tag => part.toLowerCase().includes(tag.toLowerCase())) ||
        codecTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );

    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        return parts.slice(startIndex, endIndex + 1).join(".");
    } else if (startIndex !== -1) {
        return parts.slice(startIndex).join(".");
    } else {
        return parts.slice(-3).join(".");
    }
}

// Redirector results are memoized briefly so the same techyboy4u-style link is not
// fetched repeatedly within one request (or by concurrent requests). Failures are not kept.
const REDIRECT_MEMO_TTL = 10 * 60 * 1000;
const redirectMemo = new Map(); // url -> { promise, ts }

function getRedirectLinks(url) {
    const hit = redirectMemo.get(url);
    if (hit && Date.now() - hit.ts < REDIRECT_MEMO_TTL) {
        return hit.promise;
    }
    const promise = resolveRedirectLink(url).then(result => {
        // null / unchanged URL means resolution failed; don't remember that.
        if (!result || result === url) redirectMemo.delete(url);
        return result;
    });
    redirectMemo.set(url, { promise, ts: Date.now() });
    return promise;
}

/**
 * Resolves obfuscated redirector links.
 */
async function resolveRedirectLink(url) {
    try {
        log(`[HDHub4u] Processing redirect link: ${url}`);
        const response = await makeRequest(url, { headers: HEADERS, httpsAgent: agent });
        const doc = response.data;

        // Log response details for debugging
        log(`[HDHub4u] Response status: ${response.status}`);
        log(`[HDHub4u] Response headers:`, JSON.stringify(response.headers, null, 2));
        log(`[HDHub4u] Page content length: ${doc.length}`);
        log(`[HDHub4u] Page content preview (first 500 chars):`, doc.substring(0, 500));
        log(`[HDHub4u] Page content preview (last 500 chars):`, doc.substring(Math.max(0, doc.length - 500)));

        const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
        let combinedString = '';
        let match;
        let matchCount = 0;
        while ((match = regex.exec(doc)) !== null) {
            const extractedValue = match[1] || match[2];
            if (extractedValue) {
                combinedString += extractedValue;
                matchCount++;
                log(`[HDHub4u] Found match ${matchCount}: ${extractedValue.substring(0, 50)}...`);
            }
        }

        log(`[HDHub4u] Total matches found: ${matchCount}`);
        log(`[HDHub4u] Combined string length: ${combinedString.length}`);

        if (!combinedString) {
            console.error("[HDHub4u] Could not find encoded strings in page.");

            // Check if this is an "Invalid Link" response from techyboy4u
            if (doc.trim() === "Invalid Link !!") {
                log('[HDHub4u] Techyboy4u returned "Invalid Link" - link may be expired or blocked');
                return null; // Return null to indicate complete failure
            }

            log('[HDHub4u] Searching for alternative patterns...');

            // Try alternative patterns
            const altPatterns = [
                /btoa\("([^"]+)"\)/g,
                /atob\("([^"]+)"\)/g,
                /btoa\('([^']+)'\)/g,
                /atob\('([^']+)'\)/g,
                /"([A-Za-z0-9+\/=]{20,})"/g,
                /'([A-Za-z0-9+\/=]{20,})'/g
            ];

            for (let i = 0; i < altPatterns.length; i++) {
                const altRegex = altPatterns[i];
                const altMatches = [];
                let altMatch;
                while ((altMatch = altRegex.exec(doc)) !== null) {
                    altMatches.push(altMatch[1]);
                }
                log(`[HDHub4u] Alternative pattern ${i + 1} (${altRegex}) found ${altMatches.length} matches`);
                if (altMatches.length > 0) {
                    log(`[HDHub4u] Sample matches:`, altMatches.slice(0, 3));
                }
            }

            return null; // Return null instead of original URL for failed redirects
        }

        const decodedString = atob(rot13(atob(atob(combinedString))));
        const jsonObject = JSON.parse(decodedString);

        const encodedUrl = atob(jsonObject.o || '').trim();
        if (encodedUrl) {
            return encodedUrl;
        }

        const data = btoa(jsonObject.data || '').trim();
        const wpHttp = (jsonObject.blog_url || '').trim();
        if (wpHttp && data) {
            const directLinkResponse = await makeRequest(`${wpHttp}?re=${data}`, { headers: HEADERS, httpsAgent: agent });
            const $ = cheerio.load(directLinkResponse.data);
            return $('body').text().trim();
        }

        return url;
    } catch (e) {
        // The message alone doesn't say which request failed (the initial fetch of `url`
        // or the follow-up `?re=` request), so include the actual failing request URL.
        const failedUrl = (e.config && e.config.url) || url;
        const status = e.response ? ` (HTTP ${e.response.status})` : '';
        console.error(`[HDHub4u] Error processing link ${url}:`, e.message);
        if (failedUrl !== url) {
            console.error(`[HDHub4u] Failing request was: ${failedUrl}${status}`);
        }
        return url;
    }
}

// =================================================================================
// EXTRACTORS
// =================================================================================

/**
 * Resolves an href against a base URL. Returns an absolute http(s) URL string, or null when the
 * href is empty, unparsable, or not http(s) (magnet:, javascript:, mailto: ...).
 */
function toAbsoluteHttpUrl(href, base) {
    if (!href || typeof href !== 'string') return null;
    try {
        const u = new URL(href.trim(), base);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
    } catch (e) {
        return null;
    }
}

/**
 * Main extractor dispatcher.
 */
async function loadExtractor(url, referer = MAIN_URL) {
    // Hrefs scraped from pages may be relative or protocol-relative. Resolve against the page they
    // came from (the referer) when that is absolute, else the site root; skip anything unusable
    // instead of letting `new URL()` throw and abort the whole extraction. Already-absolute URLs are
    // passed through untouched.
    const base = /^https?:\/\//i.test(referer || '') ? referer : MAIN_URL;
    const resolvedInput = toAbsoluteHttpUrl(url, base);
    if (!resolvedInput) {
        log(`[HDHub4u] Skipping unusable link: ${url}`);
        return [];
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(String(url).trim())) {
        url = resolvedInput;
    }
    const hostname = new URL(url).hostname;

    // HubCloud URLs (e.g. https://hubcloud.ist/tg/go?id=...) also contain "?id=" but are NOT
    // techyboy4u-style obfuscated redirectors. They must go to hubCloudExtractor before the
    // generic redirect check below, otherwise getRedirectLinks() finds no encoded strings,
    // returns the input URL and the link is skipped.
    if (hostname.includes('hubcloud')) {
        return hubCloudExtractor(url, referer);
    }

    // Some links from the main site are redirectors that need to be resolved first.
    if (url.includes("?id=") || hostname.includes('techyboy4u')) {
        log(`[HDHub4u] Processing redirect URL: ${url} (hostname: ${hostname})`);
        const finalLink = await getRedirectLinks(url);
        if (!finalLink) {
            log(`[HDHub4u] Failed to resolve redirect link: ${url}`);
            return [];
        }
        if (finalLink === url) {
            // getRedirectLinks returns the input URL when resolution fails. The URL still
            // contains "?id=", so recursing would re-request the same URL indefinitely.
            console.error(`[HDHub4u] Redirect could not be resolved, skipping: ${url}`);
            return [];
        }
        log(`[HDHub4u] Redirect resolved to: ${finalLink}`);
        return loadExtractor(finalLink, url);
    }

    if (hostname.includes('hubdrive')) {
        return hubDriveExtractor(url, referer);
    }
    if (hostname.includes('hubcdn')) {
        return hubCdnExtractor(url, referer);
    }
    if (hostname.includes('hblinks')) {
        return hbLinksExtractor(url, referer);
    }
    if (hostname.includes('hubstream')) {
        return hubStreamExtractor(url, referer);
    }
    if (hostname.includes('pixeldrain')) {
        return pixelDrainExtractor(url);
    }
    if (hostname.includes('streamtape')) {
        return streamTapeExtractor(url);
    }
    if (hostname.includes('hdstream4u')) {
        return [{ source: 'HdStream4u', quality: 'Unknown', url }];
    }

    // Skip unsupported hosts
    if (hostname.includes('linkrit')) {
        return [];
    }

    // Default case for unknown extractors
    const sourceName = hostname.replace(/^www\./, '');
    return [{ source: sourceName, quality: 'Unknown', url }];
}

/**
 * Extract direct download link from Pixeldrain.
 */
async function pixelDrainExtractor(link) {
    try {
        let fileId;
        const match = link.match(/(?:file|u)\/([A-Za-z0-9]+)/);
        if (match) {
            fileId = match[1];
        } else {
            fileId = link.split('/').pop();
        }
        if (!fileId) {
            return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
        }

        const infoUrl = `https://pixeldrain.com/api/file/${fileId}/info`;
        let fileInfo = { name: '', quality: 'Unknown', size: 0 };

        try {
            const { data: info } = await makeRequest(infoUrl, { httpsAgent: agent });
            if (info && info.name) {
                fileInfo.name = info.name;
                fileInfo.size = info.size || 0;

                const qualityMatch = info.name.match(/(\d{3,4})p/);
                if (qualityMatch) {
                    fileInfo.quality = qualityMatch[0];
                }
            }
        } catch (e) {
            logWarn(`[HDHub4u] Could not fetch file info for ${fileId}:`, e.message);
        }

        const directUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
        return [{
            source: 'Pixeldrain',
            quality: fileInfo.quality,
            url: directUrl,
            name: fileInfo.name,
            size: fileInfo.size,
        }];
    } catch (e) {
        console.error('[HDHub4u] Pixeldrain extraction failed', e.message);
        return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
    }
}

/**
 * Extract streamable URL from StreamTape.
 */
async function streamTapeExtractor(link) {
    const url = new URL(link);
    url.hostname = 'streamtape.com';
    const normalizedLink = url.toString();

    try {
        const res = await makeRequest(normalizedLink, { headers: HEADERS, httpsAgent: agent });

        const match = res.data.match(/document\.getElementById\('videolink'\)\.innerHTML = (.*?);/);

        if (match && match[1]) {
            const scriptContent = match[1];
            const urlPartMatch = scriptContent.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);

            if (urlPartMatch && urlPartMatch[1]) {
                const videoSrc = 'https:' + urlPartMatch[1];
                return [{ source: 'StreamTape', quality: 'Stream', url: videoSrc }];
            }
        }

        const simpleMatch = res.data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);
        if (simpleMatch && simpleMatch[0]) {
            const videoSrc = 'https:' + simpleMatch[0].slice(1, -1);
            return [{ source: 'StreamTape', quality: 'Stream', url: videoSrc }];
        }

        return [];
    } catch (e) {
        if (!e.response || e.response.status !== 404) {
            console.error(`[HDHub4u] StreamTape error for ${normalizedLink}:`, e.message);
        }
        return [];
    }
}

async function hubStreamExtractor(url, referer) {
    try {
        const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
        return [{ source: 'Hubstream', quality: 'Unknown', url }];
    } catch (e) {
        console.error(`[HDHub4u] Hubstream failed to extract from ${url}:`, e.message);
        return [];
    }
}

async function hbLinksExtractor(url, referer) {
    const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    const $ = cheerio.load(response.data);
    const links = $('h3 a, div.entry-content p a').map((i, el) => $(el).attr('href')).get();

    const finalLinks = [];
    for (const link of links) {
        const extracted = await loadExtractor(link, url);
        finalLinks.push(...extracted);
    }
    return finalLinks;
}

async function hubCdnExtractor(url, referer) {
    const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    const encodedMatch = response.data.match(/r=([A-Za-z0-9+/=]+)/);
    if (encodedMatch && encodedMatch[1]) {
        const m3u8Data = atob(encodedMatch[1]);
        const m3u8Link = m3u8Data.substring(m3u8Data.lastIndexOf('link=') + 5);
        return [{
            source: 'HubCdn',
            quality: 'M3U8',
            url: m3u8Link,
        }];
    }
    return [];
}

async function hubDriveExtractor(url, referer) {
    const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    const $ = cheerio.load(response.data);
    const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
    if (href) {
        return loadExtractor(href, url);
    }
    return [];
}

/**
 * Converts a PixelDrain page link (/u/<id>, /file/<id>) to the direct API download URL.
 * Only rewrites when a file id is literally present in the URL; no network call, nothing invented.
 */
function toPixeldrainDownloadUrl(link) {
    try {
        const u = new URL(link);
        if (!u.hostname.includes('pixeldra')) return link;
        if (u.pathname.startsWith('/api/file/')) return link;
        const m = u.pathname.match(/^\/(?:u|file)\/([A-Za-z0-9_-]+)/);
        if (!m) return link; // e.g. /l/<list> - not a single file, leave untouched
        return `${u.origin}/api/file/${m[1]}?download`;
    } catch (e) {
        return link;
    }
}

/**
 * Finds PixelDrain file URLs that appear as string literals inside inline <script> blocks
 * (e.g. var x = "https://pixeldrain.dev/u/<id>"). Only URLs literally present in the page are
 * returned; nothing is constructed from guesses.
 */
function findPixeldrainUrlsInScripts(html) {
    const found = [];
    if (typeof html !== 'string') return found;
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    const urlRe = /https?:\/\/(?:[a-z0-9-]+\.)*pixeldrain\.[a-z]+\/(?:api\/file|u|file)\/[A-Za-z0-9_-]+/gi;
    let s;
    while ((s = scriptRe.exec(html)) !== null) {
        const code = s[1].replace(/\\\//g, '/'); // un-escape JSON-style "https:\/\/..."
        let m;
        while ((m = urlRe.exec(code)) !== null) {
            if (!found.includes(m[0])) found.push(m[0]);
        }
    }
    return found;
}

function pixeldrainFileId(link) {
    const m = (link || '').match(/\/(?:api\/file|u|file)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}

async function hubCloudExtractor(url, referer) {
    let currentUrl = url;
    if (currentUrl.includes("hubcloud.ink")) {
        currentUrl = currentUrl.replace("hubcloud.ink", "hubcloud.dad");
    }

    let pageResponse;
    let finalUrl = currentUrl;
    try {
        pageResponse = await makeRequest(currentUrl, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });

        // Two-step pages: the first page only holds `var url = '<real page>'` in a script.
        // Follow it once (no loops). Pages that already contain the download buttons are used as-is.
        if (!currentUrl.includes("hubcloud.php") && typeof pageResponse.data === 'string') {
            const scriptUrlMatch = pageResponse.data.match(/var\s+url\s*=\s*(['"])([^'"]+)\1/);
            if (scriptUrlMatch && scriptUrlMatch[2]) {
                finalUrl = new URL(scriptUrlMatch[2], currentUrl).toString();
                pageResponse = await makeRequest(finalUrl, { headers: { ...HEADERS, Referer: currentUrl }, httpsAgent: agent });
            }
        }
    } catch (e) {
        const status = e.response ? ` (HTTP ${e.response.status})` : '';
        console.error(`[HDHub4u] HubCloud page request failed for ${(e.config && e.config.url) || finalUrl}${status}: ${e.message}`);
        return [];
    }

    const $ = cheerio.load(pageResponse.data);
    const size = $('i#size').text().trim();
    const header = $('div.card-header').text().trim();

    const getIndexQuality = (str) => {
        const match = (str || '').match(/(\d{3,4})[pP]/);
        return match ? parseInt(match[1]) : 2160;
    };

    const quality = getIndexQuality(header);
    const headerDetails = cleanTitle(header);

    const labelExtras = (() => {
        let extras = '';
        if (headerDetails) extras += `[${headerDetails}]`;
        if (size) extras += `[${size}]`;
        return extras;
    })();

    const sizeInBytes = (() => {
        if (!size) return 0;
        const sizeMatch = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
        if (!sizeMatch) return 0;

        const value = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();

        if (unit === 'GB') return value * 1024 * 1024 * 1024;
        if (unit === 'MB') return value * 1024 * 1024;
        if (unit === 'KB') return value * 1024;
        return 0;
    })();

    const links = [];
    const elements = $('div.card-body h2 a.btn').get();

    // FSL links can reject requests without a Referer/User-Agent, so carry the headers used to
    // reach them. Consumers that ignore `headers` behave exactly as before.
    const fslHeaders = { 'User-Agent': HEADERS['User-Agent'], Referer: finalUrl };

    for (const element of elements) {
        const rawLink = $(element).attr('href');
        const text = $(element).text();
        if (!rawLink) continue;

        // Normalize to an absolute URL right away (relative hrefs resolve against the page they came from).
        // Everything below - host checks, extractors, returned stream URLs - uses this value.
        let link;
        try {
            link = new URL(rawLink, finalUrl).toString();
        } catch (error) {
            continue;
        }
        const linkHost = new URL(link).hostname;

        if (linkHost.includes("pixeldra")) {
            links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: toPixeldrainDownloadUrl(link), size: sizeInBytes });
        } else if (text.includes("Download File")) {
            links.push({ source: `HubCloud ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("FSL Server")) {
            links.push({ source: `HubCloud - FSL Server ${labelExtras}`, quality, url: link, size: sizeInBytes, headers: fslHeaders });
        } else if (text.includes("S3 Server")) {
            links.push({ source: `HubCloud - S3 Server ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (text.includes("BuzzServer")) {
            try {
                const buzzResp = await makeRequest(`${link.replace(/\/+$/, '')}/download`, {
                    headers: { ...HEADERS, Referer: link },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    httpsAgent: agent,
                });
                const dlink = buzzResp.headers['hx-redirect'];
                const buzzUrl = toAbsoluteHttpUrl(dlink, link);
                if (buzzUrl) {
                    links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: buzzUrl, size: sizeInBytes });
                }
            } catch (e) {
                if (e.response && e.response.headers['hx-redirect']) {
                    const buzzUrl = toAbsoluteHttpUrl(e.response.headers['hx-redirect'], link);
                    if (buzzUrl) {
                        links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: buzzUrl, size: sizeInBytes });
                    }
                } else {
                    console.error("[HDHub4u] BuzzServer redirect not found for", link);
                }
            }
        } else if (text.includes("10Gbps")) {
            let currentRedirectUrl = link;
            let finalLink = null;
            for (let i = 0; i < 5; i++) {
                try {
                    const response = await makeRequest(currentRedirectUrl, { maxRedirects: 0, validateStatus: null, httpsAgent: agent });
                    const location = response.headers.location;
                    if (location) {
                        if (location.includes("link=")) {
                            finalLink = location.substring(location.indexOf("link=") + 5);
                            break;
                        }
                        const nextUrl = toAbsoluteHttpUrl(location, currentRedirectUrl);
                        if (!nextUrl) break;
                        currentRedirectUrl = nextUrl;
                    } else {
                        break;
                    }
                } catch (e) {
                    if (e.response && e.response.headers.location) {
                        const location = e.response.headers.location;
                        if (location.includes("link=")) {
                            finalLink = location.substring(location.indexOf("link=") + 5);
                            break;
                        }
                        const nextUrl = toAbsoluteHttpUrl(location, currentRedirectUrl);
                        if (!nextUrl) break;
                        currentRedirectUrl = nextUrl;
                    } else {
                        console.error("[HDHub4u] 10Gbps redirect failed for", currentRedirectUrl);
                        break;
                    }
                }
            }
            if (finalLink) {
                links.push({ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: finalLink, size: sizeInBytes });
            }
        } else {
            const extracted = await loadExtractor(link, finalUrl);
            links.push(...extracted);
        }
    }

    // PixelDrain URLs assigned in inline JavaScript rather than present as buttons.
    // Only URLs literally present in the page are added, and only if not already found above.
    const knownPixeldrainIds = new Set(
        links.filter(l => l.url && l.url.includes('pixeldra')).map(l => pixeldrainFileId(l.url)).filter(Boolean)
    );
    for (const scriptUrl of findPixeldrainUrlsInScripts(pageResponse.data)) {
        const id = pixeldrainFileId(scriptUrl);
        if (!id || knownPixeldrainIds.has(id)) continue;
        knownPixeldrainIds.add(id);
        links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: toPixeldrainDownloadUrl(scriptUrl), size: sizeInBytes });
    }

    if (links.length === 0) {
        log(`[HDHub4u] HubCloud page ${finalUrl} had no recognised download buttons or PixelDrain URLs`);
    }
    return links;
}

// =================================================================================
// MAIN PROVIDER LOGIC
// =================================================================================

/**
 * Searches for media on HDHub4u.
 */
async function search(query) {
    await fetchAndUpdateDomain();
    // Use /?s= (WordPress search) which returns static HTML
    // The /search.html?q= uses a JavaScript-based Typesense API which is blocked by Cloudflare for server requests
    const searchUrl = `${MAIN_URL}/?s=${encodeURIComponent(query)}`;
    log(`[HDHub4u] Searching with URL: ${searchUrl}`);
    const response = await makeRequest(searchUrl, { headers: HEADERS, httpsAgent: agent });
    log(`[HDHub4u] Search response status: ${response.status}`);
    const $ = cheerio.load(response.data);

    // Try multiple selectors for search results
    let results = [];

    // Selector 1: WordPress figcaption layout (primary structure from curl investigation)
    // Structure: <figure><img></figure><figcaption><a href><p>Title</p></a></figcaption>
    $('figcaption').each((i, el) => {
        const element = $(el);
        const linkEl = element.find('a').first();
        const url = linkEl.attr('href');
        const title = linkEl.find('p').text().trim() || linkEl.text().trim();
        // Get poster from sibling figure element
        const poster = element.prev('figure').find('img').attr('src') || element.parent().find('figure img').attr('src');

        if (title && url && url.length > 10) {
            try {
                const absoluteUrl = new URL(url, MAIN_URL).toString();
                results.push({ title, url: absoluteUrl, poster });
            } catch (error) {
                console.error('[HDHub4u] Invalid search result URL:', url, error.message);
            }
        }
    });

    // Selector 2: thumbnail-wrapper layout (some WordPress themes)
    if (results.length === 0) {
        $('.thumbnail-wrapper, .thumb-wrapper, li.thumb').each((i, el) => {
            const element = $(el);
            const linkEl = element.find('figcaption a, a').first();
            const url = linkEl.attr('href');
            const title = linkEl.find('p').text().trim() || linkEl.text().trim();
            const poster = element.find('figure img, img').first().attr('src');

            if (title && url && url.length > 10) {
                const absoluteUrl = url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}`;
                results.push({ title, url: absoluteUrl, poster });
            }
        });
    }

    // Selector 3: HDHub4u movie-grid layout (for /search.html page if it somehow works)
    if (results.length === 0) {
        $('ul.movie-grid li.movie-card, ul#results-grid li.movie-card').each((i, el) => {
            const element = $(el);
            const linkEl = element.find('> a').first();
            const url = linkEl.attr('href');
            const title = linkEl.find('h3.movie-title').text().trim() || linkEl.find('h3').text().trim();
            const poster = linkEl.find('img').attr('src') || linkEl.find('img').attr('data-src');

            if (title && url) {
                const absoluteUrl = url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}`;
                results.push({ title, url: absoluteUrl, poster });
            }
        });
    }

    // Selector 4: Standard article-based layout
    if (results.length === 0) {
        $('article, .post, .result-item, .search-result').each((i, el) => {
            const element = $(el);
            const titleEl = element.find('h3 a, h2 a, .entry-title a, a.title').first();
            const title = titleEl.text().trim() || element.find('h3, h2, .entry-title').first().text().trim();
            const url = titleEl.attr('href') || element.find('a').first().attr('href');
            const poster = element.find('img').first().attr('src') || element.find('img').first().attr('data-src');

            if (title && url) {
                const absoluteUrl = url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}`;
                results.push({ title, url: absoluteUrl, poster });
            }
        });
    }


    // Deduplicate by URL
    const seenUrls = new Set();
    results = results.filter(r => {
        if (!r.url || seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
    });

    log(`[HDHub4u] Parsed ${results.length} search results`);
    if (results.length > 0) {
        log(`[HDHub4u] First result: ${results[0].title} - ${results[0].url}`);
    }

    return results;
}

/**
 * Fetches the media page and extracts all hoster links.
 */
async function getDownloadLinks(mediaUrl) {
    await fetchAndUpdateDomain();
    HEADERS.Referer = `${MAIN_URL}/`;
    log(`[HDHub4u] Fetching download links from: ${mediaUrl}`);
    const response = await makeRequest(mediaUrl, { headers: HEADERS, httpsAgent: agent });
    log(`[HDHub4u] Download page response status: ${response.status}`);
    const $ = cheerio.load(response.data);

    const typeRaw = $('h1.page-title span').text();
    const isMovie = typeRaw.toLowerCase().includes('movie');

    const title = $('.page-body h2[data-ved="2ahUKEwjL0NrBk4vnAhWlH7cAHRCeAlwQ3B0oATAfegQIFBAM"], h2[data-ved="2ahUKEwiP0pGdlermAhUFYVAKHV8tAmgQ3B0oATAZegQIDhAM"]').text();
    const seasonMatch = title.match(/\bSeason\s*(\d+)\b/i);
    const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : null;

    let initialLinks = [];

    if (isMovie) {
        const qualityLinks = $('h3 a, h4 a').filter((i, el) => {
            const linkText = $(el).text();
            return linkText.match(/480|720|1080|2160|4K/i);
        });

        initialLinks = qualityLinks.map((i, el) => ({ url: $(el).attr('href') })).get();

        const seen = new Set();
        initialLinks = initialLinks.filter(link => {
            if (!link.url || seen.has(link.url)) {
                return false;
            }
            seen.add(link.url);
            return true;
        });

    } else { // TV Series
        const episodeLinksMap = new Map();

        $('h3 a, h4 a').each((i, element) => {
            const $el = $(element);
            const text = $el.text();
            const href = $el.attr('href');

            if (text.match(/1080|720|4K|2160/i) && href) {
                if (href.includes('techyboy4u.com')) {
                    log(`[HDHub4u] Found techyboy4u quality redirect link: ${href} (text: ${text})`);
                    initialLinks.push({ url: href, isQualityRedirect: true, priority: 1 });
                } else {
                    log(`[HDHub4u] Found alternative quality link: ${href} (text: ${text})`);
                    initialLinks.push({ url: href, isQualityRedirect: false, priority: 2 });
                }
            }
        });

        $('h4').each((i, element) => {
            const $el = $(element);
            const text = $el.text();
            const episodeMatch = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);

            if (episodeMatch) {
                const epNum = parseInt(episodeMatch[1] || episodeMatch[2]);
                if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);

                const links = $el.find('a').map((i, a) => $(a).attr('href')).get();
                episodeLinksMap.get(epNum).push(...links);
            }
        });

        if (episodeLinksMap.size === 0) {
            for (const element of $('h3, h4').get()) {
                const $el = $(element);
                const title = $el.text();
                const episodeMatch = title.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
                const epNum = episodeMatch ? parseInt(episodeMatch[1] || episodeMatch[2]) : null;

                const isDirectLinkBlock = $el.find('a').text().match(/1080|720|4K|2160/i);

                if (isDirectLinkBlock) {
                    const redirectLinks = $el.find('a').map((i, a) => $(a).attr('href')).get();
                    for (const rawRedirectLink of redirectLinks) {
                        const redirectLink = toAbsoluteHttpUrl(rawRedirectLink, mediaUrl);
                        if (!redirectLink) continue;
                        try {
                            const resolvedUrl = await getRedirectLinks(redirectLink);
                            if (!resolvedUrl || resolvedUrl === redirectLink) continue; // unresolved: don't re-fetch the same URL
                            const episodeDocPage = await makeRequest(resolvedUrl, { headers: HEADERS, httpsAgent: agent });
                            const $$ = cheerio.load(episodeDocPage.data);
                            $$('h5 a').each((i, linkEl) => {
                                const linkText = $$(linkEl).text();
                                const linkHref = $$(linkEl).attr('href');
                                const innerEpMatch = linkText.match(/Episode\s*(\d+)/i);
                                if (innerEpMatch && linkHref) {
                                    const innerEpNum = parseInt(innerEpMatch[1]);
                                    if (!episodeLinksMap.has(innerEpNum)) episodeLinksMap.set(innerEpNum, []);
                                    episodeLinksMap.get(innerEpNum).push(linkHref);
                                }
                            });
                        } catch (e) {
                            console.error(`[HDHub4u] Error resolving direct link block: ${redirectLink}`, e.message);
                        }
                    }

                } else if (epNum) {
                    if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);

                    const baseLinks = $el.find('a').map((i, a) => $(a).attr('href')).get();
                    episodeLinksMap.get(epNum).push(...baseLinks);

                    let nextElement = $el.next();
                    while (nextElement.length && nextElement.get(0).tagName !== 'hr' && nextElement.get(0).tagName !== 'h3' && nextElement.get(0).tagName !== 'h4') {
                        const siblingLinks = nextElement.find('a').map((i, a) => $(a).attr('href')).get();
                        episodeLinksMap.get(epNum).push(...siblingLinks);
                        nextElement = nextElement.next();
                    }
                }
            }
        }

        episodeLinksMap.forEach((links, epNum) => {
            const uniqueLinks = [...new Set(links)];
            initialLinks.push(...uniqueLinks.map(link => ({ url: link, episode: epNum })));
        });
    }

    // Resolve scraped hrefs against the media page and drop unusable ones (relative, protocol-relative,
    // magnet:, javascript: ...) so no later request or `new URL()` call receives a bare relative path.
    initialLinks = initialLinks
        .map(l => ({ ...l, url: toAbsoluteHttpUrl(l.url, mediaUrl) }))
        .filter(l => l.url);

    log(`[HDHub4u] Found ${initialLinks.length} initial hoster links. Now extracting...`);

    const allFinalLinks = [];
    const promises = initialLinks.map(async (linkInfo) => {
        try {
            if (linkInfo.isQualityRedirect) {
                const resolvedUrl = await getRedirectLinks(linkInfo.url);
                if (!resolvedUrl || resolvedUrl === linkInfo.url) return []; // unresolved: don't re-fetch the same URL
                const episodeDocPage = await makeRequest(resolvedUrl, { headers: HEADERS, httpsAgent: agent });
                const $$ = cheerio.load(episodeDocPage.data);

                const episodeLinks = [];
                $$('h5 a').each((i, linkEl) => {
                    const linkText = $$(linkEl).text();
                    const linkHref = $$(linkEl).attr('href');
                    const episodeMatch = linkText.match(/Episode\s*(\d+)/i);
                    if (episodeMatch && linkHref) {
                        const epNum = parseInt(episodeMatch[1]);
                        episodeLinks.push({ url: linkHref, episode: epNum });
                    }
                });

                $$('h3 a').each((i, linkEl) => {
                    const linkHref = $$(linkEl).attr('href');
                    const linkText = $$(linkEl).text();
                    if (linkHref && !linkHref.includes('magnet:') && !linkHref.includes('.zip') && !linkText.toLowerCase().includes('pack')) {
                        episodeLinks.push({ url: linkHref, episode: null });
                    }
                });

                const episodePromises = episodeLinks.map(async (epLink) => {
                    try {
                        const extractedLinks = await loadExtractor(epLink.url, resolvedUrl);
                        return extractedLinks.map(finalLink => ({ ...finalLink, episode: epLink.episode }));
                    } catch (e) {
                        console.error(`[HDHub4u] Failed to extract episode link ${epLink.url}:`, e.message);
                        return [];
                    }
                });

                const episodeResults = await Promise.all(episodePromises);
                return episodeResults.flat();
            } else {
                const extractedLinks = await loadExtractor(linkInfo.url, mediaUrl);
                return extractedLinks.map(finalLink => ({ ...finalLink, episode: linkInfo.episode }));
            }
        } catch (e) {
            console.error(`[HDHub4u] Failed to extract from ${linkInfo.url}:`, e.message);
            return [];
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => allFinalLinks.push(...res));

    const seenUrls = new Set();
    const uniqueFinalLinks = allFinalLinks.filter(link => {
        if (link.url && (link.url.includes('.zip') || (link.name && link.name.toLowerCase().includes('.zip')))) {
            return false;
        }
        if (seenUrls.has(link.url)) {
            return false;
        }
        seenUrls.add(link.url);
        return true;
    });

    return { finalLinks: uniqueFinalLinks, isMovie };
}

// Helper function to convert quality string to numeric value for sorting
function parseQualityForSort(qualityString) {
    if (!qualityString) return 0;
    // Handle both string and number inputs
    if (typeof qualityString === 'number') return qualityString;
    if (typeof qualityString !== 'string') return 0;
    const match = qualityString.match(/(\d{3,4})/);
    return match ? parseInt(match[1], 10) : 0;
}

// Helper function to format file size
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// --- Title matching helpers ---

function normalizeForMatch(s) {
    return (s || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/^(?:the|a|an)\s+/, '')
        .trim();
}

/**
 * HDHub4u titles look like "Name (2024) Hindi WEB-DL 480p ...". Returns just the name part:
 * the text before the first "(", "[", year, season/quality/language tag. A match at index 0
 * is ignored so titles that start with a year (e.g. "1917", "2012") still work.
 */
function extractNamePart(resultTitle) {
    const s = (resultTitle || '').replace(/^\s*download\s+/i, '');
    const cut = /[(\[]|\b(?:19|20)\d{2}\b|\bseason\b|\bs\d{1,2}\b|\bcomplete\b|\b(?:480|720|1080|2160)p\b|\b(?:web-?dl|webrip|hdrip|bluray|hdtv|hindi|dual|multi)\b/gi;
    let m;
    while ((m = cut.exec(s)) !== null) {
        if (m.index > 0) return s.slice(0, m.index);
        if (m[0].length === 0) cut.lastIndex++;
    }
    return s;
}

/**
 * Decides whether a search result is reliably the requested title.
 * - name must equal the wanted title, or be very similar (>= 0.85)
 * - movies with a known year: any year in the result title must be within +/-1 of it;
 *   a result with no year at all is accepted only on an exact name match
 */
function scoreTitleMatch(resultTitle, wantedTitle, wantedYear, mediaType) {
    const name = normalizeForMatch(extractNamePart(resultTitle));
    const want = normalizeForMatch(wantedTitle);
    if (!name || !want) return { ok: false, score: 0 };

    const exact = name === want;
    const similarity = exact ? 1 : compareTwoStrings(name, want);
    if (similarity < 0.85) return { ok: false, score: similarity };

    let yearBonus = 0;
    if (mediaType === 'movie' && wantedYear) {
        const years = ((resultTitle || '').match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
        if (years.length > 0) {
            if (!years.some(y => Math.abs(y - wantedYear) <= 1)) return { ok: false, score: similarity };
            yearBonus = 0.2;
        } else if (!exact) {
            return { ok: false, score: similarity };
        }
    }
    return { ok: true, score: similarity + yearBonus };
}

// --- Stream validation helpers ---

const HEAD_TIMEOUT_MS = 3000;       // per-request timeout
const VALIDATION_BUDGET_MS = 3500;  // hard cap per probe; the request is aborted after this

/**
 * Lightweight HEAD probe. Never throws. Returns { state, status?, headers?, reason? } where state is:
 *  - 'ok'           the host answered 2xx
 *  - 'broken'       clearly dead: 404/410, unresolvable host, or not a usable http(s) URL
 *  - 'inconclusive' anything else (403/405/429/5xx, timeouts, resets...). This does NOT mean the link is
 *                   bad - many hosts reject HEAD but serve GET/range requests fine.
 * Uses the link's own required headers (e.g. FSL Referer) so the probe isn't a false negative.
 */
async function probeStream(stream) {
    let parsed;
    try {
        parsed = new URL(stream.url);
    } catch (e) {
        return { state: 'broken', reason: 'invalid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { state: 'broken', reason: `unsupported protocol ${parsed.protocol}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATION_BUDGET_MS);
    try {
        const response = await axios.head(stream.url, {
            timeout: HEAD_TIMEOUT_MS,
            maxRedirects: 3,
            httpsAgent: agent,
            signal: controller.signal,
            validateStatus: () => true, // inspect the status ourselves instead of throwing
            headers: {
                'User-Agent': HEADERS['User-Agent'],
                ...(stream.headers || {})
            }
        });
        const status = response.status;
        if (status >= 200 && status < 300) return { state: 'ok', status, headers: response.headers || {} };
        if (status === 404 || status === 410) return { state: 'broken', status, reason: 'not found' };
        return { state: 'inconclusive', status };
    } catch (error) {
        if (error && error.code === 'ENOTFOUND') return { state: 'broken', reason: 'host not found' };
        return { state: 'inconclusive', reason: (error && error.message) || 'request failed' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Picks the stream to keep from probe results aligned with the group's (already preference-sorted)
 * streams: the first verified ('ok') one, else the first inconclusive one, else none.
 */
function chooseStream(probes) {
    const verified = probes.findIndex(p => p.state === 'ok');
    if (verified !== -1) return { index: verified, verified: true };
    const unverified = probes.findIndex(p => p.state === 'inconclusive');
    if (unverified !== -1) return { index: unverified, verified: false };
    return null;
}

/**
 * Main function to get streams for TMDB content
 */
async function getHDHub4uStreams(tmdbId, mediaType, title, year = null, seasonNum = null, episodeNum = null) {
    try {
        log(`[HDHub4u] ===== STARTING STREAM FETCH =====`);
        log(`[HDHub4u] Fetching streams for "${title}" (${year}) - TMDB ${mediaType}/${tmdbId}${seasonNum ? `, S${seasonNum}E${episodeNum}` : ''}`);
        log(`[HDHub4u] TMDB ID: ${tmdbId}`);
        log(`[HDHub4u] Current domain: ${MAIN_URL}`);

        // Update domain before starting
        await fetchAndUpdateDomain();

        // Define cache key
        const cacheKey = `hdhub4u_final_v2_${mediaType}_${tmdbId}${seasonNum ? `_s${seasonNum}` : ''}${episodeNum ? `_e${episodeNum}` : ''}`;
        log(`[HDHub4u] Cache key: ${cacheKey}`);

        // Try to get from cache first
        const cachedData = await getFromCache(cacheKey);
        if (cachedData && cachedData.length > 0) {
            log(`[HDHub4u] Returning ${cachedData.length} cached streams`);
            return cachedData;
        } else if (cachedData && cachedData.length === 0) {
            log(`[HDHub4u] Cache contains empty data for ${cacheKey}. Refetching from source.`);
        }

        // Use the title parameter passed from addon.js (no need for redundant TMDB call)
        if (!title) {
            log(`[HDHub4u] No title provided for ${mediaType}/${tmdbId}`);
            return [];
        }

        // Search strategy: search for just the title first (more results), then filter by season
        // This works better than searching with "season X" appended
        let searchQuery = title;
        log(`[HDHub4u] Searching for: "${searchQuery}"`);

        // Search for content
        let searchResults = await search(searchQuery);
        log(`[HDHub4u] Search returned ${searchResults.length} results for query: ${searchQuery}`);

        // If no results, try with year appended
        if (searchResults.length === 0 && year) {
            searchQuery = `${title} ${year}`;
            log(`[HDHub4u] Retrying search with year: "${searchQuery}"`);
            searchResults = await search(searchQuery);
            log(`[HDHub4u] Retry search returned ${searchResults.length} results`);
        }

        if (searchResults.length === 0) {
            log(`[HDHub4u] No search results found for "${title}"`);
            await saveToCache(cacheKey, []);
            return [];
        }

        // Log first few search results
        searchResults.slice(0, 5).forEach((result, index) => {
            log(`[HDHub4u] Search result ${index + 1}: ${result.title} - ${result.url}`);
        });

        // Find best match. A result is only eligible if its title (and, for movies, year)
        // reliably matches what was requested. There is no "fall back to the first result":
        // playing the wrong video is worse than returning no HDHub4u streams.
        const parsedYear = year ? parseInt(year, 10) : null;
        const eligible = searchResults
            .map((r, index) => ({ r, index, ...scoreTitleMatch(r.title, title, parsedYear, mediaType) }))
            .filter(x => x.ok);

        if (eligible.length === 0) {
            log(`[HDHub4u] No reliable title/year match among ${searchResults.length} results for "${title}" (${year || 'no year'}); not guessing`);
            await saveToCache(cacheKey, []);
            return [];
        }

        let bestMatch = null;
        if (mediaType === 'tv' && seasonNum) {
            // Prefer a result that names the requested season
            const seasonPattern = new RegExp(`season\\s*${seasonNum}\\b|\\bs0?${seasonNum}\\b`, 'i');
            const seasonMatches = eligible.filter(x => seasonPattern.test(x.r.title));
            if (seasonMatches.length > 0) {
                log(`[HDHub4u] Found ${seasonMatches.length} title-matching results for Season ${seasonNum}`);
                bestMatch = seasonMatches[0].r;
            } else {
                log(`[HDHub4u] No season-specific result; using best title match`);
            }
        }
        if (!bestMatch) {
            // Highest score wins; ties keep the site's own result order
            bestMatch = eligible.reduce((best, x) => (x.score > best.score ? x : best), eligible[0]).r;
        }

        log(`[HDHub4u] ===== SELECTED MEDIA =====`);
        log(`[HDHub4u] Selected: "${bestMatch.title}" - ${bestMatch.url}`);
        log(`[HDHub4u] ===== EXTRACTING DOWNLOAD LINKS =====`);

        // Get download links
        const { finalLinks, isMovie } = await getDownloadLinks(bestMatch.url);

        if (finalLinks.length === 0) {
            log(`[HDHub4u] No download links found`);
            await saveToCache(cacheKey, []);
            return [];
        }

        // Filter links for specific episode if needed
        let filteredLinks = finalLinks;
        if (!isMovie && episodeNum) {
            filteredLinks = finalLinks.filter(link => link.episode === episodeNum);
        }

        // Convert to Stremio stream format and filter out unknown quality streams
        const streams = filteredLinks
            .map(link => {
                const quality = parseQualityForSort(link.quality) || 0;
                const sizeText = link.size ? formatBytes(link.size) : '';

                return {
                    quality: quality,
                    sizeText: sizeText,
                    link: link
                };
            })
            .filter(item => item.quality > 0) // Exclude streams with unknown/invalid quality
            .map(item => {
                const { quality, sizeText, link } = item;

                // Create abbreviated source names
                const sourceAbbrev = link.source.includes('Pixeldrain') ? 'PD' :
                    link.source.includes('HubCloud') ? 'HC' :
                        link.source.substring(0, 2).toUpperCase();

                // Simple title without verbose source information
                let title = `${quality}p`;
                if (link.episode) title += ` - Episode ${link.episode}`;

                return {
                    name: `HDHub4u-${quality}p | ${sourceAbbrev}`,
                    title: title,
                    url: link.url,
                    quality: quality.toString(),
                    provider: 'HDHub4u',
                    source: link.source,
                    size: sizeText,
                    episode: link.episode || null,
                    originalTitle: title, // Store original title for fallback
                    // Request headers a link needs (currently FSL only); absent for all other links
                    ...(link.headers ? { headers: link.headers } : {})
                };
            });

        // Group streams by source and quality, then validate and select best link
        const streamGroups = new Map();

        // Group streams by quality + source type to allow both HubCloud and Pixeldrain
        for (const stream of streams) {
            const sourceType = stream.source.includes('HubCloud') ? 'HubCloud' :
                stream.source.includes('Pixeldrain') ? 'Pixeldrain' : 'Other';
            const groupKey = `${stream.quality}_${sourceType}`;
            if (!streamGroups.has(groupKey)) {
                streamGroups.set(groupKey, []);
            }
            streamGroups.get(groupKey).push(stream);
        }

        // Sort streams within each group by preference (10Gbps > regular, larger size > smaller)
        for (const [groupKey, groupStreams] of streamGroups) {
            groupStreams.sort((a, b) => {
                // Prefer 10Gbps variants
                const aIs10Gbps = a.source.includes('10Gbps');
                const bIs10Gbps = b.source.includes('10Gbps');
                if (aIs10Gbps !== bIs10Gbps) return bIs10Gbps ? 1 : -1;

                // Then prefer larger file sizes
                const aSize = parseFloat(a.size?.replace(/[^0-9.]/g, '') || '0');
                const bSize = parseFloat(b.size?.replace(/[^0-9.]/g, '') || '0');
                return bSize - aSize;
            });
        }

        // Helper function to extract filename from headers or URL
        const extractFilename = (headers, url) => {
            // First try Content-Disposition header
            const contentDisposition = headers['content-disposition'];
            if (contentDisposition) {
                // Try multiple patterns for Content-Disposition
                const patterns = [
                    /filename[^;=\n]*=(['"]?)([^'"\n]*?)\1/i,
                    /filename\*=UTF-8''([^;\n]*)/i,
                    /filename=([^;\n]*)/i
                ];

                for (const pattern of patterns) {
                    const match = contentDisposition.match(pattern);
                    if (match && match[2]) {
                        try {
                            return decodeURIComponent(match[2].trim());
                        } catch (e) {
                            return match[2].trim();
                        }
                    } else if (match && match[1]) {
                        try {
                            return decodeURIComponent(match[1].trim());
                        } catch (e) {
                            return match[1].trim();
                        }
                    }
                }
            }

            // Fallback to URL path extraction
            try {
                const urlPath = new URL(url).pathname;
                const pathSegments = urlPath.split('/');
                const lastSegment = pathSegments[pathSegments.length - 1];

                // Check if it looks like a filename (has extension)
                if (lastSegment && lastSegment.includes('.') && lastSegment.length > 3) {
                    return decodeURIComponent(lastSegment);
                }

                // Try to find any segment that looks like a filename
                for (let i = pathSegments.length - 1; i >= 0; i--) {
                    const segment = pathSegments[i];
                    if (segment && segment.includes('.') && segment.length > 3) {
                        return decodeURIComponent(segment);
                    }
                }
            } catch (error) {
                // URL parsing failed, continue
            }

            return null;
        };

        // Helper function to clean and format filename for display
        const formatFilenameTitle = (filename, originalTitle, size) => {
            if (!filename) return originalTitle;

            // Extract movie/show name and year from original title, removing quality prefix
            const cleanTitle = originalTitle.replace(/^\d+p\s*-?\s*/, ''); // Remove quality prefix like "1080p - "
            const titleMatch = cleanTitle.match(/^(.+?)\s+\((\d{4})\)/);
            if (titleMatch) {
                const [, movieName, year] = titleMatch;
                // Return in the format: "MovieName (Year) - FullFilename"
                return `${movieName} (${year}) - ${filename}`;
            }

            // Fallback: return filename with clean title (remove leading dash if present)
            const cleanedTitle = cleanTitle.replace(/^\s*-\s*/, ''); // Remove leading dash and spaces
            return cleanedTitle ? `${cleanedTitle} - ${filename}` : filename;
        };

        // Validate links in parallel for each group.
        // A HEAD probe is only a hint: many hosts answer HEAD with 403/405/501 (or time out) for links that
        // play fine. Only a clearly dead link (404/410, unresolvable host, not a usable http(s) URL) is
        // dropped; inconclusive links stay as candidates but rank below links that were verified.
        const validationPromises = Array.from(streamGroups.entries()).map(async ([groupKey, groupStreams]) => {
            log(`[HDHub4u] Validating ${groupStreams.length} links for ${groupKey}...`);

            // All probes in the group run concurrently and are individually time-bounded (see probeStream)
            const probes = await Promise.all(groupStreams.map(stream => probeStream(stream)));
            probes.forEach((probe, index) => {
                log(`[HDHub4u] Link ${index + 1} for ${groupKey}: ${probe.state}${probe.status ? ` (HTTP ${probe.status})` : ''}${probe.reason ? ` - ${probe.reason}` : ''}`);
            });

            const choice = chooseStream(probes);
            if (!choice) {
                log(`[HDHub4u] All ${groupStreams.length} links for ${groupKey} look dead; dropping the group`);
                return null;
            }

            const selectedStream = { ...groupStreams[choice.index] };
            if (choice.verified) {
                // Extract actual filename from the response headers or URL
                const actualFilename = extractFilename(probes[choice.index].headers || {}, selectedStream.url);
                selectedStream.actualFilename = actualFilename;
                selectedStream.validationSuccess = true;
                selectedStream.priority = choice.index; // Lower index = higher priority
                if (actualFilename) {
                    selectedStream.title = formatFilenameTitle(
                        actualFilename,
                        selectedStream.originalTitle,
                        selectedStream.size
                    );
                }
            } else {
                log(`[HDHub4u] No verified link for ${groupKey}; keeping best unverified candidate (probe inconclusive)`);
                // Try to derive a filename from the URL alone
                try {
                    const actualFilename = extractFilename({}, selectedStream.url); // No headers, just URL
                    if (actualFilename) {
                        selectedStream.title = formatFilenameTitle(
                            actualFilename,
                            selectedStream.originalTitle,
                            selectedStream.size
                        );
                    }
                } catch (error) {
                    // Filename extraction failed, keep original title
                }
            }
            return selectedStream;
        });

        // Wait for all group validations to complete
        log(`[HDHub4u] Starting parallel validation of ${streamGroups.size} groups...`);
        const validationResults = await Promise.all(validationPromises);
        const uniqueStreams = validationResults.filter(stream => stream !== null);

        // Sort by quality (highest first)
        uniqueStreams.sort((a, b) => {
            const qualityA = parseQualityForSort(a.quality);
            const qualityB = parseQualityForSort(b.quality);
            return qualityB - qualityA;
        });

        log(`[HDHub4u] Successfully extracted ${uniqueStreams.length} validated streams from ${streams.length} total streams (${streamGroups.size} unique quality/source combinations)`);

        // Cache the results
        await saveToCache(cacheKey, uniqueStreams);

        return uniqueStreams;

    } catch (error) {
        console.error(`[HDHub4u] Error in getHDHub4uStreams: ${error.message}`);
        return [];
    }
}

module.exports = {
    getHDHub4uStreams
};