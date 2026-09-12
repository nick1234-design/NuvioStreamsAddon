```js
const axios = require('axios');

// Function to parse command line arguments
const parseArgs = () => {
    const args = process.argv.slice(2);
    const options = {};
    let i = 0;

    while (i < args.length) {
        const arg = args[i];

        if (arg.startsWith('--')) {
            const key = arg.substring(2);

            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
                options[key] = args[i + 1];
                i++;
            } else {
                options[key] = true;
            }
        }

        i++;
    }

    return options;
};

const getVidZeeStreams = async (tmdbId, mediaType, seasonNum, episodeNum) => {
    if (!tmdbId) {
        console.error('[VidZee] Error: TMDB ID (tmdbId) is required.');
        return [];
    }

    if (!mediaType || (mediaType !== 'movie' && mediaType !== 'tv')) {
        console.error('[VidZee] Error: mediaType is required and must be either "movie" or "tv".');
        return [];
    }

    if (mediaType === 'tv') {
        if (!seasonNum) {
            console.error('[VidZee] Error: Season (seasonNum) is required for TV shows.');
            return [];
        }

        if (!episodeNum) {
            console.error('[VidZee] Error: Episode (episodeNum) is required for TV shows.');
            return [];
        }
    }

    // Current VidZee server names
    const servers = ['dcloud', 'tik', 'ipcloud', 'v6:Hindi'];

    const streamPromises = servers.map(async (server) => {
        let targetApiUrl;

        if (mediaType === 'movie') {
            targetApiUrl =
                `https://core.vidzee.wtf/streams/movie/${tmdbId}` +
                `?s=${encodeURIComponent(server)}&e=0`;
        } else {
            targetApiUrl =
                `https://core.vidzee.wtf/streams/tv/${tmdbId}/${seasonNum}/${episodeNum}` +
                `?s=${encodeURIComponent(server)}&e=0`;
        }

        // Keep your existing proxy support
        const proxyBaseUrl =
            process.env.VIDZEE_PROXY_URL ||
            process.env.SHOWBOX_PROXY_URL_VALUE;

        const finalApiUrl = proxyBaseUrl
            ? proxyBaseUrl + encodeURIComponent(targetApiUrl)
            : targetApiUrl;

        console.log(`[VidZee] Fetching from server ${server}: ${targetApiUrl}`);

        try {
            const response = await axios.get(finalApiUrl, {
                headers: {
                    'Referer': 'https://player.vidzee.wtf/',
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
                },
                timeout: 10000
            });

            const responseData = response.data;

            if (!responseData || typeof responseData !== 'object') {
                console.error(
                    `[VidZee ${server}] Invalid response data from API.`
                );
                return [];
            }

            /*
             * Current VidZee e=0 responses are normally:
             *
             * {
             *   "url": "...",
             *   "language": "...",
             *   "headers": {...}
             * }
             *
             * Keep support for an array just in case the API returns
             * multiple sources in a response.
             */
            let apiSources = [];

            if (Array.isArray(responseData)) {
                apiSources = responseData;
            } else if (responseData.url) {
                apiSources = [responseData];
            } else if (responseData.link) {
                apiSources = [responseData];
            }

            if (apiSources.length === 0) {
                console.log(
                    `[VidZee ${server}] No stream source found in API response.`
                );
                return [];
            }

            const streams = apiSources
                .map((sourceItem) => {
                    const streamUrl = sourceItem.url || sourceItem.link;

                    if (!streamUrl) {
                        return null;
                    }

                    const language =
                        sourceItem.language ||
                        sourceItem.lang ||
                        'Unknown';

                    // Try to get quality from the response if available.
                    let quality =
                        sourceItem.quality ||
                        sourceItem.name ||
                        sourceItem.type ||
                        'VidZee';

                    quality = String(quality);

                    if (/^\d+$/.test(quality)) {
                        quality = `${quality}p`;
                    }

                    /*
                     * VidZee/CDN requests require the player Referer.
                     * Keep it in behaviorHints so Stremio knows to send it.
                     */
                    const streamHeaders = {
                        'Referer': 'https://player.vidzee.wtf/',
                        ...(sourceItem.headers || {})
                    };

                    // Make sure the required player Referer wins.
                    streamHeaders['Referer'] = 'https://player.vidzee.wtf/';

                    return {
                        title: `VidZee ${server} - ${quality}`,
                        url: streamUrl,
                        quality: quality,
                        language: language,
                        provider: 'VidZee',
                        size: 'Unknown size',

                        behaviorHints: {
                            notWebReady: true,
                            headers: streamHeaders
                        }
                    };
                })
                .filter(Boolean);

            console.log(
                `[VidZee ${server}] Successfully extracted ${streams.length} streams.`
            );

            return streams;

        } catch (error) {
            if (error.response) {
                console.error(
                    `[VidZee ${server}] Error fetching: ` +
                    `${error.response.status} ${error.response.statusText}`
                );

                if (error.response.data) {
                    console.error(
                        `[VidZee ${server}] Response:`,
                        typeof error.response.data === 'string'
                            ? error.response.data.substring(0, 500)
                            : error.response.data
                    );
                }
            } else if (error.request) {
                console.error(
                    `[VidZee ${server}] Error fetching: No response received.`
                );
            } else {
                console.error(
                    `[VidZee ${server}] Error fetching:`,
                    error.message
                );
            }

            return [];
        }
    });

    const allStreamsNested = await Promise.all(streamPromises);
    const allStreams = allStreamsNested.flat();

    console.log(
        `[VidZee] Found a total of ${allStreams.length} streams from servers: ${servers.join(', ')}.`
    );

    return allStreams;
};

module.exports = { getVidZeeStreams };
```
