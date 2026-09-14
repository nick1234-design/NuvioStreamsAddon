'use strict';

const axios = require('axios');
const { toCookieHeader, isPlausibleToken } = require('./auth');
const { FebBoxError } = require('./types');

const redactError = (err) => ({
  message: err && err.message ? err.message : 'Unknown error'
});

const incrementCounter = () => {};

const METRIC = {
  FEBBOX_RATE_LIMITED: 'FEBBOX_RATE_LIMITED'
};

const FEBBOX_ORIGIN = 'https://www.febbox.com';

const ALLOWED_HOSTS = new Set([
  'www.febbox.com'
]);

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_RETRIES = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyStatus(status) {
  if (status === 401 || status === 403) {
    return 'AUTH_INVALID';
  }

  if (status === 404) {
    return 'NOT_FOUND';
  }

  if (status === 429) {
    return 'RATE_LIMITED';
  }

  if (status >= 500) {
    return 'UPSTREAM_ERROR';
  }

  return 'UPSTREAM_ERROR';
}

async function febboxGet(path, token, options = {}) {
  if (!isPlausibleToken(token)) {
    throw new FebBoxError(
      'Invalid FebBox token',
      'AUTH_INVALID'
    );
  }

  const {
    params = {},
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES
  } = options;

  const url = new URL(path, FEBBOX_ORIGIN).toString();

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        params,
        timeout,
        validateStatus: () => true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*',
          'Referer': `${FEBBOX_ORIGIN}/`,
          'Cookie': toCookieHeader(token)
        }
      });

      if (response.status >= 200 && response.status < 300) {
        return response.data;
      }

      const code = classifyStatus(response.status);

      if (code === 'RATE_LIMITED') {
        incrementCounter(METRIC.FEBBOX_RATE_LIMITED);
      }

      throw new FebBoxError(
        `FebBox request failed with status ${response.status}`,
        code
      );
    } catch (err) {
      lastError = err;

      if (err instanceof FebBoxError) {
        if (
          err.code === 'AUTH_INVALID' ||
          err.code === 'NOT_FOUND' ||
          err.code === 'RATE_LIMITED'
        ) {
          throw err;
        }
      }

      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }

      if (err instanceof FebBoxError) {
        throw err;
      }

      const message = redactError(err).message || 'FebBox request failed';

      throw new FebBoxError(
        message,
        'UPSTREAM_ERROR'
      );
    }
  }

  throw new FebBoxError(
    'FebBox request failed',
    'UPSTREAM_ERROR'
  );
}

async function listShareFiles(
  shareKey,
  token,
  parentId = ''
) {
  const data = await febboxGet(
    '/file/file_share_list',
    token,
    {
      params: {
        share_key: shareKey,
        pwd: '',
        parent_id: parentId,
        is_html: 0
      }
    }
  );

  const list =
    data &&
    data.data &&
    Array.isArray(data.data.file_list)
      ? data.data.file_list
      : [];

  return list.map(file => ({
    fid: String(file.fid || file.id || ''),
    name: file.name || '',
    isDir: Boolean(
      file.is_dir ??
      file.isDir ??
      file.type === 'folder'
    ),
    size:
      file.size !== undefined
        ? String(file.size)
        : undefined,
    raw: undefined
  }));
}

async function getVideoQualityLinks(
  fid,
  token
) {
  const data = await febboxGet(
    '/console/video_quality_list',
    token,
    {
      params: {
        fid
      }
    }
  );

  return data && data.html
    ? data.html
    : '';
}

async function getQuota(token) {
  const data = await febboxGet(
    '/console/user_cards',
    token
  );

  return data && data.data
    ? data.data
    : data;
}

module.exports = {
  listShareFiles,
  getVideoQualityLinks,
  getQuota,
  FEBBOX_ORIGIN
};