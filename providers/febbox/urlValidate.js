'use strict';

const axios = require('axios');

const ALLOWED_HOST_SUFFIXES = ['febbox.com', 'shegu.net'];

const PREFERRED_EXTENSIONS = /\.(mp4|m4v|webm|mkv)(\?|$)/i;

function isAllowedHost(hostname) {
  if (!hostname) return false;

  const h = hostname.toLowerCase();

  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => h === suffix || h.endsWith(`.${suffix}`)
  );
}

function hasPreferredExtension(url) {
  try {
    const u = new URL(url);
    return PREFERRED_EXTENSIONS.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function looksLikeVideoContentType(contentType) {
  if (!contentType) return false;

  const ct = contentType.toLowerCase();

  return (
    ct.startsWith('video/') ||
    ct === 'application/octet-stream'
  );
}

function finalHostOf(resp, fallbackUrl) {
  const responseUrl =
    resp &&
    resp.request &&
    resp.request.res &&
    resp.request.res.responseUrl;

  try {
    return new URL(responseUrl || fallbackUrl).hostname;
  } catch (e) {
    return null;
  }
}

async function validateDirectUrl(url, { timeout = 6000 } = {}) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch (e) {
    return {
      valid: false,
      reason: 'unparsable_url',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: 'not_https',
    };
  }

  if (!hasPreferredExtension(url)) {
    return {
      valid: false,
      reason: 'unsupported_extension',
    };
  }

  if (!isAllowedHost(parsed.hostname)) {
    return {
      valid: false,
      reason: 'host_not_allowed',
    };
  }

  const axiosOpts = {
    timeout,
    maxRedirects: 5,
    validateStatus: () => true,
  };

  try {
    let resp = await axios.head(url, axiosOpts);

    if (
      resp.status === 405 ||
      resp.status === 501 ||
      resp.status >= 400
    ) {
      resp = await axios.get(url, {
        ...axiosOpts,
        headers: {
          Range: 'bytes=0-1023',
        },
      });
    }

    if (!(resp.status >= 200 && resp.status < 400)) {
      return {
        valid: false,
        reason: `bad_status_${resp.status}`,
      };
    }

    const finalHost = finalHostOf(resp, url);

    if (!isAllowedHost(finalHost)) {
      return {
        valid: false,
        reason: 'redirect_host_not_allowed',
      };
    }

    const contentType =
      resp.headers && resp.headers['content-type'];

    if (!looksLikeVideoContentType(contentType)) {
      return {
        valid: false,
        reason: `unexpected_content_type_${contentType || 'none'}`,
      };
    }

    return {
      valid: true,
      contentType,
    };
  } catch (err) {
    return {
      valid: false,
      reason: 'request_failed',
    };
  }
}

module.exports = {
  validateDirectUrl,
  isAllowedHost,
  hasPreferredExtension,
  ALLOWED_HOST_SUFFIXES,
};