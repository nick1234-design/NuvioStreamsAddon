'use strict';

function parseQualityFromLabel(label = '') {
  const text = String(label).toLowerCase();

  if (/\b2160p\b|\b4k\b/.test(text)) return 2160;
  if (/\b1440p\b/.test(text)) return 1440;
  if (/\b1080p\b/.test(text)) return 1080;
  if (/\b720p\b/.test(text)) return 720;
  if (/\b480p\b/.test(text)) return 480;
  if (/\b360p\b/.test(text)) return 360;

  return 0;
}

function extractCodecDetails(text = '') {
  const value = String(text).toLowerCase();

  let codec = '';
  if (value.includes('hevc') || value.includes('h.265') || value.includes('x265')) {
    codec = 'HEVC';
  } else if (value.includes('avc') || value.includes('h.264') || value.includes('x264')) {
    codec = 'H.264';
  } else if (value.includes('av1')) {
    codec = 'AV1';
  }

  return { codec };
}

function parseSizeToBytes(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;

  const text = String(value).trim().toUpperCase();
  const match = text.match(/([\d.]+)\s*(KB|MB|GB|TB)?/);

  if (!match) return 0;

  const number = Number(match[1]);
  const unit = match[2] || 'B';

  const multipliers = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };

  return Math.round(number * (multipliers[unit] || 1));
}

function sortStreamsByQuality(streams = []) {
  return [...streams].sort((a, b) => {
    const qualityA = Number(a?.quality || 0);
    const qualityB = Number(b?.quality || 0);
    return qualityB - qualityA;
  });
}

function parseQualityListHtml(html = '') {
  return String(html);
}

function matchesEpisode(fileName, season, episode) {
  const text = String(fileName || '');

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  const patterns = [
    new RegExp(`S${s}E${e}`, 'i'),
    new RegExp(`S${Number(season)}E${Number(episode)}`, 'i'),
  ];

  return patterns.some((pattern) => pattern.test(text));
}

module.exports = {
  parseQualityFromLabel,
  extractCodecDetails,
  parseSizeToBytes,
  sortStreamsByQuality,
  parseQualityListHtml,
  matchesEpisode,
};