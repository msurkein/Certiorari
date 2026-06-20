'use strict';

/**
 * certs.js — reads client certificates from the Windows Personal store and
 * provides the helpers that map a stored cert to (a) a human label for the
 * picker UI and (b) the matching entry in Electron's `select-client-certificate`
 * list during the TLS handshake.
 *
 * Nothing here touches private keys. Enumeration is metadata-only; the actual
 * signing during TLS is done by Windows/CNG inside Chromium.
 */

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Which Windows store to read.
//   Cert:\CurrentUser\My   == the "Personal > Certificates" store (per-user)
//   Cert:\LocalMachine\My  == the machine-wide Personal store
// Add more paths here if you also keep certs in the machine store.
// ---------------------------------------------------------------------------
const STORE_PATHS = ['Cert:\\CurrentUser\\My'];

/**
 * Enumerate certificates (that have a private key) from the configured stores.
 * Returns an array of plain objects — see the PowerShell projection below for
 * the exact shape.
 */
function listCertificates() {
  const psScript = `
$ErrorActionPreference = 'Stop'
$paths = @(${STORE_PATHS.map((p) => `'${p}'`).join(',')})
$all = foreach ($p in $paths) {
  Get-ChildItem $p | Where-Object { $_.HasPrivateKey } | ForEach-Object {
    $eku = @()
    try { $eku = @($_.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId }) } catch {}
    [PSCustomObject]@{
      store        = $p
      thumbprint   = $_.Thumbprint
      subject      = $_.Subject
      issuer       = $_.Issuer
      serialNumber = $_.SerialNumber
      notBefore    = $_.NotBefore.ToString('o')
      notAfter     = $_.NotAfter.ToString('o')
      friendlyName = $_.FriendlyName
      hasPrivateKey= [bool]$_.HasPrivateKey
      eku          = $eku
    }
  }
}
# Force an array so single results still serialize as a JSON array.
ConvertTo-Json -InputObject @($all) -Depth 5 -Compress
`;

  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }
  );

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`PowerShell cert enumeration failed (exit ${res.status}): ${res.stderr || ''}`);
  }

  const raw = (res.stdout || '').trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse cert list JSON: ${e.message}\n---\n${raw.slice(0, 500)}`);
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];

  return arr.map((c) => ({
    ...c,
    thumbprint: normalizeThumbprint(c.thumbprint),
    serialNumber: normalizeSerial(c.serialNumber),
    label: deriveCertLabel(c), // <-- the display name; see deriveCertLabel below
    sublabel: deriveCertSublabel(c),
  }));
}

// ===========================================================================
//  >>> EDIT ME <<<  — how each certificate is labeled in the picker.
// ===========================================================================
/**
 * deriveCertLabel decides the PRIMARY text shown for a cert in the picker.
 *
 * `cert.subject` is the full Subject Distinguished Name, e.g.
 *     "CN=Jane Q. Public, OU=Team A, OU=Region 5, O=Acme Corp, C=US"
 * parseDNPairs(cert.subject) gives every component in order (keeping duplicate
 * OUs); parseDN(cert.subject) gives a last-wins { TYPE: value } map.
 *
 * Current format:  <CN> - <OU1> - <OU2> - ... - <OUn>
 * OUs appear in the order they occur in the Subject string. If your CA lists
 * them most-significant-last and you want the reverse, add `ous.reverse()`.
 */
function deriveCertLabel(cert) {
  const pairs = parseDNPairs(cert.subject || '');
  const cn = pairs.find((p) => p.type === 'CN');
  const ous = pairs.filter((p) => p.type === 'OU').map((p) => p.value);

  // -------- Format: <CN> - <OU1> - <OU2> - ... - <OUn> ---------------------
  const parts = [];
  if (cn) parts.push(cn.value);
  parts.push(...ous);
  const label = parts.join(' - ') || cert.subject;
  // -------------------------------------------------------------------------

  return label;
}

/**
 * deriveCertSublabel is the SECONDARY (dimmer) line under the label — meant to
 * disambiguate near-identical certs. Tweak freely. By default it surfaces the
 * issuer CN and the last 8 hex of the thumbprint. (Expiry has its own colored
 * section in the picker, so it's intentionally not repeated here.)
 */
function deriveCertSublabel(cert) {
  const issuer = parseDN(cert.issuer || '');
  const tail = (cert.thumbprint || '').slice(-8);
  const bits = [];
  if (issuer.CN) bits.push(`Issuer: ${issuer.CN}`);
  if (tail) bits.push(`…${tail}`);
  return bits.join('   ·   ');
}
// ===========================================================================

/**
 * parseDNPairs returns the DN's components in order as { type, value } objects,
 * preserving duplicates (e.g. multiple OU values). Handles simple escaped commas.
 * For unusual DNs you may want a stricter parser — this is intentionally small.
 */
function parseDNPairs(dn) {
  const out = [];
  if (!dn) return out;
  // Split on commas that are not escaped (\,). Good enough for typical certs.
  const parts = dn.match(/(?:[^,\\]|\\.)+/g) || [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const type = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim().replace(/\\,/g, ',');
    out.push({ type, value });
  }
  return out;
}

/**
 * parseDN turns an X.500 Distinguished Name into a { TYPE: value } map. The last
 * occurrence of a repeated type wins — use parseDNPairs when you need every
 * value (e.g. multiple OUs).
 */
function parseDN(dn) {
  const out = {};
  for (const { type, value } of parseDNPairs(dn)) out[type] = value;
  return out;
}

// ---------------------------------------------------------------------------
//  Matching a chosen cert against Electron's select-client-certificate list.
// ---------------------------------------------------------------------------

/**
 * findCertInList matches the user's chosen identity against the certs Chromium
 * offers during the handshake (`list` from the select-client-certificate event).
 *
 * Primary match: SHA-1 thumbprint derived from each list entry's PEM `data`.
 * Fallback:      serial number.
 *
 *  >>> If your matching ever misbehaves, this is the place to adjust it. <<<
 */
function findCertInList(list, want) {
  if (!Array.isArray(list)) return null;

  if (want.thumbprint) {
    for (const c of list) {
      const tp = sha1ThumbprintFromPem(c && c.data);
      if (tp && tp === want.thumbprint) return c;
    }
  }
  if (want.serialNumber) {
    for (const c of list) {
      if (normalizeSerial(c && c.serialNumber) === want.serialNumber) return c;
    }
  }
  return null;
}

/** SHA-1 thumbprint (uppercase hex) from a PEM certificate — matches Windows' Thumbprint. */
function sha1ThumbprintFromPem(pem) {
  if (!pem || typeof pem !== 'string') return null;
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  const b64 = (m ? m[1] : pem).replace(/[^A-Za-z0-9+/=]/g, '');
  if (!b64) return null;
  const der = Buffer.from(b64, 'base64');
  return crypto.createHash('sha1').update(der).digest('hex').toUpperCase();
}

function normalizeThumbprint(tp) {
  return (tp || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/** Normalize a serial number for comparison: hex only, uppercase, no leading zeros. */
function normalizeSerial(s) {
  const hex = (s || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().replace(/^0+/, '');
  return hex || '0';
}

module.exports = {
  listCertificates,
  deriveCertLabel,
  parseDN,
  parseDNPairs,
  findCertInList,
  sha1ThumbprintFromPem,
  normalizeSerial,
  normalizeThumbprint,
  STORE_PATHS,
};
