'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');

const certs = require('./certs');
const config = require('./config');
const secrets = require('./secrets');
const mappings = require('./mappings');
const labels = require('./labels');

// ---------------------------------------------------------------------------
//  Main-process console output is invisible in the packaged exe, so a crash
//  here would otherwise look like "the app just doesn't start". Surface it in
//  a native dialog instead (showErrorBox is safe even before app.whenReady).
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  dialog.showErrorBox(
    'Certiorari — unexpected error',
    `${err?.stack || err}\n\nThe app may be in a bad state; consider restarting it.`
  );
});
process.on('unhandledRejection', (reason) => {
  dialog.showErrorBox(
    'Certiorari — unexpected error',
    `Unhandled promise rejection:\n${reason?.stack || reason}`
  );
});

// ---------------------------------------------------------------------------
//  host -> chosen certificate identity, consulted during the TLS handshake.
//  Set by the renderer (via IPC) BEFORE we load a URL for that host.
//  Shape: { thumbprint, serialNumber, label }
// ---------------------------------------------------------------------------
const certForHost = new Map();

let mainWindow = null;

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#1e1f23',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses Node 'require'; renderer stays isolated
      webviewTag: true, // we embed the target site in an isolated <webview>
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
//  THE CORE HOOK.
//  Fires when a server requests a client certificate. We suppress Chromium's
//  native picker and hand back the cert the user chose for this host.
// ---------------------------------------------------------------------------
app.on('select-client-certificate', (event, webContents, url, list, callback) => {
  const host = hostFromUrl(url);
  const want = certForHost.get(host);

  // If `defaultSession` is ever true, the <webview> partition isn't isolating
  // sessions, so the first cert chosen for a host stays cached and the event
  // won't re-fire — which looks exactly like "the cert won't change". Each cert
  // change should show a NEW wcId (a freshly mounted webview).
  const onDefaultSession = webContents.session === session.defaultSession;

  let matched = false;
  if (want) {
    const match = certs.findCertInList(list, want);
    if (match) {
      event.preventDefault();
      callback(match);
      matched = true;
      notifyRenderer('cert:applied', { host, label: want.label, ok: true });
    } else {
      // The chosen cert was NOT among those the server is willing to accept
      // (its CertificateRequest named different CAs). Let the native picker show.
      notifyRenderer('cert:applied', {
        host,
        label: want.label,
        ok: false,
        reason: 'The selected certificate was not offered/accepted by this server.',
      });
    }
  }
  // (No recorded choice, or no match → no preventDefault → Chromium's native picker.)

  // Surface what happened on-screen (status bar) AND to the console, so it's
  // visible whether launched via `npm start` or the packaged exe.
  const diag = {
    host,
    wcId: webContents.id,
    defaultSession: onDefaultSession,
    offered: list.length,
    want: want ? want.label : null,
    matched,
    at: new Date().toLocaleTimeString(),
  };
  console.log('[client-cert]', JSON.stringify(diag));
  notifyRenderer('cert:diag', diag);
});

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
//  NUCLEAR HTTPS/TLS RESET
//  Tears down every clearable network-state layer for a session. Note: the
//  client-certificate selection cache (SSLClientAuthCache) has NO public clear
//  API — the only real reset for it is a brand-new in-memory partition (a fresh
//  NetworkContext), which the renderer mints on every cert change. The clears
//  here kill everything else (live sockets, HTTP/auth/DNS/code caches, cookies
//  and all storage) so nothing from the old identity can be reused.
// ---------------------------------------------------------------------------
async function nukeSession(ses, name) {
  const steps = [];
  const step = async (label, fn) => {
    try {
      await fn();
      steps.push(label);
    } catch {
      steps.push(label + '✗');
    }
  };
  // Close sockets first so no in-flight connection survives the clears.
  await step('connections', () => ses.closeAllConnections());
  await step('authCache', () => ses.clearAuthCache());
  await step('hostResolver', () => ses.clearHostResolverCache());
  await step('cache', () => ses.clearCache());
  await step('codeCaches', () => ses.clearCodeCaches({}));
  await step('storage', () => ses.clearStorageData());
  if (typeof ses.clearData === 'function') await step('data', () => ses.clearData());
  return { name, steps };
}

