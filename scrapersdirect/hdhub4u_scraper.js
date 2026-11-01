/**
 * HDHub4u standalone scraper (cleaned up + focused extractors)
 *
 * Output is limited to:  FSL Server  +  Pixeldrain   (reached via HubDrive / HubCloud)
 * Junk hosts such as greenmotors.club are blocked everywhere.
 *
 * Requires Node 18+  (npm i axios cheerio)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const readline = require('readline');

// =================================================================================
// CONFIG
// =================================================================================
const CONFIG = {
    // Which HubCloud servers to keep. Options: 'FSL', 'Pixeldrain', 'S3', 'BuzzServer', '10Gbps', 'DownloadFile'
    allowedServers: ['FSL', 'Pixeldrain'],
    // Any final URL whose host matches one of these is dropped.
    blockedHosts: [/green-?motors/i],
    timeout: 20000,
    retries: 2,
    concurrency: 6,
};

const agent = new https.Agent({ rejectUnauthorized: false });

let MAIN_URL = 'https://4khdhub.one'; // fallback domain
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    'Cookie': 'xla=s4t',
    'Referer': `${MAIN_URL}/`,
};

// =================================================================================
// HTTP HELPERS
// =================================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** GET with timeout + retry on network errors / 5xx / 429. 4xx fails fast. */
async function get(url, opts = {}) {
    const { headers, ...rest } = opts;
    let lastErr;
    for (let i = 0; i <= CONFIG.retries; i++) {
        try {
            return await axios.get(url, {
                httpsAgent: agent,
                timeout: CONFIG.timeout,
                ...rest,
                headers: { ...HEADERS, ...(headers || {}) },
            });
        } catch (e) {
            lastErr = e;
            const status = e.response && e.response.status;
            if (status && status < 500 && status !== 429) break;
            await sleep(400 * (i + 1));
        }
    }
    throw lastErr;
}

/** Run fn over items with a concurrency cap (keeps hosts from rate-limiting us). */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const idx = next++;
            out[idx] = await fn(items[idx], idx);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

// =================================================================================
// DOMAIN HANDLING (fetched once, cached)
// =================================================================================
let domainPromise = null;
function getCurrentDomain() {
    if (!domainPromise) {
        domainPromise = (async () => {
            try {
                const { data } = await get(DOMAINS_URL);
                if (data && data.HDHUB4u) MAIN_URL = data.HDHUB4u.replace(/\/+$/, '');
            } catch (e) {
                console.error('Failed to fetch latest domain, using default.', e.message);
            }
            HEADERS.Referer = `${MAIN_URL}/`;
            return MAIN_URL;
        })();
    }
    return domainPromise;
}

// =================================================================================
// UTILITIES
// =================================================================================
const b64enc = s => Buffer.from(s).toString('base64');
const b64dec = s => Buffer.from(s, 'base64').toString('utf-8');

const rot13 = value =>
    value.replace(/[a-zA-Z]/g, c => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });

const absUrl = (href, base) => {
    try { return new URL(href, base).toString(); } catch { return null; }
};

const isBlocked = url => !url || CONFIG.blockedHosts.some(re => re.test(url));

function qualityFrom(str) {
    const m = (str || '').match(/(\d{3,4})\s*p/i);
    if (m) return `${m[1]}p`;
    if (/4k|uhd/i.test(str || '')) return '2160p';
    return null;
}

