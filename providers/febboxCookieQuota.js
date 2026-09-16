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

const QUOTA_BYTES = parseInt(process.env.FEBBOX_COOKIE_QUOTA_BYTES, 10) || (10 * 1024 * 1024 * 1024); // 10GB default
const RESET_HOURS = parseFloat(process.env.FEBBOX_COOKIE_QUOTA_RESET_HOURS) || 24; // febbox quota resets daily
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

module.exports = {
    pickCookie,
    recordUsage,
    markExhausted,
    getStatus,
    QUOTA_BYTES
};