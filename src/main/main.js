'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, dialog, Menu } = require('electron');

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

// embedder webContents.id -> partition of its live <webview>. Registered by
// each app window on every mount, so a popup opened from that window can be
// mounted on the SAME partition (shared TLS session + cookies + chosen cert).
const partitionByEmbedder = new Map();

let mainWindow = null;
let logWindow = null;

function hostFromUrl(url) {
  try {
    let u = url;
    if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
      u = 'https://' + u;
    }
    return new URL(u).host;
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

// A popup gets the SAME chrome as the main window (toolbar, cert button,
// status bar): it's index.html in "popup mode", told which URL to open and
// which partition to mount so it stays in the opener's TLS session.
function openPopupWindow(url, partition) {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    backgroundColor: '#1e1f23',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { popup: '1', url, partition: partition || '' },
  });
  return win;
}

// ---------------------------------------------------------------------------
//  Links a site targets at a new window (window.open / target="_blank").
//  Without this, `allowpopups` spawns a BARE Chromium window — no toolbar, no
//  cert selector, no status bar. Instead we deny the native popup and open a
//  full app window on the opener's partition. Applies to every <webview> we
//  ever create, popups' webviews included (so nested popups work too).
// ---------------------------------------------------------------------------
app.on('web-contents-created', (_evt, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) return { action: 'deny' };
    const embedderId = contents.hostWebContents ? contents.hostWebContents.id : null;
    const partition = partitionByEmbedder.get(embedderId) || '';
    logToWindow('popup', `opening popup window url=${url} partition=${partition || '(fresh)'}`);
    openPopupWindow(url, partition);
    return { action: 'deny' };
  });
});

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
      notifyRenderer('cert:applied', { host, label: want.label, ok: true }, webContents);
    } else {
      // The chosen cert was NOT among those the server is willing to accept
      // (its CertificateRequest named different CAs). Let the native picker show.
      notifyRenderer(
        'cert:applied',
        {
          host,
          label: want.label,
          ok: false,
          reason: 'The selected certificate was not offered/accepted by this server.',
        },
        webContents
      );
    }
  }
  // (No recorded choice, or no match → no preventDefault → Chromium's native picker.)

  // Surface what happened on-screen (status bar) AND to the console, so it's
  // visible whether launched via `npm start` or the packaged exe.
  const diag = {
    host,
    url,
    wcId: webContents.id,
    defaultSession: onDefaultSession,
    partition: webContents.session.getStoragePath() || 'in-memory',
    offered: list.length,
    offeredDetails: list.map(c => ({
      subject: c.subjectName,
      tp: certs.sha1ThumbprintFromPem(c.data),
      sn: certs.normalizeSerial(c.serialNumber)
    })),
    want: want ? want.label : null,
    matched,
    at: new Date().toLocaleTimeString(),
  };
  logToWindow('diag', '[client-cert] EVENT FIRING', diag);
  notifyRenderer('cert:diag', diag, webContents);
});

// Deliver to the window that owns `sourceWc` (the <webview> doing the
// handshake — its hostWebContents is the app window embedding it, which may be
// a popup). Without a source, or if it's gone, fall back to the main window.
// The log window always gets a copy.
function notifyRenderer(channel, payload, sourceWc) {
  const embedder = sourceWc && sourceWc.hostWebContents;
  const target =
    embedder && !embedder.isDestroyed()
      ? embedder
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.webContents
        : null;
  if (target) target.send(channel, payload);
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send(channel, payload);
  }
}

function logToWindow(type, message, data = null) {
  console.log(`[${type}] ${message}`, data ? JSON.stringify(data) : '');
  notifyRenderer('app:log', { type, message, data });
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
      logToWindow('nuke', `starting ${name}:${label}`);
      await fn();
      steps.push(label);
      logToWindow('nuke', `finished ${name}:${label}`);
    } catch (e) {
      logToWindow('nuke', `failed ${name}:${label} - ${e.message}`);
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

// Popup windows use this at boot to show which cert their host inherited.
ipcMain.handle('session:getCert', (_evt, url) => certForHost.get(hostFromUrl(url)) || null);

// Each app window reports its live webview partition, so a popup opened from
// that window can be mounted on the same one (see web-contents-created above).
ipcMain.handle('session:registerPartition', (evt, partition) => {
  const wc = evt.sender;
  const id = wc.id; // capture: wc.id is unreadable once destroyed
  if (!partitionByEmbedder.has(id)) {
    wc.once('destroyed', () => partitionByEmbedder.delete(id));
  }
  partitionByEmbedder.set(id, partition);
  return true;
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
  logToWindow('nuke', 'Nuclear reset complete', results);
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
ipcMain.handle('mappings:export', () => mappings.exportToString());
ipcMain.handle('mappings:import', (_evt, { str, replace }) => {
  const ok = mappings.importFromString(str, replace);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mappings:changed');
  }
  return ok;
});
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

function openLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return;
  }
  logWindow = new BrowserWindow({
    width: 800,
    height: 600,
    backgroundColor: '#0d0e12',
    title: 'Diagnostic Logs',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  logWindow.setMenuBarVisibility(false);
  logWindow.loadFile(path.join(__dirname, '..', 'renderer', 'logs.html'));
  logWindow.on('closed', () => {
    logWindow = null;
  });
}

function setupMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Diagnostic',
      submenu: [
        {
          label: 'Show Logs',
          click: () => openLogWindow()
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  logToWindow('info', 'App starting...');
  logToWindow('info', `  userData: ${app.getPath('userData')}`);
  logToWindow('info', `  cache:    ${app.getPath('cache')}`);
  logToWindow('info', `  temp:     ${app.getPath('temp')}`);
  logToWindow('info', `  name:     ${app.name}`);

  setupMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