// ---------------------------------------------------------------------------
//  IPC surface (called from the renderer via the preload bridge)
// ---------------------------------------------------------------------------

ipcMain.handle('certs:list', (_evt, arg) => {
  const url = (arg && arg.url) || '';
  const list = certs.listCertificates();
  // Resolve each label from the mapping templates for this url, falling back to
  // the built-in CN-OU methodology. (certs.js still sets a fallback label, so
  // the standalone diagnostic script keeps working without this layer.)
  return list.map((c) => ({ ...c, label: labels.resolveLabel(c, url) }));
});

ipcMain.handle('session:setCert', (_evt, { url, identity }) => {
  const host = hostFromUrl(url);
  if (!host) return { ok: false, error: 'Invalid URL' };
  certForHost.set(host, identity); // { thumbprint, serialNumber, label }
  return { ok: true, host };
});

ipcMain.handle('config:getLastUrl', () => config.getLastUrl());
ipcMain.handle('config:setLastUrl', (_evt, url) => {
  config.setLastUrl(url);
  return true;
});

// --- opt-in password vault (see secrets.js + README "Advanced") ------------
ipcMain.handle('secret:available', () => secrets.isAvailable());
ipcMain.handle('secret:has', (_evt, thumbprint) => secrets.hasPassword(thumbprint));
ipcMain.handle('secret:set', (_evt, { thumbprint, password }) =>
  secrets.setPassword(thumbprint, password)
);
ipcMain.handle('secret:forget', (_evt, thumbprint) => secrets.forgetPassword(thumbprint));

// Nuke all network/TLS state for the default session AND the given (old)
// partition, on every cert change. Returns what got cleared (shown on-screen).
ipcMain.handle('session:nuke', async (_evt, partitionName) => {
  const results = [await nukeSession(session.defaultSession, 'default')];
  if (partitionName) {
    results.push(await nukeSession(session.fromPartition(partitionName), partitionName));
  }
  console.log('[nuke]', JSON.stringify(results));
  return results;
});

// --- label-template mappings ------------------------------------------------
ipcMain.handle('mappings:canonicalize', (_evt, url) => mappings.canonicalizeUrl(url));
ipcMain.handle('mappings:getAll', () => mappings.getAll());
ipcMain.handle('mappings:getBucket', (_evt, key) => mappings.getBucket(key));
ipcMain.handle('mappings:setBucket', (_evt, { key, rules }) => {
  const saved = mappings.setBucket(key, rules);
  // Tell the main window to re-resolve labels if the picker is open.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mappings:changed');
  return saved;
});
ipcMain.handle('mappings:globalKey', () => mappings.GLOBAL_KEY);
ipcMain.handle('mappings:preview', (_evt, payload) => labels.preview(payload));

ipcMain.handle('mappings:export', async () => {
  const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export label mappings',
    defaultPath: 'certiorari-mappings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  fs.writeFileSync(res.filePath, JSON.stringify(mappings.exportStore(), null, 2), 'utf8');
  return { ok: true, path: res.filePath };
});

ipcMain.handle('mappings:import', async () => {
  const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Import label mappings',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
  try {
    const obj = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    const result = mappings.importStore(obj);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mappings:changed');
    return { ok: true, ...result };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

// Open the mappings editor in its own window, scoped to the given url's origin.
let editorWindow = null;
ipcMain.handle('mappings:openEditor', (_evt, url) => {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.focus();
    return;
  }
  editorWindow = new BrowserWindow({
    width: 920,
    height: 760,
    parent: mainWindow,
    backgroundColor: '#0d0e12',
    title: 'Label mappings',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  editorWindow.setMenuBarVisibility(false);
  editorWindow.loadFile(path.join(__dirname, '..', 'renderer', 'editor.html'), {
    query: { url: url || '' },
  });
  editorWindow.on('closed', () => {
    editorWindow = null;
  });
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
