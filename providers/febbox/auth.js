'use strict';

function normalizeToken(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.trim();
  if (t.toLowerCase().startsWith('ui=')) t = t.slice(3);
  return t.trim();
}

function isPlausibleToken(token) {
  if (typeof token !== 'string') return false;
  const t = token.trim();
  if (t.length < 8 || t.length > 512) return false;
  if (/[\r\n\t]/.test(t)) return false;
  return true;
}

function toCookieHeader(token) {
  return `ui=${normalizeToken(token)}`;
}

module.exports = {
  normalizeToken,
  isPlausibleToken,
  toCookieHeader,
};