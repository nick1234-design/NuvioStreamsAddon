'use strict';

function createStream({
  url,
  title = 'FebBox',
  quality = 0,
  size = 0,
  codec = '',
}) {
  return {
    url,
    title,
    quality,
    size,
    codec,
    behaviorHints: {
      bingeGroup: 'febbox',
    },
  };
}

module.exports = {
  createStream,
};