'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const certs = require('./certs');
const config = require('./config');
const secrets = require('./secrets');
const mappings = require('./mappings');
const labels = require('./labels');

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
