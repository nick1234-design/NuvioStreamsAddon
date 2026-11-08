// Cinejoy provider for Nuvio Streams Addon (Node.js)
// Exports getCinejoyStreams(tmdbId, mediaType, season, episode)

// Use global fetch (Node 18+) and fall back to node-fetch for older runtimes.
const fetch = (...args) =>
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch(...args)
    : import('node-fetch').then(({ default: f }) => f(...args));


var BASE_URL = "https://cinejoy.pk";
var API_BASE = ["https://api.wing.st", "https://api.shegu.st"];
var TMDB_API = "https://api.themoviedb.org/3";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
var SERVER_NAME = "Nebula";

function getTmdbKey() {
  return process.env.TMDB_API_KEY || "";
}

// ---------------------------------------------------------------- TMDB

function fetchTmdbMediaDetails(tmdbId, mediaType) {
  var key = getTmdbKey();
  if (!key) return Promise.resolve(null);
  var type = mediaType === "tv" ? "tv" : "movie";
  var url = TMDB_API + "/" + type + "/" + tmdbId +
    "?api_key=" + encodeURIComponent(key) + "&append_to_response=external_ids";
  return fetch(url, { headers: { "Accept": "application/json", "User-Agent": UA } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (p) {
      if (!p) return null;
      var title = type === "tv" ? (p.name || p.original_name) : (p.title || p.original_title);
      var date = type === "tv" ? p.first_air_date : p.release_date;
      return {
        title: title || "",
        year: date ? String(date).slice(0, 4) : "",
        imdbId: (p.external_ids && p.external_ids.imdb_id) || ""
      };
    })
    .catch(function () { return null; });
}

// ---------------------------------------------------------------- byte helpers

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64ToBytes(input) {
  var s = String(input || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+\/]/g, "");
  var out = new Uint8Array(Math.floor(s.length * 3 / 4));
  var o = 0, buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    buf = (buf << 6) | B64.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== "undefined") {
    try { return new TextDecoder("utf-8").decode(bytes); } catch (e) {}
  }
  var out = "", i = 0;
  while (i < bytes.length) {
    var c = bytes[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      var cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

// ---------------------------------------------------------------- AES

var AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
]);

function xtime(x) { return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff; }

