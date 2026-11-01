"use strict";
// Standalone HDHub4u provider.
// Public API: getStreams(title, year, isSeries, season, episode) -> Promise<Stream[]>
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// --- Shared helpers copied from the combined provider (needed by HDHub4u) ---
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

function fetchText(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    const retries = options.retries !== void 0 ? options.retries : 2;
    const delay = options.delay !== void 0 ? options.delay : 1e3;
    for (let i = 0; i <= retries; i++) {
      try {
        const response = yield fetch(url, {
          headers: __spreadValues({
            "User-Agent": USER_AGENT
          }, options.headers)
        });
        return yield response.text();
      } catch (err) {
        console.log(`[HDHub4u] Request failed for ${url}: ${err.message}${i < retries ? `, retrying (${i + 1}/${retries})...` : ""}`);
      }
      if (i < retries) {
        yield new Promise((r) => setTimeout(r, delay * Math.pow(2, i)));
      }
    }
    return null;
  });
}

function atob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let str = String(input).replace(/=+$/, "");
  if (str.length % 4 === 1) {
    throw new Error("'atob' failed: The string to be decoded is not correctly encoded.");
  }
  let output = "";
  for (let bc = 0, bs, buffer, i = 0; buffer = str.charAt(i++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer);
  }
  return output;
}

function rot13Cipher(str) {
  return str.replace(/[a-zA-Z]/g, function(c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}

function levenshteinDistance(s, t) {
  if (s === t)
    return 0;
  const n = s.length;
  const m = t.length;
  if (n === 0)
    return m;
  if (m === 0)
    return n;
  const d = [];
  for (let i = 0; i <= n; i++) {
    d[i] = [];
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[n][m];
}

function parseBytes(val) {
  if (typeof val === "number")
    return val;
  if (!val)
    return 0;
  const match = val.match(/^([0-9.]+)\s*([a-zA-Z]+)$/);
  if (!match)
    return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  let multiplier = 1;
  if (unit.indexOf("k") === 0)
    multiplier = 1024;
  else if (unit.indexOf("m") === 0)
    multiplier = 1024 * 1024;
  else if (unit.indexOf("g") === 0)
    multiplier = 1024 * 1024 * 1024;
  else if (unit.indexOf("t") === 0)
    multiplier = 1024 * 1024 * 1024 * 1024;
  return num * multiplier;
}

function formatBytes(val) {
  if (val === 0)
    return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.floor(Math.log(val) / Math.log(k));
  if (i < 0)
    i = 0;
  return parseFloat((val / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

var cheerio2 = require("cheerio-without-node-native");

function extractHubCloud(hubCloudUrl, baseMeta) {
  return __async(this, null, function* () {
    if (!hubCloudUrl)
      return [];
    const redirectHtml = yield fetchText(hubCloudUrl, { headers: { Referer: hubCloudUrl } });
    if (!redirectHtml)
      return [];
    const redirectUrlMatch = redirectHtml.match(/var url ?= ?'(.*?)'/);
    let linksHtml;
    if (redirectUrlMatch) {
      const finalLinksUrl = redirectUrlMatch[1];
      linksHtml = yield fetchText(finalLinksUrl, { headers: { Referer: hubCloudUrl } });
    } else if (/hubcloud\.php/i.test(hubCloudUrl)) {
      // hubcloud.php URLs already are the links page (no "var url" hop). Previously returned [].
      linksHtml = redirectHtml;
    } else {
      return [];
    }
    if (!linksHtml)
      return [];
    const $ = cheerio2.load(linksHtml);
    const results = [];
    const sizeText = $("#size").text();
    const titleText = $("title").text().trim();
    const currentMeta = __spreadProps(__spreadValues({}, baseMeta), {
      bytes: parseBytes(sizeText) || baseMeta.bytes,
      title: titleText || baseMeta.title
    });

    // Updated detector: PixelDrain and FSL are checked before other link types.
    $("a").each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href");

      if (!href) return;

      const label = text.toLowerCase();
      const link = href.toLowerCase();

      const pixelMatch = href.match(
        /pixeldrain\.(?:com|net)\/(?:u|api\/file)\/([a-z0-9_-]+)/i
      );

      if (pixelMatch) {
        results.push({
          source: "PixelDrain",
          url: `https://pixeldrain.com/api/file/${pixelMatch[1]}`,
          meta: currentMeta
        });
      } else if (label.includes("fsl") || link.includes("fsl")) {
        results.push({
          source: "FSL",
          url: href,
          meta: currentMeta
        });
      } else if (
        label.includes("10gbps") ||
        label.includes("pixelserver") ||
        link.includes("hubcloud.cx")
      ) {
        results.push({
          source: "HubCloud 10Gbps",
          url: href,
          meta: currentMeta
        });
      } else if (label.includes("download file") || link.includes("r2.dev")) {
        results.push({
          source: "Direct R2",
          url: href,
          meta: currentMeta
        });
      } else if (label.includes("zipdisk") || link.includes("workers.dev")) {
        results.push({
          source: "ZipDisk Server",
          url: href,
          meta: currentMeta
        });
      }
    });

    return results;
  });
}

// =====================================================================
// HDHub4u source
// =====================================================================
var cheerioHd = require("cheerio-without-node-native");
var HDHUB4U_DEFAULT_URL = "https://new9.hdhub4u.cl";
var HDHUB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
var HDHUB_REQUEST_TIMEOUT = 15e3;
var HDHUB_OVERALL_TIMEOUT = 3e4;
var HDHUB_BLOCK_COOLDOWN = 3e5;
var HDHUB_MAX_DEPTH = 4;
var HDHUB_BATCH_SIZE = 4;
var hdhubState = { base: HDHUB4U_DEFAULT_URL, blockedUntil: 0 };

function hdhubLog(msg) {
  console.log(`[HDHub4u] ${msg}`);
}

function hdhubHeaders(referer) {
  return {
    "User-Agent": HDHUB_UA,
    "Cookie": "xla=s4t",
    "Referer": referer || `${hdhubState.base}/`
  };
}

// Minimal base64 encoder (the runtime may not provide btoa/Buffer).
function hdhubBtoa(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const s = String(input);
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const hasB = i + 1 < s.length;
    const hasC = i + 2 < s.length;
    const n = (s.charCodeAt(i) & 255) << 16 | (hasB ? s.charCodeAt(i + 1) & 255 : 0) << 8 | (hasC ? s.charCodeAt(i + 2) & 255 : 0);
    out += chars.charAt(n >> 18 & 63) + chars.charAt(n >> 12 & 63) + (hasB ? chars.charAt(n >> 6 & 63) : "=") + (hasC ? chars.charAt(n & 63) : "=");
  }
  return out;
}

function hdhubAbsUrl(href, base) {
  if (!href)
    return null;
  try {
    const u = new URL(String(href).trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch (e) {
    return null;
  }
}

function hdhubHeightFromText(text) {
  if (!text)
    return 0;
  const m = String(text).match(/(\d{3,4})p/i);
  if (m)
    return parseInt(m[1]);
  if (/4k|2160/i.test(text))
    return 2160;
  return 0;
}

// fetch() with a timeout that also aborts the request when AbortController exists.
function hdhubFetchWithTimeout(url, init, ms) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (finished)
        return;
      finished = true;
      if (controller) {
        try {
          controller.abort();
        } catch (e) {
        }
      }
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
    const opts = controller ? __spreadProps(__spreadValues({}, init), { signal: controller.signal }) : init;
    fetch(url, opts).then((r) => {
      if (finished)
        return;
      finished = true;
      clearTimeout(timer);
      resolve(r);
    }, (e) => {
      if (finished)
        return;
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Resolve with `fallback` if the promise takes too long or rejects.
function hdhubWithTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        console.log(`[HDHub4u] Timed out after ${ms}ms, returning empty result`);
        resolve(fallback);
      }
    }, ms);
    Promise.resolve(promise).then((v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    }, () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    });
  });
}

