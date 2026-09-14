'use strict';

const {
  resolveMovie,
  resolveEpisode
} = require('./febbox/resolver');

/**
 * FebBox direct provider.
 *
 * This provider receives a FebBox share key and uses the
 * FebBox resolver to return direct playable streams.
 */

function normalizeShareKey(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  const match = trimmed.match(
    /febbox\.com\/share\/([A-Za-z0-9_-]+)/i
  );

  if (match) {
    return match[1];
  }

  if (/^[A-Za-z0-9_-]{4,40}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function getTokenFromConfig(config = {}) {
  return (
    config.febboxToken ||
    config.febboxCookie ||
    config.token ||
    config.cookie ||
    null
  );
}

/**
 * Resolve a movie from a FebBox share.
 */
async function getMovieStreams({
  shareKey,
  token,
  config = {}
} = {}) {
  const normalizedShareKey =
    normalizeShareKey(shareKey);

  const febboxToken =
    token || getTokenFromConfig(config);

  if (!normalizedShareKey || !febboxToken) {
    return [];
  }

  try {
    return await resolveMovie({
      token: febboxToken,
      shareKey: normalizedShareKey
    });
  } catch (error) {
    console.error(
      '[FebBoxDirect] Movie resolution failed:',
      error && error.message
        ? error.message
        : error
    );

    return [];
  }
}

/**
 * Resolve a TV episode from a FebBox share.
 */
async function getEpisodeStreams({
  shareKey,
  token,
  season,
  episode,
  config = {}
} = {}) {
  const normalizedShareKey =
    normalizeShareKey(shareKey);

  const febboxToken =
    token || getTokenFromConfig(config);

  if (
    !normalizedShareKey ||
    !febboxToken ||
    season === undefined ||
    episode === undefined
  ) {
    return [];
  }

  try {
    return await resolveEpisode({
      token: febboxToken,
      shareKey: normalizedShareKey,
      season: Number(season),
      episode: Number(episode)
    });
  } catch (error) {
    console.error(
      '[FebBoxDirect] Episode resolution failed:',
      error && error.message
        ? error.message
        : error
    );

    return [];
  }
}

module.exports = {
  normalizeShareKey,
  getMovieStreams,
  getEpisodeStreams
};