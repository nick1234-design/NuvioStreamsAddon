'use strict';

const client = require('./client');
const {
  parseQualityListHtml,
  extractCodecDetails,
  sortStreamsByQuality,
  parseSizeToBytes,
  matchesEpisode,
} = require('./parser');
const { FebBoxError } = require('./types');
const { validateDirectUrl } = require('./urlValidate');

const PLAYBACK_MODE = {
  DIRECT: 'direct',
  EXPERIMENTAL_HLS: 'experimental-hls',
  BOTH: 'both',
};

const DEFAULT_PLAYBACK_MODE = PLAYBACK_MODE.DIRECT;
const PLAYBACK_MODE_VALUES = new Set(Object.values(PLAYBACK_MODE));
const INCLUDES_DIRECT = new Set([
  PLAYBACK_MODE.DIRECT,
  PLAYBACK_MODE.BOTH,
]);
const INCLUDES_HLS = new Set([
  PLAYBACK_MODE.EXPERIMENTAL_HLS,
  PLAYBACK_MODE.BOTH,
]);

const MAX_RECURSION_DEPTH = 4;
const REQUEST_SPACING_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listAllFiles(
  { token, shareKey },
  parentId = 0,
  depth = 0
) {
  if (depth > MAX_RECURSION_DEPTH) return [];

  const entries = await client.listShareFiles({
    token,
    shareKey,
    parentId,
  });

  let all = [];

  for (const entry of entries) {
    if (entry.isDir) {
      await sleep(REQUEST_SPACING_MS);

      all = all.concat(
        await listAllFiles(
          { token, shareKey },
          entry.fid,
          depth + 1
        )
      );
    } else {
      all.push(entry);
    }
  }

  return all;
}

async function listTopLevel({ token, shareKey }) {
  return client.listShareFiles({
    token,
    shareKey,
    parentId: 0,
  });
}

function isHlsUrl(url) {
  return /\.m3u8(\?|$)/i.test(url || '');
}

function toStream(l, fileName, { isHls }) {
  const sizeBytes = parseSizeToBytes(l.size);

  return {
    url: l.url,
    quality: l.quality,
    size: l.size,
    videoSizeBytes:
      Number.isFinite(sizeBytes) &&
      sizeBytes < Number.MAX_SAFE_INTEGER
        ? sizeBytes
        : undefined,
    codecs: extractCodecDetails(
      fileName || l.name || ''
    ),
    filename: fileName || l.name || 'video',
    provider: 'FebBox',
    isHls,
  };
}

function sortWithDirectFirst(streams) {
  const direct = sortStreamsByQuality(
    streams.filter((s) => !s.isHls)
  );

  const hls = sortStreamsByQuality(
    streams.filter((s) => s.isHls)
  );

  return [...direct, ...hls];
}

async function resolveFileStreams({
  token,
  shareKey,
  fid,
  fileName,
  playbackMode = DEFAULT_PLAYBACK_MODE,
}) {
  const html = await client.getVideoQualityLinks({
    token,
    shareKey,
    fid,
  });

  const allLinks = parseQualityListHtml(html);

  const directCandidates = allLinks.filter(
    (l) => !isHlsUrl(l.url)
  );

  const hlsCandidates = allLinks.filter(
    (l) => isHlsUrl(l.url)
  );

  const streams = [];

  if (INCLUDES_DIRECT.has(playbackMode)) {
    for (const l of directCandidates) {
      const check = await validateDirectUrl(l.url);

      if (check.valid) {
        streams.push(
          toStream(l, fileName, {
            isHls: false,
          })
        );
      }
    }
  }

  if (INCLUDES_HLS.has(playbackMode)) {
    for (const l of hlsCandidates) {
      streams.push(
        toStream(l, fileName, {
          isHls: true,
        })
      );
    }
  }

  if (streams.length === 0) {
    throw new FebBoxError(
      'No playable sources returned for this file',
      'NOT_FOUND'
    );
  }

  return sortWithDirectFirst(streams);
}

async function resolveMovie({
  token,
  shareKey,
  playbackMode = DEFAULT_PLAYBACK_MODE,
}) {
  const files = await listAllFiles({
    token,
    shareKey,
  });

  const videoFiles = files.filter((f) =>
    isLikelyVideo(f.name)
  );

  if (videoFiles.length === 0) {
    throw new FebBoxError(
      'No video files found in this FebBox share',
      'NOT_FOUND'
    );
  }

  const results = [];

  for (const f of videoFiles) {
    try {
      const streams = await resolveFileStreams({
        token,
        shareKey,
        fid: f.fid,
        fileName: f.name,
        playbackMode,
      });

      results.push(...streams);
    } catch (err) {
      continue;
    }

    await sleep(REQUEST_SPACING_MS);
  }

  return sortWithDirectFirst(results);
}

const SEASON_FOLDER_RE =
  /season[^0-9]{0,3}0*(\d+)\b/i;

async function resolveEpisode({
  token,
  shareKey,
  season,
  episode,
  playbackMode = DEFAULT_PLAYBACK_MODE,
}) {
  const top = await listTopLevel({
    token,
    shareKey,
  });

  const seasonFolder = top.find((e) => {
    if (!e.isDir) return false;

    const m = SEASON_FOLDER_RE.exec(
      e.name || ''
    );

    return (
      m &&
      Number(m[1]) === Number(season)
    );
  });

  let videoFiles;

  if (seasonFolder) {
    const files = await listAllFiles(
      { token, shareKey },
      seasonFolder.fid,
      1
    );

    videoFiles = files.filter((f) =>
      isLikelyVideo(f.name)
    );
  } else {
    const files = await listAllFiles({
      token,
      shareKey,
    });

    videoFiles = files.filter((f) =>
      isLikelyVideo(f.name)
    );
  }

  const matches = videoFiles.filter((f) =>
    matchesEpisode(
      f.name,
      season,
      episode
    )
  );

  if (matches.length === 0) {
    throw new FebBoxError(
      `No files matching S${season}E${episode} found in this FebBox share`,
      'NOT_FOUND'
    );
  }

  const results = [];

  for (const f of matches) {
    try {
      const streams = await resolveFileStreams({
        token,
        shareKey,
        fid: f.fid,
        fileName: f.name,
        playbackMode,
      });

      results.push(...streams);
    } catch (err) {
      continue;
    }

    await sleep(REQUEST_SPACING_MS);
  }

  return sortWithDirectFirst(results);
}

function isLikelyVideo(name) {
  return /\.(mp4|mkv|avi|mov|webm|m3u8|ts)$/i.test(
    String(name || '')
  );
}

function extractShareKey(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();

  const m = trimmed.match(
    /febbox\.com\/share\/([A-Za-z0-9_-]+)/i
  );

  if (m) return m[1];

  if (/^[A-Za-z0-9_-]{4,40}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

module.exports = {
  resolveMovie,
  resolveEpisode,
  resolveFileStreams,
  listAllFiles,
  extractShareKey,
  isLikelyVideo,
  isHlsUrl,
  sortWithDirectFirst,
  PLAYBACK_MODE,
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_MODE_VALUES,
};