function hdhubLooksLikeCloudflare(status, headers, body) {
  let mitigated = "";
  let server = "";
  try {
    mitigated = headers && headers.get ? headers.get("cf-mitigated") || "" : "";
    server = headers && headers.get ? headers.get("server") || "" : "";
  } catch (e) {
  }
  if (/challenge/i.test(mitigated))
    return true;
  const text = typeof body === "string" ? body.slice(0, 20000) : "";
  if (/<title>\s*(?:Just a moment|Attention Required)|cf-browser-verification|challenge-platform|cf_chl_opt|Checking your browser before accessing|Enable JavaScript and cookies to continue/i.test(text))
    return true;
  if ((status === 403 || status === 503) && /cloudflare/i.test(server) && /cloudflare/i.test(text))
    return true;
  return false;
}

// Small stub pages that only redirect via <meta refresh> or window.location.
function hdhubFindClientRedirect(html, baseUrl) {
  if (!html || html.length > 3e3)
    return null;
  const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i) || html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i) || html.match(/(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
  return m ? hdhubAbsUrl(m[1], baseUrl) : null;
}

// Never throws. Returns { ok, status, url, text, blocked, error }.
// HTTP redirects are followed by fetch(); result.url is the final URL.
function fetchPage(url, options = {}) {
  return __async(this, null, function* () {
    const retries = options.retries !== void 0 ? options.retries : 1;
    const timeout = options.timeout || HDHUB_REQUEST_TIMEOUT;
    const result = { ok: false, status: 0, url, text: "", blocked: false, error: null };
    for (let i = 0; i <= retries; i++) {
      try {
        const response = yield hdhubFetchWithTimeout(url, {
          headers: __spreadValues({
            "User-Agent": HDHUB_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"
          }, options.headers),
          redirect: "follow"
        }, timeout);
        const text = yield response.text();
        result.status = response.status;
        result.url = response.url || url;
        result.text = text;
        if (hdhubLooksLikeCloudflare(response.status, response.headers, text)) {
          result.blocked = true;
          result.error = "Cloudflare challenge";
          return result;
        }
        if (response.ok) {
          result.ok = true;
          result.error = null;
          if (options.followClientRedirect && !options._hop) {
            const next = hdhubFindClientRedirect(text, result.url);
            if (next && next !== result.url) {
              hdhubLog(`Following client-side redirect to ${next}`);
              return yield fetchPage(next, __spreadProps(__spreadValues({}, options), { _hop: 1 }));
            }
          }
          return result;
        }
        result.error = `HTTP ${response.status}`;
        if (response.status < 500)
          return result;
      } catch (err) {
        result.error = err && err.message ? err.message : String(err);
      }
      if (i < retries) {
        yield new Promise((r) => setTimeout(r, 800 * Math.pow(2, i)));
      }
    }
    return result;
  });
}

function hdhubAdoptOrigin(finalUrl) {
  try {
    const u = new URL(finalUrl);
    if (/hdhub4u/i.test(u.hostname) && u.origin !== hdhubState.base) {
      hdhubLog(`Domain redirect detected: ${hdhubState.base} -> ${u.origin}`);
      hdhubState.base = u.origin;
    }
  } catch (e) {
  }
}

function hdhubMarkBlocked(what) {
  hdhubState.blockedUntil = Date.now() + HDHUB_BLOCK_COOLDOWN;
  hdhubLog(`Cloudflare challenge on ${what}; skipping HDHub4u for ${Math.round(HDHUB_BLOCK_COOLDOWN / 6e4)} min`);
}

function hdhubMapInBatches(items, size, fn) {
  return __async(this, null, function* () {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
      const batch = items.slice(i, i + size);
      const res = yield Promise.all(batch.map((item) => fn(item).then(null, (e) => {
        hdhubLog(`Task failed: ${e && e.message}`);
        return [];
      })));
      for (const r of res)
        out.push(r);
    }
    return out;
  });
}

