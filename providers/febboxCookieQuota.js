// febboxCookieQuota.js
// Tracks approximate per-cookie usage against a quota (default 10GB) and
// picks the first cookie in your list that still has headroom. Persists
// to a local JSON file so usage survives restarts.
//
// Drop this file in your addon's root (or providers/ folder) next to
// Showbox.js, then require it from there.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const QUOTA_BYTES = parseInt(process.env.FEBBOX_COOKIE_QUOTA_BYTES, 10) || (10 * 1024 * 1024 * 1024); // 10GB default
const RESET_HOURS = parseFloat(process.env.FEBBOX_COOKIE_QUOTA_RESET_HOURS) || 24; // febbox quota resets daily

const fetchFebboxQuota = async (cookie, regionPreference = null, cookieIndex = null) => {
    if (!cookie) {
        return null;
    }

    try {
        const cookieHeader = cookie.startsWith('ui=')
    ? cookie
    : `ui=${cookie}`;

const phpSessionId = process.env.FEBBOX_PHPSESSID;

const finalCookieHeader = cookieHeader;

        const response = await axios.get(
            'https://www.febbox.com/console/user_cards',
            {
                headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.febbox.com/',
    'Origin': 'https://www.febbox.com',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': finalCookieHeader
},
                timeout: 12000,
                validateStatus: () => true
            }
        );

        const flow = response.data?.data?.flow;

        if (!flow) {
            console.warn(
                `[CookieQuota] FebBox quota lookup failed with status ${response.status}`
            );

            console.warn(
    `[CookieQuota] Response for failed cookie ${cookieIndex}:`,
                typeof response.data === 'string'
                    ? response.data.slice(0, 500)
                    : JSON.stringify(response.data).slice(0, 1000)
            );

            return null;
        }

        const usageMb = Number(flow.traffic_usage_mb);
        const limitMb = Number(flow.traffic_limit_mb);

        if (!Number.isFinite(usageMb) || !Number.isFinite(limitMb)) {
            console.warn('[CookieQuota] FebBox returned invalid quota data.');
            return null;
        }

        return {
            usageBytes: usageMb * 1024 * 1024,
            limitBytes: limitMb * 1024 * 1024,
            resetAt: flow.reset_at,
            isVip: flow.is_vip
        };

    } catch (error) {
        console.warn(
            `[CookieQuota] FebBox quota request failed: ${error.message}`
        );

        return null;
    }
};

const STORE_PATH = path.join(__dirname, 'febbox_cookie_quota.json');

let state = null; // { [cookieHash]: { usedBytes, windowStart } }

// We hash the cookie rather than store it raw, so the quota file itself
// doesn't leak your session cookies if it ever gets shared/committed.
function cookieKey(cookie) {
    return crypto.createHash('sha1').update(cookie).digest('hex').slice(0, 16);
}

function loadState() {
    if (state) return state;
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf-8');
        state = JSON.parse(raw);
    } catch (e) {
        state = {};
    }
    return state;
}

function saveState() {
    try {
        const tmpPath = STORE_PATH + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tmpPath, STORE_PATH); // atomic-ish on same filesystem
    } catch (e) {
        console.warn(`[CookieQuota] Failed to persist quota state: ${e.message}`);
    }
}

function getEntry(cookie) {
    const s = loadState();
    const key = cookieKey(cookie);
    const now = Date.now();
    let entry = s[key];

    if (!entry || (now - entry.windowStart) > RESET_HOURS * 60 * 60 * 1000) {
        entry = { usedBytes: 0, windowStart: now };
        s[key] = entry;
    }

    return entry;
}

/**
 * Given an ordered list of cookies, return the first one that still has
 * headroom under the quota. If every cookie is over quota, falls back to
 * the least-used one instead of returning nothing.
 */
function pickCookie(cookies) {
    if (!cookies || cookies.length === 0) return null;

    let best = null;
    let bestUsed = Infinity;

    for (const cookie of cookies) {
        const entry = getEntry(cookie);

        if (entry.usedBytes < QUOTA_BYTES) {
            console.log(
                `[CookieQuota] Using cookie ${cookieKey(cookie)} (${(entry.usedBytes / 1e9).toFixed(2)}GB / ${(QUOTA_BYTES / 1e9).toFixed(0)}GB used)`
            );
            return cookie;
        }

        if (entry.usedBytes < bestUsed) {
            best = cookie;
            bestUsed = entry.usedBytes;
        }
    }

    console.warn(
        `[CookieQuota] All ${cookies.length} cookie(s) are at/over quota. Falling back to least-used cookie (${(bestUsed / 1e9).toFixed(2)}GB used).`
    );

    return best;
}