function parseSize(str) {
    const m = (str || '').match(/([\d.]+)\s*(GB|MB|KB)/i);
    if (!m) return 0;
    const mult = { GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 }[m[2].toUpperCase()];
    return parseFloat(m[1]) * mult;
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Resolves obfuscated redirector links (techyboy4u / ?id=...).
 * Returns null if it can't be resolved (so callers never loop forever).
 */
async function getRedirectLinks(url) {
    try {
        const { data: doc } = await get(url);

        const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
        let combined = '';
        let m;
        while ((m = regex.exec(doc)) !== null) combined += m[1] || m[2] || '';

        if (!combined) {
            console.error('[getRedirectLinks] No encoded strings found in', url);
            return null;
        }

        const decoded = b64dec(rot13(b64dec(b64dec(combined))));
        const json = JSON.parse(decoded);

        const encodedUrl = b64dec(json.o || '').trim();
        if (encodedUrl) return encodedUrl;

        const data = b64enc(json.data || '').trim();
        const wpHttp = (json.blog_url || '').trim();
        if (wpHttp && data) {
            const r = await get(`${wpHttp}?re=${data}`);
            const text = cheerio.load(r.data)('body').text().trim();
            return text || null;
        }
        return null;
    } catch (e) {
        console.error(`[getRedirectLinks] ${url}:`, e.message);
        return null;
    }
}

// =================================================================================
// EXTRACTORS
// =================================================================================

/** Dispatcher. Unknown hosts return nothing (this is what kills junk like greenmotors.club). */
async function loadExtractor(url, referer = MAIN_URL, hint = {}, depth = 0) {
    if (!url || depth > 6) return [];
    let hostname;
    try { hostname = new URL(url).hostname; } catch { return []; }
    if (isBlocked(url)) return [];

    try {
        // Obfuscated redirectors must be resolved first
        if (url.includes('?id=') || hostname.includes('techyboy4u')) {
            const finalLink = await getRedirectLinks(url);
            if (!finalLink || finalLink === url) return [];
            return loadExtractor(finalLink, url, hint, depth + 1);
        }

        if (hostname.includes('hubcloud')) return await hubCloudExtractor(url, referer, hint, depth);
        if (hostname.includes('hubdrive')) return await hubDriveExtractor(url, referer, hint, depth);
        if (hostname.includes('hblinks')) return await hbLinksExtractor(url, referer, hint, depth);
        if (hostname.includes('pixeldrain')) return await pixelDrainExtractor(url, hint);
    } catch (e) {
        console.error(`[loadExtractor] ${hostname}:`, e.message);
    }
    return [];
}

/**
 * Pixeldrain: supports /u/ID, /file/ID, /api/file/ID and list pages (/l/ID).
 * Output is always the pixeldrain.com API download URL.
 */
async function pixelDrainExtractor(link, hint = {}) {
    const m = link.match(/pixeldrain\.[a-z]+\/(?:api\/)?(u|file|l|list)\/([A-Za-z0-9_-]+)/i);
    if (!m) return [];
    const kind = m[1].toLowerCase();
    const id = m[2];

    const build = (fileId, info = {}) => ({
        source: 'Pixeldrain',
        server: 'Pixeldrain',
        quality: qualityFrom(info.name) || hint.quality || 'Unknown',
        url: `https://pixeldrain.com/api/file/${fileId}?download`,
        name: info.name || hint.name || '',
        size: info.size || hint.size || 0,
    });

    try {
        if (kind === 'l' || kind === 'list') {
            const { data } = await get(`https://pixeldrain.com/api/list/${id}`);
            return (data.files || []).map(f => build(f.id, f));
        }
        const { data } = await get(`https://pixeldrain.com/api/file/${id}/info`);
        return [build(id, data || {})];
    } catch (e) {
        // Info endpoint failed (rate limit etc.) — the direct link still works.
        if (kind === 'l' || kind === 'list') return [];
        return [build(id)];
    }
}

/** HubDrive page -> HubCloud (or other) button -> recurse. */
async function hubDriveExtractor(url, referer, hint, depth) {
    const { data } = await get(url, { headers: { Referer: referer } });
    const $ = cheerio.load(data);

    const candidates = [];
    const primary = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
    if (primary) candidates.push(primary);

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text();
        if (/hubcloud/i.test(href) || /hubcloud|instant|download/i.test(text) && /btn/.test($(el).attr('class') || '')) {
            candidates.push(href);
        }
    });

    const seen = new Set();
    for (const href of candidates) {
        const full = absUrl(href, url);
        if (!full || seen.has(full) || isBlocked(full)) continue;
        seen.add(full);
        const res = await loadExtractor(full, url, hint, depth + 1);
        if (res.length) return res;
    }
    return [];
}

async function hbLinksExtractor(url, referer, hint, depth) {
    const { data } = await get(url, { headers: { Referer: referer } });
    const $ = cheerio.load(data);
    const links = [...new Set($('h3 a, h4 a, div.entry-content p a').map((_, el) => $(el).attr('href')).get())];

    const out = [];
    for (const href of links) {
        const full = absUrl(href, url);
        if (full) out.push(...await loadExtractor(full, url, hint, depth + 1));
    }
    return out;
}

/** Decide which server a HubCloud button belongs to. */
function classifyServer(text, href) {
    if (/pixeldra/i.test(href) || /pixeldrain/i.test(text)) return 'Pixeldrain';
    if (/FSL/i.test(text)) return 'FSL';            // "FSL Server", "FSLv2 Server", ...
    if (/S3/i.test(text)) return 'S3';
    if (/Buzz/i.test(text)) return 'BuzzServer';
    if (/10\s*Gbps/i.test(text)) return '10Gbps';
    if (/Download File/i.test(text)) return 'DownloadFile';
    return 'Other';
}

