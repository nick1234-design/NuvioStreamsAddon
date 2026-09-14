'use strict';

const axios = require('axios');

const FEBBOX_ORIGIN = 'https://febbox.org';

async function febboxGet(path, token, params = {}) {
  const response = await axios.get(`${FEBBOX_ORIGIN}${path}`, {
    params,
    headers: {
      Cookie: `ui=${token}`,
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json, text/plain, */*',
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  return response;
}

async function listShareFiles({ token, shareKey, parentId = 0 }) {
  return febboxGet('/file/file_share_list', token, {
    share_key: shareKey,
    parent_id: parentId,
  });
}

async function getVideoQualityLinks({ token, shareKey, fid }) {
  return febboxGet('/console/video_quality_list', token, {
    share_key: shareKey,
    fid,
  });
}

async function getQuota({ token }) {
  return febboxGet('/console/user_cards', token);
}

module.exports = {
  FEBBOX_ORIGIN,
  listShareFiles,
  getVideoQualityLinks,
  getQuota,
};