/**
 * Call this once you know both the cookie used to resolve a stream link
 * and that file's size in bytes (e.g. from fetchStreamSize's HEAD request).
 * This is what actually increments the quota counter.
 */
function recordUsage(cookie, bytes) {
    if (!cookie || !bytes || isNaN(bytes) || bytes <= 0) return;

    const entry = getEntry(cookie);
    entry.usedBytes += bytes;

    saveState();

    console.log(
        `[CookieQuota] +${(bytes / 1e9).toFixed(2)}GB on cookie ${cookieKey(cookie)} -> ${(entry.usedBytes / 1e9).toFixed(2)}GB total`
    );
}

/**
 * Safety net: call this if febbox itself ever returns a quota-exceeded
 * response while using this cookie. Instantly maxes it out so pickCookie
 * skips it, even if our own byte tracking hadn't caught up yet.
 */
function markExhausted(cookie) {
    if (!cookie) return;

    const entry = getEntry(cookie);
    entry.usedBytes = QUOTA_BYTES;

    saveState();

    console.warn(
        `[CookieQuota] Cookie ${cookieKey(cookie)} marked EXHAUSTED (febbox reported quota exceeded).`
    );
}

/** Optional: inspect current usage, e.g. for a debug/status endpoint. */
function getStatus(cookies = []) {
    return cookies.map(cookie => {
        const entry = getEntry(cookie);

        return {
            cookie: cookieKey(cookie),
            usedGB: +(entry.usedBytes / 1e9).toFixed(2),
            quotaGB: +(QUOTA_BYTES / 1e9).toFixed(2),
            resetsInHours: +(
                (RESET_HOURS * 60 * 60 * 1000 -
                    (Date.now() - entry.windowStart)) /
                3.6e6
            ).toFixed(1)
        };
    });
}

const pickCookieByFebboxQuota = async (cookies, regionPreference = null) => {
    if (!Array.isArray(cookies) || cookies.length === 0) {
        return null;
    }

    const quotaResults = [];

    for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i];

    console.log(
        `[CookieQuota] Checking cookie ${i + 1} of ${cookies.length}`
    );

    const quota = await fetchFebboxQuota(
    cookie,
    regionPreference,
    i + 1
);

        if (quota) {
            const usedBytes = quota.usageBytes;

            quotaResults.push({
                cookie,
                usedBytes,
                remainingBytes: quota.limitBytes - usedBytes
            });

            console.log(
                `[CookieQuota] Cookie ${quotaResults.length}: ` +
                `${(usedBytes / (1024 ** 3)).toFixed(2)} GB used`
            );
        }
    }

    if (quotaResults.length === 0) {
        console.warn(
            '[CookieQuota] Could not read FebBox quota for any cookie. Falling back to local picker.'
        );
        return pickCookie(cookies);
    }

    // Prefer the first cookie that has used less than the 10 GB rotation limit.
    const availableCookie = quotaResults.find(
        item => item.usedBytes < QUOTA_BYTES
    );

    if (availableCookie) {
        console.log(
            `[CookieQuota] Selected cookie with ` +
            `${(availableCookie.usedBytes / (1024 ** 3)).toFixed(2)} GB used.`
        );

        return availableCookie.cookie;
    }

    // If every cookie reached 10 GB, use the one with the least usage.
    const leastUsedCookie = quotaResults.reduce(
        (least, current) =>
            current.usedBytes < least.usedBytes ? current : least
    );

    console.log(
        `[CookieQuota] All cookies reached 10 GB. ` +
        `Using least-used cookie at ` +
        `${(leastUsedCookie.usedBytes / (1024 ** 3)).toFixed(2)} GB.`
    );

    return leastUsedCookie.cookie;
};

module.exports = {
    pickCookie,
    pickCookieByFebboxQuota,
    recordUsage,
    markExhausted,
    getStatus,
    QUOTA_BYTES
};