// ---------------------------------------------------------------------
// Search + matching
// ---------------------------------------------------------------------
function hdhubSearch(query) {
  return __async(this, null, function* () {
    const searchUrl = `${hdhubState.base}/?s=${encodeURIComponent(query)}`;
    hdhubLog(`Search URL: ${searchUrl}`);
    const resp = yield fetchPage(searchUrl, { headers: hdhubHeaders(`${hdhubState.base}/`), followClientRedirect: true });
    if (resp.blocked) {
      hdhubMarkBlocked("search");
      return null;
    }
    if (!resp.ok) {
      hdhubLog(`Search failed: ${resp.error}`);
      return [];
    }
    hdhubAdoptOrigin(resp.url);
    const base = resp.url || hdhubState.base;
    const $ = cheerioHd.load(resp.text);
    let results = [];
    const push = (title, href) => {
      const url = hdhubAbsUrl(href, base);
      if (title && url)
        results.push({ title: title.replace(/\s+/g, " ").trim(), url });
    };
    // Layout 1: WordPress figcaption cards (primary)
    $("figcaption").each((_, el) => {
      const linkEl = $(el).find("a").first();
      push(linkEl.find("p").text().trim() || linkEl.text().trim(), linkEl.attr("href"));
    });
    // Layout 2: thumbnail wrappers
    if (results.length === 0) {
      $(".thumbnail-wrapper, .thumb-wrapper, li.thumb").each((_, el) => {
        const linkEl = $(el).find("figcaption a, a").first();
        push(linkEl.find("p").text().trim() || linkEl.text().trim(), linkEl.attr("href"));
      });
    }
    // Layout 3: movie-grid cards
    if (results.length === 0) {
      $("ul.movie-grid li.movie-card, ul#results-grid li.movie-card").each((_, el) => {
        const linkEl = $(el).find("> a").first();
        push(linkEl.find("h3.movie-title").text().trim() || linkEl.find("h3").text().trim(), linkEl.attr("href"));
      });
    }
    // Layout 4: generic article/post markup
    if (results.length === 0) {
      $("article, .post, .result-item, .search-result").each((_, el) => {
        const titleEl = $(el).find("h3 a, h2 a, .entry-title a, a.title").first();
        push(titleEl.text().trim() || $(el).find("h3, h2, .entry-title").first().text().trim(), titleEl.attr("href") || $(el).find("a").first().attr("href"));
      });
    }
    const seen = {};
    results = results.filter((r) => {
      if (seen[r.url])
        return false;
      seen[r.url] = true;
      return true;
    });
    hdhubLog(`Parsed ${results.length} search results`);
    return results;
  });
}