function expandKey(key) {
  var nk = key.length / 4;
  var rounds = nk + 6;
  var w = new Array(4 * (rounds + 1));
  var i;
  for (i = 0; i < nk; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
  var rcon = 1;
  for (i = nk; i < w.length; i++) {
    var t = w[i - 1].slice();
    if (i % nk === 0) {
      t = [AES_SBOX[t[1]], AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
      t[0] ^= rcon;
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t = [AES_SBOX[t[0]], AES_SBOX[t[1]], AES_SBOX[t[2]], AES_SBOX[t[3]]];
    }
    var p = w[i - nk];
    w[i] = [p[0] ^ t[0], p[1] ^ t[1], p[2] ^ t[2], p[3] ^ t[3]];
  }
  return { w: w, rounds: rounds };
}

function addRoundKey(s, w, r) {
  for (var c = 0; c < 4; c++) {
    var k = w[r * 4 + c];
    s[c * 4] ^= k[0]; s[c * 4 + 1] ^= k[1]; s[c * 4 + 2] ^= k[2]; s[c * 4 + 3] ^= k[3];
  }
}

function subShift(s) {
  var t = new Uint8Array(16);
  var map = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
  for (var i = 0; i < 16; i++) t[i] = AES_SBOX[s[map[i]]];
  s.set(t);
}

function mixColumns(s) {
  for (var o = 0; o < 16; o += 4) {
    var a = s[o], b = s[o + 1], c = s[o + 2], d = s[o + 3];
    s[o] = xtime(a) ^ xtime(b) ^ b ^ c ^ d;
    s[o + 1] = a ^ xtime(b) ^ xtime(c) ^ c ^ d;
    s[o + 2] = a ^ b ^ xtime(c) ^ xtime(d) ^ d;
    s[o + 3] = xtime(a) ^ a ^ b ^ c ^ xtime(d);
  }
}

function aesEncryptBlock(block, ks) {
  var s = Uint8Array.from(block);
  addRoundKey(s, ks.w, 0);
  for (var r = 1; r < ks.rounds; r++) {
    subShift(s);
    mixColumns(s);
    addRoundKey(s, ks.w, r);
  }
  subShift(s);
  addRoundKey(s, ks.w, ks.rounds);
  return s;
}

// ---------------------------------------------------------------- GHASH (32-bit words, no BigInt)

function bytesToWords(b, off) {
  return [
    ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0,
    ((b[off + 4] << 24) | (b[off + 5] << 16) | (b[off + 6] << 8) | b[off + 7]) >>> 0,
    ((b[off + 8] << 24) | (b[off + 9] << 16) | (b[off + 10] << 8) | b[off + 11]) >>> 0,
    ((b[off + 12] << 24) | (b[off + 13] << 16) | (b[off + 14] << 8) | b[off + 15]) >>> 0
  ];
}

function wordsToBytes(w) {
  var out = new Uint8Array(16);
  for (var i = 0; i < 4; i++) {
    out[i * 4] = (w[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (w[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (w[i] >>> 8) & 0xff;
    out[i * 4 + 3] = w[i] & 0xff;
  }
  return out;
}

function gfMul(x, h) {
  var z0 = 0, z1 = 0, z2 = 0, z3 = 0;
  var v0 = h[0], v1 = h[1], v2 = h[2], v3 = h[3];
  for (var i = 0; i < 128; i++) {
    var word = x[i >> 5];
    if ((word >>> (31 - (i & 31))) & 1) {
      z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3;
    }
    var lsb = v3 & 1;
    v3 = ((v3 >>> 1) | (v2 << 31)) >>> 0;
    v2 = ((v2 >>> 1) | (v1 << 31)) >>> 0;
    v1 = ((v1 >>> 1) | (v0 << 31)) >>> 0;
    v0 = v0 >>> 1;
    if (lsb) v0 = (v0 ^ 0xe1000000) >>> 0;
  }
  return [z0 >>> 0, z1 >>> 0, z2 >>> 0, z3 >>> 0];
}

function ghashUpdate(acc, h, data) {
  var buf = new Uint8Array(16);
  for (var i = 0; i < data.length; i += 16) {
    buf.fill(0);
    buf.set(data.subarray(i, Math.min(i + 16, data.length)));
    var bw = bytesToWords(buf, 0);
    acc = gfMul([(acc[0] ^ bw[0]) >>> 0, (acc[1] ^ bw[1]) >>> 0, (acc[2] ^ bw[2]) >>> 0, (acc[3] ^ bw[3]) >>> 0], h);
  }
  return acc;
}

function incCounter(c) {
  var n = Uint8Array.from(c);
  for (var i = 15; i >= 12; i--) {
    n[i] = (n[i] + 1) & 0xff;
    if (n[i]) break;
  }
  return n;
}

function aesGcmDecrypt(data, key, iv, aad) {
  if (iv.length !== 12 || data.length < 16) throw new Error("Invalid AES-GCM input");
  var ks = expandKey(key);
  var h = bytesToWords(aesEncryptBlock(new Uint8Array(16), ks), 0);
  var j0 = new Uint8Array(16);
  j0.set(iv);
  j0[15] = 1;
  var body = data.subarray(0, data.length - 16);
  var tag = data.subarray(data.length - 16);

  var acc = [0, 0, 0, 0];
  acc = ghashUpdate(acc, h, aad);
  acc = ghashUpdate(acc, h, body);

  // length block: [aadBits(64) || bodyBits(64)], lengths fit in 32 bits here
  var aadBits = aad.length * 8, bodyBits = body.length * 8;
  var lenWords = [
    Math.floor(aadBits / 4294967296) >>> 0, aadBits >>> 0,
    Math.floor(bodyBits / 4294967296) >>> 0, bodyBits >>> 0
  ];
  acc = gfMul([(acc[0] ^ lenWords[0]) >>> 0, (acc[1] ^ lenWords[1]) >>> 0, (acc[2] ^ lenWords[2]) >>> 0, (acc[3] ^ lenWords[3]) >>> 0], h);

  var ghash = wordsToBytes(acc);
  var ek = aesEncryptBlock(j0, ks);
  var diff = 0;
  for (var i = 0; i < 16; i++) diff |= tag[i] ^ (ek[i] ^ ghash[i]);
  if (diff !== 0) throw new Error("aes-gcm: invalid tag");

  var out = new Uint8Array(body.length);
  var ctr = incCounter(j0);
  for (var off = 0; off < body.length; off += 16) {
    var ksb = aesEncryptBlock(ctr, ks);
    var n = Math.min(16, body.length - off);
    for (var k = 0; k < n; k++) out[off + k] = body[off + k] ^ ksb[k];
    ctr = incCounter(ctr);
  }
  return out;
}

function decryptSealedResponse(bytes, session) {
  var iv = bytes.slice(0, 12);
  var ct = bytes.slice(12);
  return utf8Decode(aesGcmDecrypt(ct, session.responseKey, iv, session.aad));
}

// ---------------------------------------------------------------- sealed session

function createEncryptedSession(p) {
  var url = "https://api.shegu.xyz/?type=" + (p.isTv ? "series" : "movie") +
    "&tmdb=" + p.tmdbId + "&server=" + p.server;
  if (p.isTv) url += "&season=" + p.season + "&episode=" + p.episode;
  if (p.title) url += "&title=" + encodeURIComponent(p.title);
  if (p.year) url += "&year=" + p.year;
  if (p.imdbId) url += "&imdb=" + p.imdbId;

  return fetch("https://enc-dec.app/api/enc-cinejoy?url=" + encodeURIComponent(url), {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  })
    .then(function (res) {
      if (!res.ok) throw new Error("enc-dec API HTTP " + res.status);
      return res.json();
    })
    .then(function (j) {
      if (j.status !== 200 || !j.result) throw new Error(j.error || "Failed to seal via enc-dec API");
      return {
        body: decodeBase64ToBytes(j.result.data),
        responseKey: decodeBase64ToBytes(j.result.state.responseKey),
        aad: decodeBase64ToBytes(j.result.state.aad)
      };
    });
}

// ---------------------------------------------------------------- stream parsing

function extractHlsVariants(text, masterUrl) {
  var variants = [];
  var lines = text.split("\n");
  var pending = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
      var m = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      pending = { height: m ? Number(m[2]) : 0 };
    } else if (line && line.charAt(0) !== "#" && pending) {
      var u = line;
      if (line.indexOf("http") !== 0) {
        try { u = new URL(line, masterUrl).toString(); }
        catch (e) { u = masterUrl.replace(/[^\/]*$/, "") + line; }
      }
      variants.push({ height: pending.height, url: u });
      pending = null;
    }
  }
  return variants;
}

function normalizeQualityLabel(raw) {
  var n = String(raw || "").toLowerCase();
  if (n.indexOf("2160") !== -1 || n.indexOf("4k") !== -1) return "4K";
  if (n.indexOf("1080") !== -1 || n.indexOf("fhd") !== -1) return "1080p";
  return "Auto";
}

function normalizeSubtitleTracks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(function (t) {
    return {
      url: t && typeof t.url === "string" ? t.url.trim() : "",
      language: String((t && (t.language || t.id)) || "en").toLowerCase(),
      name: String((t && (t.language || t.id)) || "Subtitle")
    };
  }).filter(function (t) { return t.url; });
}

function makeStream(url, quality, headers, subs, format) {
  var formatLabel = format ? " [" + format + "]" : "";
  var titleFormat = format ? " • " + format : "";
  var s = {
    name: "Cinejoy " + SERVER_NAME + " - " + quality + formatLabel,
    title: "Cinejoy \u2022 " + SERVER_NAME + "\n" + quality + titleFormat,
    url: url,
    quality: quality,
    headers: headers,
    provider: "Cinejoy",
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: headers }
    }
  };
  if (subs.length) s.subtitles = subs;
  return s;
}

function resolveStreamItems(items, headers) {
  var tasks = (Array.isArray(items) ? items : [])
    .filter(function (it) { return it && typeof it === "object"; })
    .map(function (item) {
      var subs = normalizeSubtitleTracks(item.captions);

      if (item.type === "hls" && item.playlist) {
        return fetch(item.playlist, { headers: headers })
          .then(function (r) { return r.ok ? r.text() : ""; })
          .then(function (text) {
            var out = [];
            extractHlsVariants(text, item.playlist).forEach(function (v) {
              if (v.height !== 2160 && v.height !== 1080) return;
              out.push(makeStream(v.url, v.height === 2160 ? "4K" : "1080p", headers, subs, "HLS"));
            });
            return out;
          })
          .catch(function () { return []; });
      }

      if (item.type === "file" && item.qualities && typeof item.qualities === "object") {
        var out = [];
        Object.keys(item.qualities).forEach(function (k) {
          var q = item.qualities[k];
          var u = q && q.url;
          if (!u || String(u).indexOf("http") !== 0) return;
          var label = normalizeQualityLabel(k);
          if (label === "Auto") return;
          out.push(makeStream(u, label, headers, subs));
        });
        return Promise.resolve(out);
      }

      return Promise.resolve([]);
    });

  return Promise.all(tasks).then(function (groups) {
    var seen = {};
    var result = [];
    groups.forEach(function (g) {
      g.forEach(function (s) {
        if (seen[s.url]) return;
        seen[s.url] = true;
        result.push(s);
      });
    });
    // best quality first
    result.sort(function (a, b) { return (a.quality === "4K" ? 0 : 1) - (b.quality === "4K" ? 0 : 1); });
    return result;
  });
}

// ---------------------------------------------------------------- entry point

function postToApi(body) {
  var opts = {
    method: "POST",
    body: body,
    headers: {
      "Content-Type": "application/octet-stream",
      "Origin": BASE_URL,
      "Referer": BASE_URL + "/",
      "User-Agent": UA
    }
  };
  var idx = 0;
  function attempt() {
    if (idx >= API_BASE.length) return Promise.resolve(null);
    var endpoint = API_BASE[idx++];
    return fetch(endpoint + "/g", opts)
      .then(function (r) { return r.ok ? r : attempt(); })
      .catch(function () { return attempt(); });
  }
  return attempt();
}

function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var id = String(tmdbId || "").trim();
    var type = String(mediaType || "").toLowerCase().trim();
    if (!/^\d+$/.test(id) || (type !== "movie" && type !== "tv")) return Promise.resolve([]);
    if (type === "tv" && (season == null || episode == null)) return Promise.resolve([]);

    var s = type === "tv" ? Number(season) : 1;
    var e = type === "tv" ? Number(episode) : 1;
    if (type === "tv" && (!(s >= 1) || !(e >= 1) || s % 1 !== 0 || e % 1 !== 0)) return Promise.resolve([]);

    var session;
    return fetchTmdbMediaDetails(id, type)
      .then(function (d) {
        return createEncryptedSession({
          server: SERVER_NAME,
          isTv: type === "tv",
          tmdbId: id,
          season: s,
          episode: e,
          title: (d && d.title) || "",
          year: (d && d.year) || "",
          imdbId: (d && d.imdbId) || ""
        });
      })
      .then(function (sess) {
        session = sess;
        return postToApi(sess.body);
      })
      .then(function (res) { return res ? res.arrayBuffer() : null; })
      .then(function (buf) {
        if (!buf) return [];
        var json = JSON.parse(decryptSealedResponse(new Uint8Array(buf), session));
        var headers = { "Origin": BASE_URL, "Referer": BASE_URL + "/", "User-Agent": UA };
        return resolveStreamItems(json && json.data && json.data.stream, headers);
      })
      .catch(function (err) {
        console.log("[Cinejoy] " + (err && err.message ? err.message : err));
        return [];
      });
  } catch (err) {
    return Promise.resolve([]);
  }
}

module.exports = { getCinejoyStreams: getStreams, getStreams };
