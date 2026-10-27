/**
 * HDHub4u Provider for Stremio Addon
clea * Based on the standalone scraper from scrapersdirect/hdhub4u-scraper.js
 * Supports both movies and TV series
 */

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { findBestMatch } = require('string-similarity');
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

/**
 * Fetches the latest domain for HDHub4u.
 */
let lastDomainCheck = 0;
const DOMAIN_CHECK_TTL_MS = 10 * 60 * 1000;

async function fetchAndUpdateDomain() {
    // This is called from search(), getDownloadLinks() and getHDHub4uStreams(); only hit the network
    // once per TTL instead of three times in a row for every stream request.
    if (Date.now() - lastDomainCheck < DOMAIN_CHECK_TTL_MS) return;
    lastDomainCheck = Date.now();
    try {
        const response = await makeRequest(DOMAINS_URL, { httpsAgent: agent, timeout: 5000 });
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
    }
}

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Cookie": "xla=s4t",
    "Referer": `${MAIN_URL}/`,
};

// --- Proxy Wrapper Function ---
// axios has no timeout by default, so one unresponsive host used to stall the whole request.
const DEFAULT_TIMEOUT_MS = 15000;
const makeRequest = async (url, options = {}) => {
    const opts = { timeout: DEFAULT_TIMEOUT_MS, ...options };
    if (HDHUB4U_PROXY_URL) {
        const proxiedUrl = `${HDHUB4U_PROXY_URL}?url=${encodeURIComponent(url)}`;
        log(`[HDHub4u] Using proxy for: ${url}`);
        return axios.get(proxiedUrl, opts);
    } else {
        return axios.get(url, opts);
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

/**
 * Resolves obfuscated redirector links.
 */
async function getRedirectLinks(url) {
    try {
        log(`[HDHub4u] Processing redirect link: ${safeUrl(url)}`);
        const response = await makeRequest(url, { headers: HEADERS, httpsAgent: agent });
        const doc = response.data;

        // Log response details for debugging
        log(`[HDHub4u] Response status: ${response.status}`);
        log(`[HDHub4u] Response content-type: ${response.headers['content-type']}`);
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
 * Main extractor dispatcher.
 */
async function loadExtractor(url, referer = MAIN_URL) {
    const hostname = new URL(url).hostname;

    // Some links from the main site are redirectors that need to be resolved first.
    if (url.includes("?id=") || hostname.includes('techyboy4u')) {
        log(`[HDHub4u] Processing redirect URL: ${safeUrl(url)} (hostname: ${hostname})`);
        const finalLink = await getRedirectLinks(url);
        if (!finalLink) {
            log(`[HDHub4u] Failed to resolve redirect link: ${safeUrl(url)}`);
            return [];
        }
        if (finalLink === url) {
            // getRedirectLinks returns the input URL when resolution fails. The URL still
            // contains "?id=", so recursing would re-request the same URL indefinitely.
            console.error(`[HDHub4u] Redirect could not be resolved, skipping: ${url}`);
            return [];
        }
        log(`[HDHub4u][trace] redirect destination: ${safeUrl(finalLink)}`);
        return loadExtractor(finalLink, url);
    }

    if (hostname.includes('hubcloud')) {
        return hubCloudExtractor(url, referer);
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

async function hubCloudExtractor(url, referer) {
    let currentUrl = url;
    if (currentUrl.includes("hubcloud.ink")) {
        currentUrl = currentUrl.replace("hubcloud.ink", "hubcloud.dad");
    }

    let pageResponse = await makeRequest(currentUrl, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent });
    let finalUrl = currentUrl;

    if (!currentUrl.includes("hubcloud.php")) {
        const scriptUrlMatch = pageResponse.data.match(/var url = '([^']*)'/);
        if (scriptUrlMatch && scriptUrlMatch[1]) {
            finalUrl = scriptUrlMatch[1];
            pageResponse = await makeRequest(finalUrl, { headers: { ...HEADERS, Referer: currentUrl }, httpsAgent: agent });
        }
    }

    const $ = cheerio.load(pageResponse.data);
    const size = $('i#size').text().trim();
    const header = $('div.card-header').text().trim();

    const getIndexQuality = (str) => {
        const match = (str || '').match(/(\d{3,4})[pP]/);
        if (match) return parseInt(match[1]);
        // Previously an unknown resolution silently became 2160p. Only claim 2160p if the name says so;
        // otherwise return 0 so the caller's existing "unknown quality" filter drops it.
        return /\b(4k|uhd)\b/i.test(str || '') ? 2160 : 0;
    };

    const quality = getIndexQuality(header);
    const headerDetails = cleanTitle(header);
    log(`[HDHub4u][trace] HubCloud file: "${header.replace(/\s+/g, ' ')}" quality=${quality || 'unknown'} size=${size || 'n/a'} page=${safeUrl(finalUrl)}`);

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

    for (const element of elements) {
        const link = $(element).attr('href');
        const text = $(element).text();
        log(`[HDHub4u][trace] HubCloud button "${text.replace(/\s+/g, ' ').trim()}" -> ${safeUrl(link)}`);

        if (link && link.includes("pixeldra")) {
            // Decided by the link's host, not the button label (labels vary).
            links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName: header });
        } else if (text.includes("Download File")) {
            links.push({ source: `HubCloud ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName: header });
        } else if (/FSL/i.test(text)) { // "FSL Server", "FSLv2 Server", ...
            links.push({ source: `HubCloud - FSL Server ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName: header });
        } else if (text.includes("S3 Server")) {
            links.push({ source: `HubCloud - S3 Server ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName: header });
        } else if (text.includes("BuzzServer")) {
            try {
                const buzzResp = await makeRequest(`${link}/download`, {
                    headers: { ...HEADERS, Referer: link },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                    httpsAgent: agent,
                });
                const dlink = buzzResp.headers['hx-redirect'];
                if (dlink) {
                    const baseUrl = new URL(link).origin;
                    log(`[HDHub4u][trace] redirect destination (BuzzServer): ${safeUrl(baseUrl + dlink)}`);
                    links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: baseUrl + dlink, size: sizeInBytes, fileName: header });
                }
            } catch (e) {
                if (e.response && e.response.headers['hx-redirect']) {
                    const dlink = e.response.headers['hx-redirect'];
                    const baseUrl = new URL(link).origin;
                    links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: baseUrl + dlink, size: sizeInBytes, fileName: header });
                } else {
                    console.error("[HDHub4u] BuzzServer redirect not found for", link);
                }
            }
        } else if (link.includes("pixeldra")) {
            links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName: header });
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
                        currentRedirectUrl = new URL(location, currentRedirectUrl).toString();
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
                        currentRedirectUrl = new URL(location, currentRedirectUrl).toString();
                    } else {
                        console.error("[HDHub4u] 10Gbps redirect failed for", currentRedirectUrl);
                        break;
                    }
                }
            }
            if (finalLink) {
                log(`[HDHub4u][trace] redirect destination (10Gbps): ${safeUrl(finalLink)}`);
                links.push({ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: finalLink, size: sizeInBytes, fileName: header });
            }
        } else {
            log(`[HDHub4u][trace] HubCloud button "${text.replace(/\s+/g, ' ').trim()}" has no dedicated handler; using generic extractor`);
            const extracted = await loadExtractor(link, finalUrl);
            links.push(...extracted);
        }
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
                    for (const redirectLink of redirectLinks) {
                        try {
                            const resolvedUrl = await getRedirectLinks(redirectLink);
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

    log(`[HDHub4u] Found ${initialLinks.length} initial hoster links. Now extracting...`);

    const allFinalLinks = [];
    const promises = initialLinks.map(async (linkInfo) => {
        try {
            if (linkInfo.isQualityRedirect) {
                const resolvedUrl = await getRedirectLinks(linkInfo.url);
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

// =================================================================================
// MATCHING / LOGGING HELPERS
// =================================================================================

// How far the year on the site / in the file name may differ from the requested year.
const YEAR_TOLERANCE = 0;

// Logs origin + path only (query strings can carry tokens / ids).
function safeUrl(u) {
    try {
        const p = new URL(u);
        return `${p.origin}${p.pathname}`;
    } catch (e) {
        return '[unparseable url]';
    }
}

function hostOf(u) {
    try {
        return new URL(u).hostname;
    } catch (e) {
        return 'unknown';
    }
}

function normalizeWords(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
}

function stripArticle(words) {
    return words[0] === 'the' ? words.slice(1) : words;
}

const QUALITY_TOKEN_RE = /\b(?:480p|720p|1080p|2160p|4k|uhd|web[- ]?dl|webrip|blu[- ]?ray|brrip|hdrip|hdtc|hdcam|dvdrip|dual audio)\b/i;

/**
 * Splits a site title such as "Project Hail Mary (2026) WEB-DL [Hindi + English] 1080p ..." into
 * the bare title words and the release year.
 */
function parseResultTitle(text) {
    const t = (text || '').replace(/^\s*download\s+/i, '');
    const yearParen = t.match(/[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]/);
    const yearLoose = yearParen ? null : t.slice(1).match(/\b((?:19|20)\d{2})\b/);
    const year = yearParen ? parseInt(yearParen[1], 10) : (yearLoose ? parseInt(yearLoose[1], 10) : null);

    const cuts = [];
    if (yearParen) cuts.push(yearParen.index);
    else if (yearLoose) cuts.push(yearLoose.index + 1);
    const seasonIdx = t.search(/\bseason\b|\bS\d{1,2}\b/i);
    if (seasonIdx > 0) cuts.push(seasonIdx);
    if (!yearParen && !yearLoose) {
        const bracketIdx = t.indexOf('[');
        if (bracketIdx > 0) cuts.push(bracketIdx);
        const qualityIdx = t.search(QUALITY_TOKEN_RE);
        if (qualityIdx > 0) cuts.push(qualityIdx);
    }
    const cut = cuts.length ? Math.min(...cuts) : t.length;
    return { year, coreWords: normalizeWords(t.slice(0, cut)) };
}

/** Returns {from, to} for "Season 2", "Season 1-4", "S01-S03"; null if the title names no season. */
function parseSeasonsFromTitle(text) {
    const t = text || '';
    let m = t.match(/seasons?\s*0*(\d{1,2})\s*(?:-|–|to|&|,)\s*(?:season\s*)?0*(\d{1,2})/i)
        || t.match(/\bS0*(\d{1,2})\s*-\s*S?0*(\d{1,2})\b/i);
    if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        return { from: Math.min(a, b), to: Math.max(a, b) };
    }
    m = t.match(/seasons?\s*0*(\d{1,2})\b/i) || t.match(/\bS0*(\d{1,2})\b/i);
    if (m) {
        const n = parseInt(m[1], 10);
        return { from: n, to: n };
    }
    return null;
}

/**
 * Picks the search result that is actually the requested title (and year for movies / season for
 * series). Returns null instead of guessing when nothing matches.
 */
function selectSearchResult(results, { title, year, mediaType, seasonNum }) {
    const wantWords = normalizeWords(title);
    const want = wantWords.join(' ');
    const wantNoArticle = stripArticle(wantWords).join(' ');
    const isTv = mediaType === 'tv';
    const candidates = [];

    for (const r of results) {
        const parsed = parseResultTitle(r.title);
        // Exact title wins; a title that differs only by a leading "The" is a weaker (tier +2) match.
        const exactTitle = parsed.coreWords.join(' ') === want;
        const articleOnly = !exactTitle && stripArticle(parsed.coreWords).join(' ') === wantNoArticle;
        if (!exactTitle && !articleOnly) {
            log(`[HDHub4u] Rejected "${r.title}": title is not "${title}"`);
            continue;
        }
        const penalty = articleOnly ? 2 : 0;
        if (!isTv) {
            if (!year) {
                candidates.push({ r, parsed, tier: 0 + penalty, width: 0 });
            } else if (parsed.year) {
                if (Math.abs(parsed.year - Number(year)) > YEAR_TOLERANCE) {
                    log(`[HDHub4u] Rejected "${r.title}": year ${parsed.year} != requested ${year}`);
                    continue;
                }
                candidates.push({ r, parsed, tier: 0 + penalty, width: 0 });
            } else {
                candidates.push({ r, parsed, tier: 1 + penalty, width: 0 }); // title matches, site shows no year
            }
        } else if (seasonNum) {
            const range = parseSeasonsFromTitle(r.title);
            if (range) {
                if (seasonNum < range.from || seasonNum > range.to) {
                    log(`[HDHub4u] Rejected "${r.title}": does not cover season ${seasonNum}`);
                    continue;
                }
                candidates.push({ r, parsed, tier: 0 + penalty, width: range.to - range.from });
            } else {
                candidates.push({ r, parsed, tier: 1 + penalty, width: 0 }); // title matches, site names no season
            }
        } else {
            candidates.push({ r, parsed, tier: 0 + penalty, width: 0 });
        }
    }

    if (candidates.length === 0) return null;
    // Exact year/season matches first, then the narrowest season range; ties keep the site's order.
    candidates.sort((a, b) => a.tier - b.tier || a.width - b.width);
    const best = candidates[0];
    return { ...best.r, matchedYear: best.parsed.year, matchTier: best.tier };
}

/**
 * Checks the actual file name behind a link against the request: trailers/samples, a different
 * year, or a different SxxEyy are rejected. Links with no file name cannot be checked and pass.
 */
function checkLinkFile(link, { title, year, mediaType, seasonNum, episodeNum }) {
    const name = link.fileName || link.name || '';
    if (!name) return { ok: true };

    if (/\b(trailer|teaser|sample|promo)\b/i.test(name)) {
        return { ok: false, reason: 'trailer/sample file' };
    }

    const nameWords = new Set(normalizeWords(name));
    const wantWords = stripArticle(normalizeWords(title));
    if (wantWords.length > 0 && !wantWords.some(w => nameWords.has(w))) {
        return { ok: false, reason: 'file name does not contain the requested title' };
    }

    if (mediaType !== 'tv' && year) {
        const years = (name.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
        if (years.length > 0 && !years.some(y => Math.abs(y - Number(year)) <= YEAR_TOLERANCE)) {
            return { ok: false, reason: `file year ${years.join('/')} != requested ${year}` };
        }
    }

    if (mediaType === 'tv') {
        const m = name.match(/\bS(\d{1,2})[ ._-]*E(\d{1,3})\b/i);
        if (m) {
            if (seasonNum && parseInt(m[1], 10) !== Number(seasonNum)) {
                return { ok: false, reason: `file is season ${parseInt(m[1], 10)}, requested ${seasonNum}` };
            }
            if (episodeNum && parseInt(m[2], 10) !== Number(episodeNum)) {
                return { ok: false, reason: `file is episode ${parseInt(m[2], 10)}, requested ${episodeNum}` };
            }
        }
    }
    return { ok: true };
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

        // Search for the title and accept ONLY a result whose title (and year for movies, season for
        // series) matches the request. If the plain-title search yields no acceptable match, retry
        // once with the year appended. Nothing is guessed: no match means no streams.
        const searchQueries = [title];
        if (year) searchQueries.push(`${title} ${year}`);

        let bestMatch = null;
        for (const searchQuery of searchQueries) {
            log(`[HDHub4u] Searching for: "${searchQuery}"`);
            const searchResults = await search(searchQuery);
            log(`[HDHub4u] Search returned ${searchResults.length} results for query: ${searchQuery}`);
            if (searchResults.length === 0) continue;

            searchResults.slice(0, 5).forEach((result, index) => {
                log(`[HDHub4u] Search result ${index + 1}: ${result.title} - ${safeUrl(result.url)}`);
            });

            bestMatch = selectSearchResult(searchResults, { title, year, mediaType, seasonNum });
            if (bestMatch) break;
        }

        if (!bestMatch) {
            log(`[HDHub4u] No search result matched "${title}"${year ? ` (${year})` : ''}${seasonNum ? ` season ${seasonNum}` : ''}; not guessing`);
            await saveToCache(cacheKey, []);
            return [];
        }

        log(`[HDHub4u] ===== SELECTED MEDIA =====`);
        log(`[HDHub4u][trace] matched title: "${bestMatch.title}" | site year: ${bestMatch.matchedYear || 'n/a'} | requested: "${title}" (${year || 'n/a'}${seasonNum ? ` S${seasonNum}${episodeNum ? `E${episodeNum}` : ''}` : ''}) | tier: ${bestMatch.matchTier} | ${safeUrl(bestMatch.url)}`);
        log(`[HDHub4u] ===== EXTRACTING DOWNLOAD LINKS =====`);

        // Get download links
        const { finalLinks, isMovie } = await getDownloadLinks(bestMatch.url);

        if (finalLinks.length === 0) {
            log(`[HDHub4u] No download links found`);
            await saveToCache(cacheKey, []);
            return [];
        }

        // Filter links for specific episode if needed
        let filteredLinks = finalLinks.filter(link => {
            const verdict = checkLinkFile(link, { title, year, mediaType, seasonNum, episodeNum });
            if (!verdict.ok) {
                log(`[HDHub4u] Skipping file "${(link.fileName || link.name || '').replace(/\s+/g, ' ')}": ${verdict.reason}`);
            }
            return verdict.ok;
        });
        if (!isMovie && episodeNum) {
            filteredLinks = filteredLinks.filter(link => link.episode === episodeNum);
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
                const sourceAbbrev = link.source.startsWith('Pixeldrain') ? 'PD' :
                    link.source.startsWith('HubCloud - FSL') ? 'FSL' :
                        link.source.startsWith('HubCloud - S3') ? 'S3' :
                            link.source.startsWith('HubCloud - BuzzServer') ? 'BZ' :
                                link.source.startsWith('HubCloud - 10Gbps') ? '10G' :
                                    link.source.startsWith('HubCloud') ? 'HC' :
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
                    sizeBytes: Number(link.size) || 0, // internal: numeric size for sorting/verification
                    fileName: link.fileName || link.name || '', // internal: removed before returning
                    episode: link.episode || null,
                    originalTitle: title // Store original title for fallback
                };
            });

        // Group streams by source and quality, then validate and select best link
        const streamGroups = new Map();

        // Group streams by quality + server type. Previously every HubCloud server (Download File,
        // FSL, S3, Buzz, 10Gbps) shared one group per quality, so only the first one that validated
        // survived (usually the "Download File"/hubcdn link) and FSL never reached the player.
        for (const stream of streams) {
            const serverMatch = stream.source.match(/^HubCloud - (FSL|S3|BuzzServer|10Gbps)/);
            const sourceType = serverMatch ? serverMatch[1] :
                stream.source.startsWith('Pixeldrain') ? 'Pixeldrain' :
                    stream.source.startsWith('HubCloud') ? 'HubCloud' : 'Other';
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
                return (b.sizeBytes || 0) - (a.sizeBytes || 0);
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

        // Validate links in parallel for each group
        const isMediaResponse = (headers) => {
            // An HTML/JSON/text body means we landed on an intermediate page, not the video file.
            const contentType = String(headers['content-type'] || '').toLowerCase();
            return !/^(text\/|application\/json|application\/xhtml)/.test(contentType);
        };

        const KNOWN_HEIGHTS = new Set(['240', '360', '480', '576', '720', '1080', '1440', '2160', '4320']);

        // Keep quality and size consistent with the file that was actually selected.
        const applyActualFileInfo = (stream) => {
            if (stream.actualSize > 1024 * 1024) {
                if (stream.sizeBytes && Math.abs(stream.actualSize - stream.sizeBytes) / stream.actualSize > 0.1) {
                    log(`[HDHub4u] Size on page (${formatBytes(stream.sizeBytes)}) differs from server (${formatBytes(stream.actualSize)}); using server value`);
                }
                stream.sizeBytes = stream.actualSize;
                stream.size = formatBytes(stream.actualSize);
            }
            const q = (stream.actualFilename || '').match(/(\d{3,4})[pP]/);
            if (q && KNOWN_HEIGHTS.has(q[1]) && q[1] !== stream.quality) {
                log(`[HDHub4u] Quality label ${stream.quality}p differs from file name (${q[1]}p); using file name`);
                const oldLabel = `${stream.quality}p`;
                stream.name = stream.name.replace(oldLabel, `${q[1]}p`);
                stream.originalTitle = stream.originalTitle.replace(oldLabel, `${q[1]}p`);
                stream.title = stream.title.replace(oldLabel, `${q[1]}p`);
                stream.quality = q[1];
            }
        };

        const traceSelected = (stream, verified) => {
            log(`[HDHub4u][trace] selected file="${(stream.actualFilename || stream.fileName || '(unknown)').replace(/\s+/g, ' ')}" quality=${stream.quality}p size=${stream.size || 'n/a'} finalHost=${hostOf(stream.url)} verified=${verified}`);
        };

        const validationPromises = Array.from(streamGroups.entries()).map(async ([groupKey, groupStreams]) => {
            log(`[HDHub4u] Validating ${groupStreams.length} links for ${groupKey}...`);

            // Each validation resolves to: a validated stream, { rejected: true } (definitely not a
            // playable file), or null (inconclusive - timeout, HEAD unsupported, blocked, ...).
            const streamValidations = groupStreams.map(async (stream, index) => {
                try {
                    const response = await axios.head(stream.url, {
                        timeout: 5000,
                        httpsAgent: agent,
                        headers: {
                            'User-Agent': HEADERS['User-Agent']
                        }
                    });

                    if (response.status === 200) {
                        if (!isMediaResponse(response.headers)) {
                            log(`[HDHub4u] ✗ Link ${index + 1} for ${groupKey} is a web page (content-type: ${response.headers['content-type']}), not a media file; host=${hostOf(stream.url)}`);
                            return { rejected: true };
                        }

                        // Extract actual filename from headers or URL
                        const actualFilename = extractFilename(response.headers, stream.url);
                        const actualSize = parseInt(response.headers['content-length'], 10) || 0;

                        log(`[HDHub4u] ✓ Link ${index + 1} validated for ${groupKey}${actualFilename ? ` - Filename: ${actualFilename}` : ''}`);

                        return {
                            ...stream,
                            actualFilename,
                            actualSize,
                            validationSuccess: true,
                            priority: index // Lower index = higher priority
                        };
                    }
                } catch (error) {
                    if (error.response && (error.response.status === 404 || error.response.status === 410)) {
                        log(`[HDHub4u] ✗ Link ${index + 1} for ${groupKey} no longer exists (HTTP ${error.response.status}); host=${hostOf(stream.url)}`);
                        return { rejected: true };
                    }
                    log(`[HDHub4u] ? Link ${index + 1} for ${groupKey} could not be verified: ${error.message}`);
                }
                return null;
            });

            // Wait for all validations in this group to complete
            const results = await Promise.all(streamValidations);
            const validStreams = results.filter(result => result && result.validationSuccess);
            // Only links whose check was inconclusive may be used unverified; known-bad ones are dropped.
            const unverifiedStreams = groupStreams.filter((stream, i) => results[i] === null);

            if (validStreams.length > 0) {
                // Return the highest priority valid stream
                const selectedStream = validStreams.sort((a, b) => a.priority - b.priority)[0];
                applyActualFileInfo(selectedStream);

                // Update title with actual filename if available
                if (selectedStream.actualFilename) {
                    selectedStream.title = formatFilenameTitle(
                        selectedStream.actualFilename,
                        selectedStream.originalTitle,
                        selectedStream.size
                    );
                }

                traceSelected(selectedStream, true);
                return selectedStream;
            } else if (unverifiedStreams.length > 0) {
                log(`[HDHub4u] No link could be verified for ${groupKey}, using first unverified link as fallback`);
                const fallbackStream = unverifiedStreams[0];

                // Try to extract filename for fallback stream too
                try {
                    const actualFilename = extractFilename({}, fallbackStream.url); // No headers, just URL
                    if (actualFilename) {
                        fallbackStream.title = formatFilenameTitle(
                            actualFilename,
                            fallbackStream.originalTitle,
                            fallbackStream.size
                        );
                    }
                } catch (error) {
                    // Filename extraction failed, keep original title
                }

                traceSelected(fallbackStream, false);
                return fallbackStream;
            }

            log(`[HDHub4u] All ${groupStreams.length} links for ${groupKey} were rejected (not playable files)`);
            return null;
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

        uniqueStreams.forEach(stream => {
            delete stream.sizeBytes;
            delete stream.fileName;
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