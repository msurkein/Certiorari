'use strict';

/**
 * config.js — tiny JSON config persisted in the app's userData directory.
 * Currently just remembers the last URL the user entered.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function write(obj) {
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2), 'utf8');
}

function getLastUrl() {
  return read().lastUrl || '';
}

function setLastUrl(url) {
  const cfg = read();
  cfg.lastUrl = url || '';
  write(cfg);
}

module.exports = { getLastUrl, setLastUrl };
