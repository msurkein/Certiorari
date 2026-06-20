'use strict';

/**
 * mappings.js — persistent, user-editable label-template mappings.
 *
 * Store shape (userData/mappings.json):
 *   {
 *     "version": 1,
 *     "mappings": {
 *       "*":                    [ { issuer, template }, ... ],   // all sites
 *       "https://site.example": [ { issuer, template }, ... ]    // one origin
 *     }
 *   }
 *
 * Keys are canonical origins (scheme://host[:port]) plus the special "*" bucket
 * that applies to every site. On first run the store is seeded from
 * default-mappings.json (the packaged Bob Enterprises default) into "*"; after
 * that it's entirely the user's to edit.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const GLOBAL_KEY = '*';
const DEFAULTS = require('./default-mappings.json');

function storePath() {
  return path.join(app.getPath('userData'), 'mappings.json');
}

/** scheme://host[:port], lowercased, default ports dropped, no path/query/hash. */
function canonicalizeUrl(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const host = u.hostname.toLowerCase();
  const isDefaultPort =
    !u.port ||
    (scheme === 'https' && u.port === '443') ||
    (scheme === 'http' && u.port === '80');
  return `${scheme}://${host}${isDefaultPort ? '' : ':' + u.port}`;
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.mappings) return parsed;
  } catch {
    /* fall through to seed */
  }
  return null;
}

function writeStore(store) {
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

/** Returns the store, seeding it on first run if it doesn't exist yet. */
function getStore() {
  let store = readStore();
  if (!store) {
    store = {
      version: 1,
      mappings: { [GLOBAL_KEY]: cloneRules(DEFAULTS.global || []) },
    };
    writeStore(store);
  }
  return store;
}

function cloneRules(rules) {
  return (rules || []).map((r) => ({ issuer: r.issuer || '', template: r.template || '' }));
}

/** All buckets, as { key: rules[] }. */
function getAll() {
  return getStore().mappings;
}

/** Rules for one bucket key ('*' or a canonical origin). */
function getBucket(key) {
  return getStore().mappings[key] || [];
}

/** Replace the rules for a bucket. Empty arrays remove the bucket entirely. */
function setBucket(key, rules) {
  const store = getStore();
  const clean = cloneRules(rules).filter((r) => r.issuer.trim() || r.template.trim());
  if (clean.length) store.mappings[key] = clean;
  else delete store.mappings[key];
  writeStore(store);
  return store.mappings[key] || [];
}

/**
 * Effective rules for a canonical origin: the origin's own rules first (highest
 * priority), then the global "*" rules.
 */
function rulesFor(canonicalOrigin) {
  const store = getStore();
  const specific = canonicalOrigin && store.mappings[canonicalOrigin] ? store.mappings[canonicalOrigin] : [];
  const global = store.mappings[GLOBAL_KEY] || [];
  return [...specific, ...global];
}

module.exports = {
  GLOBAL_KEY,
  canonicalizeUrl,
  getAll,
  getBucket,
  setBucket,
  rulesFor,
};