async function followRedirectForLink(startUrl) {
    let current = startUrl;
    for (let i = 0; i < 5; i++) {
        const res = await axios.get(current, {
            httpsAgent: agent, timeout: CONFIG.timeout, headers: HEADERS,
            maxRedirects: 0, validateStatus: () => true,
        });
        const location = res.headers.location;
        if (!location) return null;
        if (location.includes('link=')) return decodeURIComponent(location.substring(location.indexOf('link=') + 5));
        current = new URL(location, current).toString();
    }
    return null;
}

async function hubCloudExtractor(url, referer, hint, depth) {
    let currentUrl = url.replace('hubcloud.ink', 'hubcloud.dad');

    let page = await get(currentUrl, { headers: { Referer: referer } });
    let finalUrl = currentUrl;

    // Landing page hides the real page in `var url = '...'`
    if (!currentUrl.includes('hubcloud.php')) {
        const m = page.data.match(/var url = '([^']*)'/);
        if (m && m[1]) {
            finalUrl = absUrl(m[1], currentUrl) || m[1];
            page = await get(finalUrl, { headers: { Referer: currentUrl } });
        }
    }

    const $ = cheerio.load(page.data);
    const sizeText = $('i#size').text().trim();
    const header = $('div.card-header').text().trim();

    const meta = {
        quality: qualityFrom(header) || hint.quality || 'Unknown',
        size: parseSize(sizeText) || hint.size || 0,
        name: header || hint.name || '',
    };

    const allowed = new Set(CONFIG.allowedServers);
    const buttons = $('div.card-body a.btn, h2 a.btn').get();
    const seen = new Set();
    const results = [];

    for (const el of buttons) {
        const rawHref = $(el).attr('href');
        const text = $(el).text().trim();
        const link = rawHref && absUrl(rawHref, finalUrl);
        if (!link || seen.has(link)) continue;
        seen.add(link);

        const server = classifyServer(text, link);
        if (!allowed.has(server)) continue;       // skip work for servers we don't want
        if (isBlocked(link)) continue;

        const base = { server, quality: meta.quality, size: meta.size, name: meta.name };

        try {
            if (server === 'Pixeldrain') {
                results.push(...await pixelDrainExtractor(link, meta));
            } else if (server === 'BuzzServer') {
                const r = await axios.get(`${link}/download`, {
                    httpsAgent: agent, timeout: CONFIG.timeout,
                    headers: { ...HEADERS, Referer: link },
                    maxRedirects: 0, validateStatus: s => s >= 200 && s < 400,
                });
                const dl = r.headers['hx-redirect'];
                if (dl) results.push({ ...base, source: 'BuzzServer', url: new URL(link).origin + dl });
            } else if (server === '10Gbps') {
                const finalLink = await followRedirectForLink(link);
                if (finalLink) results.push({ ...base, source: '10Gbps', url: finalLink });
            } else {
                // FSL / S3 / Download File — these hrefs are already the direct file URLs
                const label = { FSL: 'FSL', S3: 'S3', DownloadFile: 'HubCloud' }[server] || server;
                results.push({ ...base, source: label, url: link });
            }
        } catch (e) {
            console.error(`[HubCloud] ${server} failed:`, e.message);
        }
    }

    return results.filter(r => !isBlocked(r.url));
}

// =================================================================================
// SITE LOGIC
// =================================================================================

async function search(query) {
    const domain = await getCurrentDomain();
    const { data } = await get(`${domain}/?s=${encodeURIComponent(query)}`);
    const $ = cheerio.load(data);

    return $('.recent-movies > li.thumb').map((_, el) => {
        const e = $(el);
        return {
            title: e.find('figcaption:nth-child(2) > a:nth-child(1) > p:nth-child(1)').text().trim(),
            url: e.find('figure:nth-child(1) > a:nth-child(2)').attr('href'),
            poster: e.find('figure:nth-child(1) > img:nth-child(1)').attr('src'),
        };
    }).get().filter(r => r.url);
}

const QUALITY_RE = /480|720|1080|2160|4K/i;
const isRedirector = href => !!href && (href.includes('techyboy4u') || href.includes('?id='));

