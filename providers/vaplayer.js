// VAplayer provider for Nuvio Streams Addon (Node.js)
// Exports getVAplayerStreams(tmdbId, mediaType, season, episode)

// Use global fetch (Node 18+) and fall back to node-fetch for older runtimes.
const fetch = (...args) =>
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch(...args)
    : import('node-fetch').then(({ default: f }) => f(...args));


var TMDB_API = "https://api.themoviedb.org/3";
var API_BASE = "https://streamdata.vaplayer.ru";
var REFERER = "https://nextgencloudfabric.com/";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
var HEADERS = {
  "User-Agent": UA,
  "Referer": REFERER,
  "Origin": REFERER
};

function getTmdbKey() {
  return process.env.TMDB_API_KEY || "";
}

function fetchImdbId(tmdbId, mediaType) {
  var key = getTmdbKey();
  if (!key) return Promise.resolve(null);
  var type = mediaType === "tv" ? "tv" : "movie";
  var url = TMDB_API + "/" + type + "/" + tmdbId +
    "?api_key=" + encodeURIComponent(key) + "&append_to_response=external_ids";
  return fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      return (data && data.external_ids && data.external_ids.imdb_id) || null;
    })
    .catch(function () { return null; });
}

function collectRawItems(data) {
  var su = data.stream_urls;
  if (Array.isArray(su)) return su;
  if (su && typeof su === "object") {
    return Object.keys(su).map(function (k) { return su[k]; });
  }
  if (data.stream_url) return [data.stream_url];
  return [];
}

function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var type = String(mediaType || "").toLowerCase().trim();
    if (type !== "movie" && type !== "tv") return Promise.resolve([]);
    if (type === "tv" && (season == null || episode == null)) return Promise.resolve([]);

    return fetchImdbId(tmdbId, type)
      .then(function (imdbId) {
        if (!imdbId) return [];

        var url = type === "tv"
          ? API_BASE + "/api.php?imdb=" + imdbId + "&type=tv&season=" + season + "&episode=" + episode
          : API_BASE + "/api.php?imdb=" + imdbId + "&type=movie";

        var reqHeaders = {
          "User-Agent": UA,
          "Referer": REFERER,
          "Origin": REFERER,
          "Accept": "application/json"
        };

        return fetch(url, { headers: reqHeaders })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            if (!data || data.status_code === "error" || !data.data) return [];

            var seen = {};
            var urls = [];
            collectRawItems(data.data).forEach(function (item) {
              var u = "";
              if (typeof item === "string") u = item;
              else if (item && typeof item === "object") u = item.url || item.file || item.src || "";
              if (!u) return;
              var clean = String(u).trim().replace(/\/+$/, "");
              if (!clean || seen[clean]) return;
              seen[clean] = true;
              urls.push(clean);
            });
            if (!urls.length) return [];

            var subs = data.data.default_subs || data.default_subs || [];
            var subtitles = (Array.isArray(subs) ? subs : [])
              .filter(function (s) { return s && s.url; })
              .map(function (s) {
                return {
                  url: s.url,
                  language: s.code || s.lang || "unknown",
                  name: s.lang || s.code || "Unknown"
                };
              });

            return urls.map(function (u) {
              var stream = {
                name: "VAplayer - 1080p",
                title: "VAplayer\n1080p",
                url: u,
                quality: "1080p",
                headers: HEADERS,
                provider: "VAplayer",
                behaviorHints: {
                  notWebReady: true,
                  proxyHeaders: { request: HEADERS }
                }
              };
              if (subtitles.length) stream.subtitles = subtitles;
              return stream;
            });
          });
      })
      .catch(function (err) {
        console.log("[VAplayer] " + (err && err.message ? err.message : err));
        return [];
      });
  } catch (err) {
    return Promise.resolve([]);
  }
}

module.exports = { getVAplayerStreams: getStreams, getStreams };
