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
const trace = (...a) => console.log('[HDHub4u]', ...a); // always on, one short line per stage
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

// Hosts other than the main site (hubcloud, hubdrive, techyboy4u...) were returning HTTP 403 to the full
// browser-style header set (Chrome UA + the main-site Cookie + Referer), while the working 4khdhub scraper
// gets through with just a plain User-Agent. So external hosts get the plain headers FIRST and the richer
// sets only as fallbacks. The main-site cookie is never sent to third-party hosts on the first attempts.
const PLAIN_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function fetchExternal(url, referer, extra = {}) {
    const attempts = [
        { ...PLAIN_HEADERS },
        ...(referer ? [{ ...PLAIN_HEADERS, Referer: referer }] : []),
        { ...HEADERS, ...(referer ? { Referer: referer } : {}) },
    ];
    let lastErr;
    for (let i = 0; i < attempts.length; i++) {
        try {
            return await makeRequest(url, { httpsAgent: agent, timeout: 8000, ...extra, headers: { ...attempts[i], ...(extra.headers || {}) } });
        } catch (e) {
            lastErr = e;
            const st = e.response && e.response.status;
            // Different headers only help against a block. Timeouts, DNS failures, 404s etc. won't change,
            // and retrying them just multiplies the wait (serverless functions have a hard time limit).
            if (![401, 403, 429, 503].includes(st)) throw e;
            log(`[HDHub4u] fetchExternal attempt ${i + 1}/${attempts.length} failed for ${url}: ${st || e.message}`);
        }
    }
    throw lastErr;
}

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
        const response = await fetchExternal(url, null);
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

        const rawData = String(jsonObject.data || '');
        const wpHttp = (jsonObject.blog_url || '').trim();
        if (wpHttp && rawData) {
            // Different redirector variants expect `data` either base64-ENCODED (original HDHub4u logic)
            // or base64-DECODED (the working 4khdhub logic). Try both, accept the first real URL.
            let decodedData = '';
            try { decodedData = atob(rawData).trim(); } catch (e) { /* not base64 */ }
            const candidates = [...new Set([btoa(rawData).trim(), decodedData].filter(Boolean))];
            for (const candidate of candidates) {
                try {
                    const directLinkResponse = await fetchExternal(`${wpHttp}?re=${candidate}`, null);
                    const $ = cheerio.load(directLinkResponse.data);
                    const text = $('body').text().trim();
                    const abs = toAbsoluteHttpUrl(text, wpHttp);
                    if (abs) return abs;
                } catch (e) {
                    log(`[HDHub4u] Redirect ?re= attempt failed: ${e.message}`);
                }
            }
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

function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
}

/**
 * Main extractor dispatcher.
 */
async function loadExtractor(url, referer = MAIN_URL, depth = 0) {
    if (depth > 4) return [];
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
        // hubcloud.*/tg/go?id=<blob> links are redirector gates (that is what produced the 403 above). The
        // working scraper sends every link containing "id=" through the redirect decoder first, so do the
        // same here; if it can't be decoded, fall back to treating the URL as a normal HubCloud page.
        if (/\/tg\/go|[?&]id=/i.test(url)) {
            const resolved = await getRedirectLinks(url);
            if (resolved && resolved !== url && toAbsoluteHttpUrl(resolved, url)) {
                log(`[HDHub4u] HubCloud gate resolved to: ${resolved}`);
                return loadExtractor(resolved, url, depth + 1);
            }
        }
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
        return loadExtractor(finalLink, url, depth + 1);
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
    return [{ source: sourceName, quality: 'Unknown', url, generic: true }];
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
        const response = await fetchExternal(url, referer);
        return [{ source: 'Hubstream', quality: 'Unknown', url }];
    } catch (e) {
        console.error(`[HDHub4u] Hubstream failed to extract from ${url}:`, e.message);
        return [];
    }
}

