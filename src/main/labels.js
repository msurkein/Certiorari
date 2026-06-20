'use strict';

/**
 * labels.js — resolves a certificate's display label from user/seeded Liquid
 * templates, falling back to the built-in CN-OU methodology (certs.deriveCertLabel).
 *
 * Resolution for a cert at a given canonical origin:
 *   1. Walk rulesFor(origin)  =  [origin-specific rules..., global "*" rules...]
 *   2. First rule whose `issuer` matches the cert's issuer wins; render its
 *      Liquid `template` against the cert context.
 *   3. If nothing matches (or the template renders empty/errors): fall back to
 *      deriveCertLabel(cert)  =  "<CN> - <OU1> - ... - <OUn>".
 */

const { Liquid } = require('liquidjs');
const certs = require('./certs');
const mappings = require('./mappings');

// Sandboxed by default — templates cannot execute arbitrary JS. Missing vars
// (e.g. ou[7] on a cert with 3 OUs) render as empty rather than throwing.
const engine = new Liquid({ strictVariables: false, strictFilters: false });

// --- domain filters on top of Liquid's built-ins (upcase, downcase, slice,
//     strip, append, prepend, default, capitalize, ...) ----------------------
engine.registerFilter('skip', (v, n) => String(v ?? '').slice(Number(n) || 0)); // drop first n chars
engine.registerFilter('take', (v, n) => String(v ?? '').slice(0, Number(n) || 0)); // keep first n chars

/**
 * Build the template context from a cert's Subject (and Issuer).
 *   cn          first CN (string)
 *   ou          ALL OU values, 0-indexed array  -> ou[0], ou[1], ...
 *   o, c, l, st, email, ...   first value of each Subject component (string)
 *   subject.<type>            array of all values for that component
 *   issuer.cn / issuer.o / issuer.dn / issuer.<type>[]
 *   dn          full Subject DN string
 */
function buildContext(cert) {
  const subjPairs = certs.parseDNPairs(cert.subject || '');
  const issPairs = certs.parseDNPairs(cert.issuer || '');

  const ctx = {
    subject: arraysByType(subjPairs),
    issuer: { ...arraysByType(issPairs), dn: cert.issuer || '' },
    dn: cert.subject || '',
  };

  // Convenience scalars (first value) for every Subject component, lowercased keys.
  for (const [type, values] of Object.entries(ctx.subject)) {
    ctx[type] = type === 'ou' ? values : values[0]; // ou stays an array; rest are scalars
  }
  if (!ctx.ou) ctx.ou = [];
  if (ctx.cn === undefined) ctx.cn = '';

  // issuer scalars
  for (const [type, values] of Object.entries(arraysByType(issPairs))) {
    ctx.issuer[type] = values[0];
  }
  return ctx;
}

function arraysByType(pairs) {
  const m = {};
  for (const { type, value } of pairs) {
    const key = type.toLowerCase();
    (m[key] ||= []).push(value);
  }
  return m;
}

/**
 * Does `issuerKey` match this cert's issuer? Forgiving on purpose:
 *  - exact issuer CN (case-insensitive), OR
 *  - "CN=Foo" form matched against the issuer CN, OR
 *  - the key appearing anywhere in the full issuer DN (case-insensitive).
 */
function issuerMatches(issuerKey, cert) {
  const key = (issuerKey || '').trim().toLowerCase();
  if (!key) return false;
  const issuerCN = (certs.parseDN(cert.issuer || '').CN || '').toLowerCase();
  const issuerDN = (cert.issuer || '').toLowerCase();
  if (key === issuerCN) return true;
  if (key.startsWith('cn=') && key.slice(3).trim() === issuerCN) return true;
  return issuerDN.includes(key);
}

function renderTemplate(template, cert) {
  return engine.parseAndRenderSync(template, buildContext(cert)).trim();
}

/** Resolve the label for a cert using a precomputed rule list. */
function resolveWithRules(cert, rules) {
  for (const rule of rules || []) {
    if (!issuerMatches(rule.issuer, cert)) continue;
    try {
      const out = renderTemplate(rule.template, cert);
      if (out) return { label: out, rule };
    } catch {
      /* bad template — keep looking, ultimately fall back */
    }
  }
  return { label: certs.deriveCertLabel(cert), rule: null }; // previous methodology
}

/** Resolve the label for a cert at a (raw) url. */
function resolveLabel(cert, url) {
  const origin = mappings.canonicalizeUrl(url);
  return resolveWithRules(cert, mappings.rulesFor(origin)).label;
}

/**
 * Preview helper for the editor: render one template against a sample subject,
 * and report whether the issuer would match. Returns { output, matches, error }.
 */
function preview({ template, issuerKey, subject, issuer }) {
  const cert = { subject: subject || '', issuer: issuer || '' };
  const result = { output: '', matches: issuerMatches(issuerKey, cert), error: null };
  try {
    result.output = renderTemplate(template || '', cert);
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
  }
  return result;
}

module.exports = { resolveLabel, resolveWithRules, issuerMatches, buildContext, preview };