function hdhubNormalize(s) {
  return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

// Result titles look like "Name (2024) WEB-DL [Hindi + English] 1080p 720p ...",
// so compare only the leading part. Several cut points are tried because a title
// may legitimately contain words like "English".
function hdhubTitleCandidates(title, isSeries, year) {
  const s = String(title || "").replace(/^\s*download\s+/i, "").trim();
  const seasonCut = isSeries ? "|\\s+(?:season|s\\d{1,2})\\b" : "";
  const noiseWords = "\\s+(?:hindi|english|dual|multi|tamil|telugu|bluray|blu-ray|web-?dl|webrip|hdrip|brrip|hdtc|hdcam|dvdrip|uncut|complete)\\b";
  const cutters = [
    new RegExp("\\s*[\\(\\[]" + seasonCut, "i"),
    new RegExp("\\s*[\\(\\[]" + seasonCut + "|" + noiseWords, "i")
  ];
  const out = [];
  const add = (v) => {
    const n = hdhubNormalize(v);
    if (n && out.indexOf(n) === -1)
      out.push(n);
  };
  for (const re of cutters) {
    const idx = s.search(re);
    const base = idx > 0 ? s.slice(0, idx) : s;
    add(base);
    const m = base.match(/^(.*\S)\s+((?:19|20)\d{2})\s*$/);
    if (m && year && Math.abs(parseInt(m[2]) - year) <= 1)
      add(m[1]);
  }
  return out;
}

function hdhubYearStatus(title, year) {
  if (!year)
    return "skip";
  const years = String(title).match(/\b(?:19|20)\d{2}\b/g);
  if (!years)
    return "none";
  for (const y of years) {
    if (Math.abs(parseInt(y) - year) <= 1)
      return "ok";
  }
  return "bad";
}

// 2 = exact season, 1 = inside a season range, 0.5 = no season marker (season 1 only), null = other season
function hdhubSeasonScore(title, season) {
  const t = String(title);
  if (new RegExp(`(?:season|\\bs)\\s*0*${season}(?!\\d)`, "i").test(t))
    return 2;
  const range = t.match(/season\s*0*(\d+)\s*(?:-|\u2013|to)\s*(?:season\s*|s)?0*(\d+)/i);
  if (range && parseInt(range[1]) <= season && season <= parseInt(range[2]))
    return 1;
  if (!/season\s*\d+|\bs\d{1,2}\b/i.test(t) && Number(season) === 1)
    return 0.5;
  return null;
}

function hdhubPickResult(results, name, year, isSeries, season) {
  const normName = hdhubNormalize(name);
  if (!normName)
    return null;
  const tolerance = Math.min(4, Math.floor(normName.length * 0.2));
  let best = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    let dist = Infinity;
    for (const cand of hdhubTitleCandidates(r.title, isSeries, year)) {
      dist = Math.min(dist, levenshteinDistance(cand, normName));
    }
    if (dist > tolerance) {
      continue;
    }
    let seasonScore = 0;
    if (isSeries) {
      seasonScore = hdhubSeasonScore(r.title, season);
      if (seasonScore === null) {
        continue;
      }
    } else {
      const ys = hdhubYearStatus(r.title, year);
      if (ys === "bad" || ys === "none" && dist !== 0) {
        continue;
      }
    }
    const rank = [-seasonScore, dist, i];
    if (!best || rank[0] < best.rank[0] || rank[0] === best.rank[0] && (rank[1] < best.rank[1] || rank[1] === best.rank[1] && rank[2] < best.rank[2])) {
      best = { result: r, rank };
    }
  }
  return best ? best.result : null;
}

function hdhubFindPage(title, year, isSeries, season) {
  return __async(this, null, function* () {
    const queries = [title];
    if (isSeries)
      queries.push(`${title} season ${season}`);
    else if (year)
      queries.push(`${title} ${year}`);
    for (const q of queries) {
      const results = yield hdhubSearch(q);
      if (results === null)
        return null;
      const hit = hdhubPickResult(results, title, year, isSeries, season);
      if (hit) {
        hdhubLog(`Matched "${hit.title}" -> ${hit.url}`);
        return hit.url;
      }
      hdhubLog(`No matching result among ${results.length} for query "${q}"`);
    }
    return null;
  });
}

