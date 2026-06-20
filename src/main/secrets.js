'use strict';

/**
 * secrets.js — opt-in, per-user encrypted password vault.
 *
 * SECURITY MODEL
 * --------------
 * Passwords are encrypted with Electron's safeStorage, which on Windows uses
 * DPAPI keyed to the *current Windows user account*. The ciphertext on disk is
 * useless to another user or on another machine. We never write plaintext, and
 * we never log the password.
 *
 * WHEN IS THIS USED?
 * ------------------
 * For certs already in the Windows store, Windows itself owns the private-key
 * unlock prompt during the TLS handshake — this vault is NOT in that path and
 * cannot (and should not) intercept that native prompt.
 *
 * This vault is the ready, secure home for passwords in the ".pfx file" /
 * local-proxy path (see README "Advanced: app-managed passwords"). Storing is
 * always explicit and opt-in (the caller passes remember=true), per your
 * chosen policy.
 *
 * Keys are certificate thumbprints (uppercase hex).
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

function vaultPath() {
  return path.join(app.getPath('userData'), 'secrets.json');
}

function readVault() {
  try {
    return JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeVault(obj) {
  // Restrict to the current user where the OS supports it; DPAPI already scopes
  // decryptability to this account, this is defense-in-depth on the file itself.
  fs.writeFileSync(vaultPath(), JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function isAvailable() {
  return safeStorage.isEncryptionAvailable();
}

/** Persist an encrypted password for a thumbprint. Returns true on success. */
function setPassword(thumbprint, password) {
  if (!isAvailable()) return false;
  const enc = safeStorage.encryptString(String(password)); // Buffer
  const vault = readVault();
  vault[thumbprint] = enc.toString('base64');
  writeVault(vault);
  return true;
}

/** Return the decrypted password for a thumbprint, or null if not stored. */
function getPassword(thumbprint) {
  if (!isAvailable()) return null;
  const vault = readVault();
  const b64 = vault[thumbprint];
  if (!b64) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function hasPassword(thumbprint) {
  return Boolean(readVault()[thumbprint]);
}

function forgetPassword(thumbprint) {
  const vault = readVault();
  if (thumbprint in vault) {
    delete vault[thumbprint];
    writeVault(vault);
  }
  return true;
}

module.exports = { isAvailable, setPassword, getPassword, hasPassword, forgetPassword };