async function getDownloadLinks(mediaUrl) {
    const domain = await getCurrentDomain();
    HEADERS.Referer = `${domain}/`;

    const { data } = await get(mediaUrl);
    const $ = cheerio.load(data);

    const isMovie = $('h1.page-title span').text().toLowerCase().includes('movie');
    const initialLinks = [];

    if (isMovie) {
        $('h3 a, h4 a').each((_, el) => {
            if (QUALITY_RE.test($(el).text())) {
                initialLinks.push({ url: $(el).attr('href'), quality: qualityFrom($(el).text()) });
            }
        });
    } else {
        const episodeMap = new Map();
        const addEp = (ep, href) => {
            if (!href) return;
            if (!episodeMap.has(ep)) episodeMap.set(ep, []);
            episodeMap.get(ep).push(href);
        };

        // Quality-pack redirectors that lead to a page full of episode links
        $('h3 a, h4 a').each((_, el) => {
            const href = $(el).attr('href');
            if (QUALITY_RE.test($(el).text()) && isRedirector(href)) {
                initialLinks.push({ url: href, isQualityRedirect: true, quality: qualityFrom($(el).text()) });
            }
        });

        // Episodes listed inline in h4 ("EPiSODE 1" / "E01")
        $('h4').each((_, el) => {
            const m = $(el).text().match(/(?:EPiSODE\s*(\d+)|\bE(\d+))/i);
            if (!m) return;
            const ep = parseInt(m[1] || m[2], 10);
            $(el).find('a').each((__, a) => addEp(ep, $(a).attr('href')));
        });

        // Fallback: walk h3/h4 blocks and their following siblings
        if (episodeMap.size === 0) {
            for (const el of $('h3, h4').get()) {
                const $el = $(el);
                const m = $el.text().match(/(?:EPiSODE\s*(\d+)|\bE(\d+))/i);
                const ep = m ? parseInt(m[1] || m[2], 10) : null;
                const isPackBlock = QUALITY_RE.test($el.find('a').text());

                if (isPackBlock) {
                    for (const href of $el.find('a').map((_, a) => $(a).attr('href')).get()) {
                        try {
                            const resolved = await getRedirectLinks(href);
                            if (!resolved) continue;
                            const page = await get(resolved);
                            const $$ = cheerio.load(page.data);
                            $$('h5 a').each((_, a) => {
                                const em = $$(a).text().match(/Episode\s*(\d+)/i);
                                if (em) addEp(parseInt(em[1], 10), $$(a).attr('href'));
                            });
                        } catch (e) {
                            console.error(`Error resolving pack block ${href}:`, e.message);
                        }
                    }
                } else if (ep) {
                    $el.find('a').each((_, a) => addEp(ep, $(a).attr('href')));
                    let next = $el.next();
                    while (next.length && !['hr', 'h3', 'h4'].includes(next.get(0).tagName)) {
                        next.find('a').each((_, a) => addEp(ep, $(a).attr('href')));
                        next = next.next();
                    }
                }
            }
        }

        episodeMap.forEach((hrefs, ep) => {
            [...new Set(hrefs)].forEach(url => initialLinks.push({ url, episode: ep }));
        });
    }

    // De-dupe + drop junk before touching the network
    const seenInitial = new Set();
    const toProcess = initialLinks.filter(l => {
        if (!l.url || isBlocked(l.url) || seenInitial.has(l.url)) return false;
        seenInitial.add(l.url);
        return true;
    });

    console.log(`Found ${toProcess.length} initial hoster links. Now extracting...`);

    const results = await mapLimit(toProcess, CONFIG.concurrency, async (info) => {
        try {
            if (info.isQualityRedirect) {
                const resolved = await getRedirectLinks(info.url);
                if (!resolved) return [];
                const page = await get(resolved);
                const $$ = cheerio.load(page.data);

                const eps = [];
                $$('h5 a').each((_, a) => {
                    const em = $$(a).text().match(/Episode\s*(\d+)/i);
                    const href = $$(a).attr('href');
                    if (em && href) eps.push({ url: href, episode: parseInt(em[1], 10) });
                });
                $$('h3 a').each((_, a) => {
                    const href = $$(a).attr('href');
                    const text = $$(a).text().toLowerCase();
                    if (href && !href.includes('magnet:') && !href.includes('.zip') && !text.includes('pack')) {
                        eps.push({ url: href, episode: null });
                    }
                });

                const nested = await mapLimit(eps, CONFIG.concurrency, async (ep) => {
                    const out = await loadExtractor(ep.url, resolved, { quality: info.quality });
                    return out.map(l => ({ ...l, episode: ep.episode }));
                });
                return nested.flat();
            }
            const out = await loadExtractor(info.url, mediaUrl, { quality: info.quality });
            return out.map(l => ({ ...l, episode: info.episode }));
        } catch (e) {
            console.error(`Failed to extract from ${info.url}:`, e.message);
            return [];
        }
    });

    const seenUrls = new Set();
    const finalLinks = results.flat().filter(l => {
        if (!l.url || isBlocked(l.url)) return false;
        if (/\.zip(\?|$)/i.test(l.url) || /\.zip$/i.test(l.name || '')) return false;
        if (seenUrls.has(l.url)) return false;
        seenUrls.add(l.url);
        return true;
    });

    return { finalLinks, isMovie };
}