// ---------------------------------------------------------------------
// Redirector (techyboy4u / ?id=) resolution
// ---------------------------------------------------------------------
// HDHub4u splits the payload across several s('o','...') / ck('_wp_http_N','...')
// calls, so ALL chunks are concatenated before decoding.
function resolveHdhubRedirect(url, referer) {
  return __async(this, null, function* () {
    const resp = yield fetchPage(url, { headers: hdhubHeaders(referer) });
    if (resp.blocked) {
      hdhubLog(`Redirector blocked by Cloudflare: ${url}`);
      return null;
    }
    if (!resp.ok) {
      hdhubLog(`Redirector request failed (${resp.error}): ${url}`);
      return null;
    }
    const doc = resp.text;
    if (doc.trim() === "Invalid Link !!") {
      hdhubLog(`Redirector says "Invalid Link": ${url}`);
      return null;
    }
    const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    let combined = "";
    let m;
    while ((m = regex.exec(doc)) !== null) {
      combined += m[1] || m[2] || "";
    }
    if (!combined) {
      hdhubLog(`No encoded payload found on redirector page: ${url}`);
      return null;
    }
    let data;
    try {
      data = JSON.parse(atob(rot13Cipher(atob(atob(combined)))));
    } catch (e) {
      hdhubLog(`Could not decode redirector payload: ${e.message}`);
      return null;
    }
    try {
      const direct = atob(data.o || "").trim();
      if (/^https?:\/\//i.test(direct))
        return direct;
    } catch (e) {
    }
    const encodedData = hdhubBtoa(data.data || "").trim();
    const blogUrl = String(data.blog_url || "").trim();
    if (blogUrl && encodedData) {
      const second = yield fetchPage(`${blogUrl}?re=${encodedData}`, { headers: hdhubHeaders(referer) });
      if (second.ok) {
        const text = cheerioHd.load(second.text)("body").text().trim();
        if (/^https?:\/\//i.test(text))
          return text;
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------------
// Link extraction. HubCloud pages are handed to the existing extractHubCloud().
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// HubCloud extractor ported from the working Node extractor
// (fetch + cheerio instead of https + jsdom). Selectors and per-server
// handling (FSL, Download File, BuzzServer, PixelDrain, S3, 10Gbps) are kept.
// ---------------------------------------------------------------------
function getIndexQuality(str) {
    const match = (str || '').match(/(\d{3,4})[pP]/);
    return match ? parseInt(match[1]) : 2160;
}

function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        return '';
    }
}

function cleanTitle(title) {
    const parts = title.split(/[.\-_]/);

    const qualityTags = ['WEBRip', 'WEB-DL', 'WEB', 'BluRay', 'HDRip', 'DVDRip', 'HDTV', 'CAM', 'TS', 'R5', 'DVDScr', 'BRRip', 'BDRip', 'DVD', 'PDTV', 'HD'];
    const audioTags = ['AAC', 'AC3', 'DTS', 'MP3', 'FLAC', 'DD5', 'EAC3', 'Atmos'];
    const subTags = ['ESub', 'ESubs', 'Subs', 'MultiSub', 'NoSub', 'EnglishSub', 'HindiSub'];
    const codecTags = ['x264', 'x265', 'H264', 'HEVC', 'AVC'];

    const startIndex = parts.findIndex(part => 
        qualityTags.some(tag => part.toLowerCase().includes(tag.toLowerCase()))
    );

    const endIndex = parts.map((part, index) => {
        const hasTag = [...subTags, ...audioTags, ...codecTags].some(tag => 
            part.toLowerCase().includes(tag.toLowerCase())
        );
        return hasTag ? index : -1;
    }).filter(index => index !== -1).pop() || -1;

    if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        return parts.slice(startIndex, endIndex + 1).join('.');
    } else if (startIndex !== -1) {
        return parts.slice(startIndex).join('.');
    } else {
        return parts.slice(-3).join('.');
    }
}

// Single request that must NOT follow redirects (BuzzServer / 10Gbps need the Location header).
function hdhubNoRedirectGet(url, headers) {
  return __async(this, null, function* () {
    const response = yield hdhubFetchWithTimeout(url, {
      headers: __spreadValues({ "User-Agent": HDHUB_UA }, headers),
      redirect: "manual"
    }, HDHUB_REQUEST_TIMEOUT);
    return { status: response.status, headers: response.headers, url: response.url || url };
  });
}

// Header value if present; otherwise, if the runtime followed the redirect itself, the final URL.
function hdhubRedirectTarget(res, requested, names) {
  for (const n of names) {
    let v = null;
    try {
      v = res.headers && res.headers.get ? res.headers.get(n) : null;
    } catch (e) {
    }
    if (v)
      return v;
  }
  if (res.url && res.url !== requested)
    return res.url;
  return null;
}

function extractHubCloudLinks(url, referer, baseMeta) {
  return __async(this, null, function* () {
    baseMeta = baseMeta || { bytes: 0, height: 0, title: "" };
    try {
      const baseUrl = getBaseUrl(url);
      let href;
      if (url.includes("hubcloud.php")) {
        href = url;
      } else {
        const first = yield fetchPage(url, { headers: { Referer: url } });
        if (first.blocked || !first.text) {
          hdhubLog(`HubCloud page failed (${first.error}): ${url}`);
          return [];
        }
        const $first = cheerioHd.load(first.text);
        const downloadElement = $first("#download");
        if (!downloadElement.length) {
          const alternatives = ['a[href*="hubcloud.php"]', ".download-btn", 'a[href*="download"]'];
          for (const selector of alternatives) {
            const rawAlt = $first(selector).first().attr("href");
            if (rawAlt) {
              href = rawAlt.startsWith("http") ? rawAlt : `${baseUrl.replace(/\/$/, "")}/${rawAlt.replace(/^\//, "")}`;
              break;
            }
          }
          if (!href)
            throw new Error("Download element not found with any selector");
        } else {
          const rawHref = downloadElement.attr("href");
          if (!rawHref)
            throw new Error("Download href not found");
          href = rawHref.startsWith("http") ? rawHref : `${baseUrl.replace(/\/$/, "")}/${rawHref.replace(/^\//, "")}`;
        }
      }
      const page = yield fetchPage(href, { headers: { Referer: url } });
      if (page.blocked || !page.text) {
        hdhubLog(`HubCloud download page failed (${page.error}): ${href}`);
        return [];
      }
      const $ = cheerioHd.load(page.text);
      const size = $("i#size").text().trim();
      const header = $("div.card-header").text();
      const quality = getIndexQuality(header);
      const headerDetails = cleanTitle(header);
      const linkMeta = {
        bytes: parseBytes(size) || baseMeta.bytes || 0,
        height: baseMeta.height || 0,
        title: headerDetails || header.trim() || baseMeta.title || ""
      };
      const buttons = $("div.card-body h2 a.btn").get();
      hdhubLog(`HubCloud: ${buttons.length} download buttons (${size || "no size"})`);
      const handleButton = (button) => __async(this, null, function* () {
        const link = $(button).attr("href");
        const text = $(button).text();
        if (!link)
          return null;
        const buttonBaseUrl = getBaseUrl(link);
        if (text.includes("FSL Server")) {
          return { source: "FSL Server", url: link, quality, meta: linkMeta };
        } else if (text.includes("Download File")) {
          return { source: referer, url: link, quality, meta: linkMeta };
        } else if (text.includes("BuzzServer")) {
          const res = yield hdhubNoRedirectGet(`${link}/download`, { Referer: link });
          const redirectUrl = hdhubRedirectTarget(res, `${link}/download`, ["hx-redirect", "location"]);
          if (!redirectUrl)
            return null;
          const finalUrl = /^https?:\/\//i.test(redirectUrl) ? redirectUrl : buttonBaseUrl + redirectUrl;
          return { source: "BuzzServer", url: finalUrl, quality, meta: linkMeta };
        } else if (link.includes("pixeldra")) {
          const pm = link.match(/pixeldrain\.(?:com|net|dev)\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/i);
          const pixelUrl = pm && /\/u\//i.test(link) ? `https://pixeldrain.com/api/file/${pm[1]}` : link;
          return { source: "PixelDrain", url: pixelUrl, quality, meta: linkMeta };
        } else if (text.includes("S3 Server")) {
          return { source: "S3 Server", url: link, quality, meta: linkMeta };
        } else if (text.includes("10Gbps")) {
          let currentLink = link;
          for (let hop = 0; hop < 10; hop++) {
            const res = yield hdhubNoRedirectGet(currentLink, {});
            const redirectUrl = hdhubRedirectTarget(res, currentLink, ["location"]);
            if (!redirectUrl)
              throw new Error("No redirect found");
            if (redirectUrl.includes("id=")) {
              const finalLink = redirectUrl.split("link=")[1];
              if (finalLink)
                return { source: "10Gbps", url: decodeURIComponent(finalLink), quality, meta: linkMeta };
              throw new Error("Final link not found");
            }
            currentLink = hdhubAbsUrl(redirectUrl, currentLink) || redirectUrl;
          }
          return null;
        }
        return { source: text.trim() || referer, url: link, quality, meta: linkMeta };
      });
      const results = yield Promise.all(buttons.map((b) => handleButton(b).then(null, (e) => {
        hdhubLog(`HubCloud button failed: ${e && e.message}`);
        return null;
      })));
      return results.filter((r) => r !== null);
    } catch (error) {
      hdhubLog(`HubCloud extraction error for ${url}: ${error.message}`);
      return [];
    }
  });
}

// New extractor first; the original HDHub4u extractHubCloud() stays as a fallback.
function hdhubExtractHubCloud(url, meta) {
  return __async(this, null, function* () {
    const attempt = (u) => __async(this, null, function* () {
      let r = yield extractHubCloudLinks(u, "HubCloud", meta);
      if (r.length === 0)
        r = yield extractHubCloud(u, meta);
      return r;
    });
    let results = yield attempt(url);
    if (results.length === 0 && /hubcloud\.ink/i.test(url)) {
      results = yield attempt(url.replace(/hubcloud\.ink/i, "hubcloud.dad"));
    }
    return results;
  });
}

function extractHdhubLink(url, meta, referer, depth) {
  return __async(this, null, function* () {
    if (!url || depth > HDHUB_MAX_DEPTH)
      return [];
    let hostname = "";
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return [];
    }
    if (hostname.includes("hubcloud")) {
      return yield hdhubExtractHubCloud(url, meta);
    }
    if (hostname.includes("hubdrive")) {
      const resp = yield fetchPage(url, { headers: { Referer: referer || url } });
      if (!resp.ok) {
        hdhubLog(`HubDrive page failed (${resp.error}): ${url}`);
        return [];
      }
      const $ = cheerioHd.load(resp.text);
      let href = $(".btn.btn-primary.btn-user.btn-success1.m-1").attr("href");
      if (!href) {
        href = $("a").filter((_, a) => {
          const text = $(a).text();
          const h = $(a).attr("href") || "";
          return text.includes("HubCloud") || h.includes("hubcloud.") || h.includes("hubcloud/");
        }).attr("href");
      }
      if (!href) {
        for (const selector of ["a.btn.btn-primary", ".btn-primary", 'a[href*="download"]', "a.btn"]) {
          const alt = $(selector).first().attr("href");
          if (alt) {
            href = alt;
            break;
          }
        }
      }
      const next = hdhubAbsUrl(href, resp.url || url);
      return next ? yield extractHdhubLink(next, meta, url, depth + 1) : [];
    }
    if (hostname.includes("hubcdn")) {
      const resp = yield fetchPage(url, { headers: { Referer: referer || url } });
      if (!resp.ok)
        return [];
      const m = resp.text.match(/r=([A-Za-z0-9+/=]+)/);
      if (!m)
        return [];
      try {
        const decoded = atob(m[1]);
        const idx = decoded.lastIndexOf("link=");
        const link = idx >= 0 ? decoded.substring(idx + 5) : "";
        if (/^https?:\/\//i.test(link))
          return [{ source: "HubCdn", url: link, meta }];
      } catch (e) {
      }
      return [];
    }
    if (hostname.includes("hblinks")) {
      const resp = yield fetchPage(url, { headers: { Referer: referer || url } });
      if (!resp.ok)
        return [];
      const $ = cheerioHd.load(resp.text);
      const hrefs = [];
      $("h3 a, div.entry-content p a").each((_, a) => {
        const abs = hdhubAbsUrl($(a).attr("href"), resp.url || url);
        if (abs && hrefs.indexOf(abs) === -1)
          hrefs.push(abs);
      });
      const nested = yield hdhubMapInBatches(hrefs, HDHUB_BATCH_SIZE, (h) => extractHdhubLink(h, meta, url, depth + 1));
      return nested.reduce((acc, v) => acc.concat(v), []);
    }
    if (hostname.includes("pixeldrain")) {
      const m = url.match(/pixeldrain\.(?:com|net|dev)\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/i);
      return m ? [{ source: "PixelDrain", url: `https://pixeldrain.com/api/file/${m[1]}`, meta }] : [];
    }
    if (url.includes("?id=") || hostname.includes("techyboy4u")) {
      const resolved = yield resolveHdhubRedirect(url, referer);
      if (!resolved || resolved === url)
        return [];
      return yield extractHdhubLink(resolved, meta, url, depth + 1);
    }
    if (/\.(?:mp4|mkv|avi)(?:$|\?)/i.test(url))
      return [{ source: "Direct Link", url, meta }];
    hdhubLog(`Skipping unsupported host: ${hostname}`);
    return [];
  });
}

// ---------------------------------------------------------------------
// Page parsing
// ---------------------------------------------------------------------
function hdhubCollectMovieCandidates($, pageUrl) {
  const out = [];
  const seen = {};
  $("h3 a, h4 a").each((_, a) => {
    const text = $(a).text().replace(/\s+/g, " ").trim();
    const url = hdhubAbsUrl($(a).attr("href"), pageUrl);
    if (!url || seen[url] || !/480|720|1080|2160|4K/i.test(text))
      return;
    seen[url] = true;
    out.push({ url, title: text, height: hdhubHeightFromText(text), referer: pageUrl });
  });
  return out;
}

function hdhubCollectSeriesCandidates($, pageUrl, episode) {
  return __async(this, null, function* () {
    const epRegex = /EPiSODE\s*(\d+)|\bE(\d+)\b|S\d+E(\d+)/i;
    const epOf = (text) => {
      const m = String(text).match(epRegex);
      return m ? parseInt(m[1] || m[2] || m[3]) : null;
    };
    const direct = [];
    const qualityPages = [];
    const seenDirect = {};
    const seenQuality = {};
    const addDirect = (href, text, fallbackText) => {
      const url = hdhubAbsUrl(href, pageUrl);
      if (!url || seenDirect[url])
        return;
      seenDirect[url] = true;
      const t = String(text || "").replace(/\s+/g, " ").trim();
      direct.push({ url, title: t || String(fallbackText || "").trim(), height: hdhubHeightFromText(t) || hdhubHeightFromText(fallbackText), referer: pageUrl });
    };
    const addQuality = (href, text) => {
      const url = hdhubAbsUrl(href, pageUrl);
      if (!url || seenQuality[url])
        return;
      seenQuality[url] = true;
      const t = String(text || "").replace(/\s+/g, " ").trim();
      qualityPages.push({ url, title: t, height: hdhubHeightFromText(t) });
    };
    // (a) per-quality redirect pages that list every episode
    $("h3 a, h4 a").each((_, a) => {
      const text = $(a).text();
      const href = $(a).attr("href") || "";
      if (/1080|720|4K|2160/i.test(text) && href.includes("techyboy4u.com"))
        addQuality(href, text);
    });
    // (b) <h4> rows labelled with an episode number
    let anyEpisode = false;
    $("h4").each((_, h) => {
      const hText = $(h).text();
      const ep = epOf(hText);
      if (ep === null)
        return;
      anyEpisode = true;
      if (ep !== episode)
        return;
      $(h).find("a").each((_2, a) => addDirect($(a).attr("href"), $(a).text(), hText));
    });
    // (c) fallback layout when no <h4> carries an episode number
    if (!anyEpisode) {
      $("h3, h4").each((_, h) => {
        const $h = $(h);
        const linkText = $h.find("a").text();
        if (/1080|720|4K|2160/i.test(linkText)) {
          $h.find("a").each((_2, a) => addQuality($(a).attr("href"), $(a).text()));
          return;
        }
        if (epOf($h.text()) !== episode)
          return;
        $h.find("a").each((_2, a) => addDirect($(a).attr("href"), $(a).text(), $h.text()));
        let next = $h.next();
        while (next.length) {
          const tag = String(next.get(0).tagName || next.get(0).name || "").toLowerCase();
          if (tag === "hr" || tag === "h3" || tag === "h4")
            break;
          next.find("a").each((_2, a) => addDirect($(a).attr("href"), $(a).text(), $h.text()));
          next = next.next();
        }
      });
    }
    hdhubLog(`Series page: ${direct.length} direct episode links, ${qualityPages.length} quality pages (episode ${episode})`);
    const fromPages = yield hdhubMapInBatches(qualityPages, HDHUB_BATCH_SIZE, (qp) => hdhubEpisodesFromQualityPage(qp, pageUrl, episode));
    return direct.concat(fromPages.reduce((acc, v) => acc.concat(v), []));
  });
}

function hdhubEpisodesFromQualityPage(qp, pageUrl, episode) {
  return __async(this, null, function* () {
    const resolved = yield resolveHdhubRedirect(qp.url, pageUrl);
    if (!resolved || resolved === qp.url)
      return [];
    const resp = yield fetchPage(resolved, { headers: hdhubHeaders(pageUrl) });
    if (!resp.ok) {
      hdhubLog(`Quality page failed (${resp.error}): ${resolved}`);
      return [];
    }
    const $ = cheerioHd.load(resp.text);
    const out = [];
    const seen = {};
    $("h5 a").each((_, a) => {
      const m = $(a).text().match(/Episode\s*(\d+)/i);
      const url = hdhubAbsUrl($(a).attr("href"), resp.url || resolved);
      if (m && parseInt(m[1]) === episode && url && !seen[url]) {
        seen[url] = true;
        out.push({ url, title: qp.title, height: qp.height, referer: resolved });
      }
    });
    return out;
  });
}

// ---------------------------------------------------------------------
// Entry point for the HDHub4u source
// ---------------------------------------------------------------------
function hdhubProcessCandidate(cand) {
  return __async(this, null, function* () {
    const meta = { bytes: 0, height: cand.height || 0, title: cand.title || "" };
    const links = yield extractHdhubLink(cand.url, meta, cand.referer, 0);
    return links.filter((l) => l && l.url && !/\.zip(?:$|\?)/i.test(l.url)).map((link) => {
      const linkMeta = link.meta || meta;
      const height = cand.height || hdhubHeightFromText(linkMeta.title) || link.quality || 0;
      return {
        name: `HDHub4u - ${link.source}${height ? ` ${height}p` : ""}`,
        title: `${linkMeta.title}
${formatBytes(linkMeta.bytes || 0)}`,
        url: link.url,
        quality: height ? `${height}p` : void 0,
        behaviorHints: {
          bingeGroup: `hdhub4u-${link.source}`
        }
      };
    });
  });
}

function getStreamsHDHub4u(title, year, isSeries, season, episode) {
  return __async(this, null, function* () {
    if (Date.now() < hdhubState.blockedUntil) {
      hdhubLog("Skipping (recent Cloudflare block)");
      return [];
    }
    if (isSeries && (!season || !episode)) {
      hdhubLog("Series request without season/episode, skipping");
      return [];
    }
    hdhubLog(`Search: ${title} (${year})`);
    const pageUrl = yield hdhubFindPage(title, year, isSeries, season);
    if (!pageUrl) {
      hdhubLog("Page not found");
      return [];
    }
    const page = yield fetchPage(pageUrl, { headers: hdhubHeaders(`${hdhubState.base}/`), followClientRedirect: true });
    if (page.blocked) {
      hdhubMarkBlocked("content page");
      return [];
    }
    if (!page.ok) {
      hdhubLog(`Content page failed: ${page.error}`);
      return [];
    }
    hdhubAdoptOrigin(page.url);
    const $ = cheerioHd.load(page.text);
    const pageBase = page.url || pageUrl;
    const candidates = isSeries ? yield hdhubCollectSeriesCandidates($, pageBase, Number(episode)) : hdhubCollectMovieCandidates($, pageBase);
    hdhubLog(`Processing ${candidates.length} candidate links`);
    if (candidates.length === 0)
      return [];
    const nested = yield hdhubMapInBatches(candidates, HDHUB_BATCH_SIZE, hdhubProcessCandidate);
    const seen = {};
    const streams = [];
    for (const group of nested) {
      for (const s of group) {
        if (seen[s.url])
          continue;
        seen[s.url] = true;
        streams.push(s);
      }
    }
    hdhubLog(`Returning ${streams.length} streams`);
    return streams;
  });
}

// ---------------------------------------------------------------------
// Nuvio entry point
// ---------------------------------------------------------------------
var TMDB_API_KEY = (typeof process !== "undefined" && process.env && process.env.TMDB_API_KEY) || "0c3d05751e190fc2c3bef2f653b98d54";

function getTmdbDetails(tmdbId, type) {
  return __async(this, null, function* () {
    const isSeries = type === "series" || type === "tv";
    const endpoint = isSeries ? "tv" : "movie";
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    console.log(`[HDHub4u] Fetching TMDB details from: ${url}`);
    try {
      const response = yield fetch(url);
      const data = yield response.json();
      if (isSeries) {
        return {
          title: data.name,
          year: data.first_air_date ? parseInt(data.first_air_date.split("-")[0]) : 0
        };
      } else {
        return {
          title: data.title,
          year: data.release_date ? parseInt(data.release_date.split("-")[0]) : 0
        };
      }
    } catch (error) {
      console.log(`[HDHub4u] TMDB request failed: ${error.message}`);
      return null;
    }
  });
}

// Nuvio calls getStreams(tmdbId, mediaType, season, episode); mediaType is "movie" or "tv".
function getStreams(tmdbId, type, season, episode) {
  return __async(this, null, function* () {
    const tmdbDetails = yield getTmdbDetails(tmdbId, type);
    if (!tmdbDetails)
      return [];
    const { title, year } = tmdbDetails;
    const isSeries = type === "series" || type === "tv";
    return yield hdhubWithTimeout(getStreamsHDHub4u(title, year, isSeries, season, episode).then(null, (err) => {
      console.log(`[HDHub4u] Source error: ${err && err.message}`);
      return [];
    }), HDHUB_OVERALL_TIMEOUT, []);
  });
}

module.exports = { getStreams, getStreamsHDHub4u };