async function hbLinksExtractor(url, referer) {
    const response = await fetchExternal(url, referer);
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
    const response = await fetchExternal(url, referer);
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
    let response;
    try {
        response = await fetchExternal(url, referer);
    } catch (e) {
        console.error(`[HDHub4u] HubDrive request failed for ${url}: ${e.message}`);
        return [];
    }
    const $ = cheerio.load(response.data);

    // Collect every plausible "go to HubCloud" button. The old single hard-coded class chain broke whenever
    // the site changed a CSS class, so also match by destination host and by button text.
    const hrefs = [];
    const add = (h) => { const abs = toAbsoluteHttpUrl(h, url); if (abs && !hrefs.includes(abs)) hrefs.push(abs); };

    add($('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href'));
    $('a[href*="hubcloud"]').each((i, el) => add($(el).attr('href')));
    $('a.btn, a[class*="btn"]').each((i, el) => {
        if (/hubcloud|instant|download/i.test($(el).text())) add($(el).attr('href'));
    });
    // Last-resort selectors from the working scraper (only used if nothing better was found)
    if (hrefs.length === 0) {
        $('a.btn.btn-primary, .btn-primary, a[href*="download"]').each((i, el) => add($(el).attr('href')));
    }

    const out = [];
    for (const href of hrefs) {
        if (href === url) continue;
        try {
            const res = (await loadExtractor(href, url)).filter(x => !x.generic);
            out.push(...res);
            if (res.length > 0) break; // first working button is enough
        } catch (e) {
            console.error(`[HDHub4u] HubDrive follow-up failed for ${href}: ${e.message}`);
        }
    }
    return out;
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
    const fetchPage = (target, ref) => fetchExternal(target, ref);
    try {
        pageResponse = await fetchPage(currentUrl, referer);

        // Two-step pages: the first page only holds `var url = '<real page>'` in a script.
        // Follow it once (no loops). Pages that already contain the download buttons are used as-is.
        if (!currentUrl.includes("hubcloud.php") && typeof pageResponse.data === 'string') {
            const html = pageResponse.data;
            const hasButtons = /<a[^>]+class=["'][^"']*btn[^"']*["']/i.test(html) && /card-body/i.test(html);
            const scriptUrlMatch = html.match(/(?:var|let|const)\s+url\s*=\s*(['"])([^'"]+)\1/);
            const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i);

            // Working-scraper logic: the landing page exposes the real page via <a id="download">.
            // Fallbacks (only when no download buttons are on the page already): a hubcloud.php link or
            // a generic download button.
            const $first = cheerio.load(html);
            const downloadHref = toAbsoluteHttpUrl($first('#download').attr('href'), currentUrl);
            const altHref = hasButtons ? null : (
                toAbsoluteHttpUrl($first('a[href*="hubcloud.php"]').attr('href'), currentUrl) ||
                toAbsoluteHttpUrl($first('.download-btn').attr('href'), currentUrl) ||
                toAbsoluteHttpUrl($first('a[href*="download"]').attr('href'), currentUrl)
            );
            const nextTarget = downloadHref
                || (scriptUrlMatch && scriptUrlMatch[2])
                || altHref
                || (!hasButtons && metaRefresh && metaRefresh[1])
                || null;
            if (nextTarget) {
                const nextUrl = new URL(nextTarget, currentUrl).toString();
                if (nextUrl !== currentUrl) {
                    finalUrl = nextUrl;
                    pageResponse = await fetchPage(finalUrl, currentUrl);
                }
            }
        }
    } catch (e) {
        const status = e.response ? ` (HTTP ${e.response.status})` : '';
        console.error(`[HDHub4u] HubCloud page request failed for ${(e.config && e.config.url) || finalUrl}${status}: ${e.message}`);
        return [];
    }

    const $ = cheerio.load(pageResponse.data);
    const size = ($('i#size').text() || $('#size').text()).trim();
    const header = ($('div.card-header').text() || $('.card-title').first().text() || $('title').text()).trim();

    const getIndexQuality = (str) => {
        const match = (str || '').match(/(\d{3,4})[pP]/);
        // 0 = unknown. The caller falls back to the quality shown on the movie page instead of
        // mislabelling everything as 2160p.
        return match ? parseInt(match[1]) : 0;
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
    // Buttons live in different wrappers depending on the mirror/theme, so gather them broadly and dedupe.
    const seenBtn = new Set();
    const elements = $('div.card-body h2 a.btn, div.card-body a.btn, h2 a.btn, .card a.btn').get().filter(el => {
        const h = $(el).attr('href');
        if (!h || seenBtn.has(h)) return false;
        seenBtn.add(h);
        return true;
    });

    // FSL links can reject requests without a Referer/User-Agent, so carry the headers used to
    // reach them. Consumers that ignore `headers` behave exactly as before.
    const fslHeaders = { 'User-Agent': HEADERS['User-Agent'], Referer: finalUrl };

    await Promise.all(elements.map(async (element) => {
        const rawLink = $(element).attr('href');
        const text = $(element).text();
        if (!rawLink) return;

        // Normalize to an absolute URL right away (relative hrefs resolve against the page they came from).
        // Everything below - host checks, extractors, returned stream URLs - uses this value.
        let link;
        try {
            link = new URL(rawLink, finalUrl).toString();
        } catch (error) {
            return;
        }
        const linkHost = new URL(link).hostname;

        const t = text.toLowerCase();

        // Ignore obvious non-download buttons (ads, telegram, report, etc.)
        if (/telegram|join|report|how to|tutorial/.test(t) && !/download/.test(t)) return;

        if (linkHost.includes("pixeldra")) {
            links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: toPixeldrainDownloadUrl(link), size: sizeInBytes });
        } else if (t.includes("download file")) {
            links.push({ source: `HubCloud ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (t.includes("fsl")) {
            links.push({ source: `HubCloud - FSL Server ${labelExtras}`, quality, url: link, size: sizeInBytes, headers: fslHeaders });
        } else if (t.includes("s3 server")) {
            links.push({ source: `HubCloud - S3 Server ${labelExtras}`, quality, url: link, size: sizeInBytes });
        } else if (t.includes("buzz")) {
            try {
                const buzzResp = await makeRequest(`${link.replace(/\/+$/, '')}/download`, {
                    headers: { ...PLAIN_HEADERS, Referer: link },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    httpsAgent: agent,
                });
                const dlink = buzzResp.headers['hx-redirect'] || buzzResp.headers['location'];
                const buzzUrl = toAbsoluteHttpUrl(dlink, link);
                if (buzzUrl) {
                    links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: buzzUrl, size: sizeInBytes });
                }
            } catch (e) {
                const errRedirect = e.response && (e.response.headers['hx-redirect'] || e.response.headers['location']);
                if (errRedirect) {
                    const buzzUrl = toAbsoluteHttpUrl(errRedirect, link);
                    if (buzzUrl) {
                        links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: buzzUrl, size: sizeInBytes });
                    }
                } else {
                    console.error("[HDHub4u] BuzzServer redirect not found for", link);
                }
            }
        } else if (t.includes("10gbps")) {
            let currentRedirectUrl = link;
            let finalLink = null;
            for (let i = 0; i < 5; i++) {
                try {
                    const response = await makeRequest(currentRedirectUrl, { headers: { ...PLAIN_HEADERS }, maxRedirects: 0, validateStatus: null, httpsAgent: agent });
                    const location = response.headers.location;
                    if (location) {
                        if (location.includes("link=")) {
                            finalLink = safeDecode(location.substring(location.indexOf("link=") + 5));
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
                            finalLink = safeDecode(location.substring(location.indexOf("link=") + 5));
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
        } else if (t.includes("download") || t.includes("server")) {
            // Unknown HubCloud server button (new mirrors add new names). Hand it to the dispatcher; if the
            // host is unrecognised, keep it as a direct HubCloud link rather than silently dropping it.
            const extracted = await loadExtractor(link, finalUrl);
            const usable = extracted.filter(x => !x.generic);
            if (usable.length > 0) {
                links.push(...usable);
            } else if (!/hubcloud/i.test(linkHost)) {
                links.push({ source: `HubCloud - Other ${labelExtras}`, quality, url: link, size: sizeInBytes });
            }
        }
    }));

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
async function getDownloadLinks(mediaUrl, mediaTypeHint = null) {
    await fetchAndUpdateDomain();
    HEADERS.Referer = `${MAIN_URL}/`;
    log(`[HDHub4u] Fetching download links from: ${mediaUrl}`);
    const response = await makeRequest(mediaUrl, { headers: HEADERS, httpsAgent: agent });
    log(`[HDHub4u] Download page response status: ${response.status}`);
    const $ = cheerio.load(response.data);

    const typeRaw = $('h1.page-title span').text();
    // The site's "Movie" label is not always present in the page header, which made many movies fall
    // into the TV-series branch (and return nothing). Trust the requested media type first, then the
    // header label, then fall back to "no season/episode markers in the title or URL".
    const pageHeading = `${$('h1').first().text()} ${mediaUrl}`;
    const looksLikeSeries = /\bseason\b|\bs\d{1,2}\b|\bepisode\b|web[\s-]?series|complete[\s-]?series/i.test(pageHeading);
    const isMovie = mediaTypeHint === 'movie' ? true
        : mediaTypeHint === 'tv' ? false
        : (typeRaw.toLowerCase().includes('movie') || !looksLikeSeries);

    const title = $('.page-body h2[data-ved="2ahUKEwjL0NrBk4vnAhWlH7cAHRCeAlwQ3B0oATAfegQIFBAM"], h2[data-ved="2ahUKEwiP0pGdlermAhUFYVAKHV8tAmgQ3B0oATAZegQIDhAM"]').text();
    const seasonMatch = title.match(/\bSeason\s*(\d+)\b/i);
    const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : null;

    let initialLinks = [];

    if (isMovie) {
        // Movie pages are inconsistent: links may sit in h2/h3/h4/p/div blocks, and some pages only label
        // them "Download Now" / "Watch Online" with no quality in the text. Accept an anchor when its text
        // names a quality OR its host is a known hoster/redirector, then remember the quality as a hint.
        const HOSTER_RE = /hubcloud|hubdrive|hubcdn|hblinks|hubstream|techyboy4u|pixeldra|streamtape|hdstream4u|[?&]id=/i;
        const SKIP_RE = /imdb\.com|youtube\.com|youtu\.be|t\.me\/|telegram|facebook\.com|twitter\.com|instagram\.com|magnet:|javascript:|mailto:/i;
        const qualityFromText = (text) => {
            const m = (text || '').match(/(2160|1080|720|480)\s*p?|\b4K\b/i);
            if (!m) return 0;
            return /4k/i.test(m[0]) ? 2160 : parseInt(m[1], 10);
        };

        // The quality is often in the heading/paragraph around the link, not the link itself
        const contextQuality = (el) => {
            const $el = $(el);
            return qualityFromText($el.text())
                || qualityFromText($el.closest('h2, h3, h4, h5, p').text())
                || qualityFromText($el.parent().prevAll('h2, h3, h4, h5').first().text());
        };

        const candidates = [];
        $('a[href]').each((i, el) => {
            const href = $(el).attr('href');
            if (!href || SKIP_RE.test(href)) return;
            const text = $(el).text();
            const hintQuality = contextQuality(el);
            if (hintQuality || HOSTER_RE.test(href)) {
                candidates.push({ url: href, hintQuality });
            }
        });

        initialLinks = candidates;

        const seen = new Set();
        initialLinks = initialLinks.filter(link => {
            if (!link.url || seen.has(link.url)) {
                return false;
            }
            seen.add(link.url);
            return true;
        });
        trace(`movie page ${mediaUrl} -> ${initialLinks.length} candidate links`, initialLinks.slice(0, 4).map(l => { try { return new URL(l.url, mediaUrl).hostname; } catch (e) { return '?'; } }).join(','));

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
                return extractedLinks.map(finalLink => {
                    const out = { ...finalLink, episode: linkInfo.episode };
                    // Use the quality shown next to the link on the movie page when the hoster page
                    // itself didn't reveal one. Generic (unrecognised-host) links are never promoted.
                    if (linkInfo.hintQuality && !finalLink.generic && !parseQualityForSort(finalLink.quality)) {
                        out.quality = linkInfo.hintQuality;
                    }
                    return out;
                });
            }
        } catch (e) {
            console.error(`[HDHub4u] Failed to extract from ${linkInfo.url}:`, e.message);
            return [];
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => allFinalLinks.push(...res));

    // Last resort for HubCloud/Pixeldrain links where neither the hoster page nor the movie page named a
    // quality: estimate from file size instead of dropping the link (or blindly calling it 2160p).
    const GB = 1024 * 1024 * 1024;
    for (const link of allFinalLinks) {
        if (link.generic || parseQualityForSort(link.quality)) continue;
        if (!/HubCloud|Pixeldrain/i.test(link.source || '')) continue;
        const bytes = Number(link.size) || 0;
        link.quality = bytes === 0 ? 1080 : bytes < 1.2 * GB ? 480 : bytes < 2.5 * GB ? 720 : bytes < 8 * GB ? 1080 : 2160;
    }

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

/**
 * Words of the wanted title must all appear in the result title (same idea as the working scraper's
 * containsWords). Used only as a fallback when the strict name match finds nothing.
 */
function containsWords(title, query) {
    const titleWords = normalizeForMatch(title).split(' ');
    const queryWords = normalizeForMatch(query).split(' ').filter(Boolean);
    return queryWords.length > 0 && queryWords.every(qw =>
        titleWords.some(tw => tw.includes(qw) || qw.includes(tw))
    );
}

function relaxedMatches(results, wantedTitle, wantedYear, mediaType) {
    const out = [];
    results.forEach((r, index) => {
        if (!containsWords(r.title, wantedTitle)) return;
        if (mediaType === 'movie' && wantedYear) {
            const years = ((r.title || '').match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
            // Still never guess across years: the result must show a year within +/-1 of the request
            if (!years.some(y => Math.abs(y - wantedYear) <= 1)) return;
        }
        const sim = compareTwoStrings(normalizeForMatch(extractNamePart(r.title)), normalizeForMatch(wantedTitle));
        if (sim < 0.6) return;
        out.push({ r, index, ok: true, score: sim });
    });
    return out;
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
        const cacheKey = `hdhub4u_final_v3_${mediaType}_${tmdbId}${seasonNum ? `_s${seasonNum}` : ''}${episodeNum ? `_e${episodeNum}` : ''}`;
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
        trace(`search "${searchQuery}" -> ${searchResults.length} results`, searchResults.slice(0, 3).map(r => r.title).join(' | '));
        log(`[HDHub4u] Search returned ${searchResults.length} results for query: ${searchQuery}`);

        // If no results, try with year appended
        if (searchResults.length === 0 && year) {
            searchQuery = `${title} ${year}`;
            log(`[HDHub4u] Retrying search with year: "${searchQuery}"`);
            searchResults = await search(searchQuery);
            log(`[HDHub4u] Retry search returned ${searchResults.length} results`);
        }

        // Punctuation in the TMDB title (colons, dashes, apostrophes) often breaks the site's search
        const plainTitle = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (searchResults.length === 0 && plainTitle && plainTitle !== title) {
            searchResults = await search(plainTitle);
            trace(`search "${plainTitle}" -> ${searchResults.length} results`);
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
        let eligible = searchResults
            .map((r, index) => ({ r, index, ...scoreTitleMatch(r.title, title, parsedYear, mediaType) }))
            .filter(x => x.ok);
        if (eligible.length === 0) {
            eligible = relaxedMatches(searchResults, title, parsedYear, mediaType);
            if (eligible.length > 0) log(`[HDHub4u] Strict match found nothing; relaxed match found ${eligible.length} candidate(s)`);
        }

        if (eligible.length === 0) {
            trace(`no title/year match for "${title}" (${year || 'no year'}) among:`, searchResults.slice(0, 5).map(r => r.title).join(' | '));
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
        trace(`matched "${bestMatch.title}"`);
        const { finalLinks, isMovie } = await getDownloadLinks(bestMatch.url, mediaType);
        trace(`extracted ${finalLinks.length} links (${isMovie ? 'movie' : 'series'})`);

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

        trace(`${streams.length} streams after quality filter`);

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