// =================================================================================
// DISPLAY
// =================================================================================
function printLink(l) {
    const size = l.size ? `[${formatBytes(l.size)}] ` : '';
    const name = l.name ? `- ${l.name.slice(0, 80)} ` : '';
    console.log(`  [${String(l.quality).padEnd(7)}] [${l.source}] ${size}${name}- ${l.url}`);
}

function filterAndDisplayLinks(links, groupByEpisode) {
    const allowed = new Set(CONFIG.allowedServers);
    const rank = s => { const i = CONFIG.allowedServers.indexOf(s); return i === -1 ? 99 : i; };
    const qVal = q => { const m = String(q).match(/\d+/); return m ? parseInt(m[0], 10) : 0; };

    const list = links
        .filter(l => allowed.has(l.server) && !isBlocked(l.url))
        .sort((a, b) =>
            ((a.episode || 0) - (b.episode || 0)) ||
            (qVal(b.quality) - qVal(a.quality)) ||
            (rank(a.server) - rank(b.server)));

    if (!list.length) {
        console.log(`\nNo ${CONFIG.allowedServers.join('/')} links found.`);
        return;
    }

    console.log(`\nExtracted ${list.length} links (${CONFIG.allowedServers.join(' + ')}):`);

    if (groupByEpisode) {
        let current;
        for (const l of list) {
            const ep = l.episode ?? 'Unknown';
            if (ep !== current) { console.log(`\n--- Episode ${ep} ---`); current = ep; }
            printLink(l);
        }
    } else {
        list.forEach(printLink);
    }
}

// =================================================================================
// CLI
// =================================================================================
function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

async function askNumber(question, min = 1) {
    while (true) {
        const n = parseInt(await ask(question), 10);
        if (!isNaN(n) && n >= min) return n;
        console.log(`Please enter a number >= ${min}.`);
    }
}

async function main() {
    console.log('HDHub4u Scraper started...');
    await getCurrentDomain();

    const showName = await ask('Enter the name of the movie or TV show: ');
    if (!showName) return console.log('No show name provided. Exiting.');

    const type = (await ask('Is this a TV show or movie? (tv/movie): ')).toLowerCase();
    const isTv = /^(tv|show|series)/.test(type);

    let query = showName, season = null, episode = null;

    if (isTv) {
        season = await askNumber('Enter season number: ');
        const which = await ask('Specific episode or all? (specific/all, or an episode number): ');
        const direct = parseInt(which, 10);
        if (!isNaN(direct) && direct > 0) episode = direct;
        else if (which.toLowerCase().startsWith('s')) episode = await askNumber('Enter episode number: ');
        query = `${showName} season ${season}`;
    }

    console.log(`\nSearching for "${query}"...`);
    const results = await search(query);
    if (!results.length) return console.log('No results found.');

    console.log(`\nFound ${results.length} results:`);
    results.forEach((r, i) => console.log(`  ${i + 1}. ${r.title}`));

    const lowerName = showName.toLowerCase();
    const best = results.find(r => {
        const t = r.title.toLowerCase();
        if (!t.includes(lowerName)) return false;
        return !isTv || t.includes(`season ${season}`) || new RegExp(`\\bs0?${season}\\b`).test(t);
    }) || results[0];
    console.log(`\n--> Selected: "${best.title}"\nURL: ${best.url}`);

    const { finalLinks } = await getDownloadLinks(best.url);

    if (isTv && episode) {
        const epLinks = finalLinks.filter(l => l.episode === episode);
        if (!epLinks.length) {
            const avail = [...new Set(finalLinks.map(l => l.episode).filter(Boolean))].sort((a, b) => a - b);
            console.log(`\nNo links for Episode ${episode}.` + (avail.length ? ` Available: ${avail.join(', ')}` : ''));
            return;
        }
        filterAndDisplayLinks(epLinks, false);
    } else {
        filterAndDisplayLinks(finalLinks, isTv);
    }
}

main().catch(err => console.error('\nAn unexpected error occurred:', err));
