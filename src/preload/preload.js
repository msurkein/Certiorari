'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The ONLY bridge between the isolated renderer and the main process.
 * Everything is an explicit, narrowly-scoped call — no raw ipcRenderer, no Node.
 */
contextBridge.exposeInMainWorld('certiorari', {
  // certificates (labels are resolved for the given url's mapping templates)
  listCerts: (url) => ipcRenderer.invoke('certs:list', { url }),
  setCertForUrl: (url, identity) => ipcRenderer.invoke('session:setCert', { url, identity }),

  // label-template mappings
  mappings: {
    canonicalize: (url) => ipcRenderer.invoke('mappings:canonicalize', url),
    getAll: () => ipcRenderer.invoke('mappings:getAll'),
    getBucket: (key) => ipcRenderer.invoke('mappings:getBucket', key),
    setBucket: (key, rules) => ipcRenderer.invoke('mappings:setBucket', { key, rules }),
    globalKey: () => ipcRenderer.invoke('mappings:globalKey'),
    preview: (payload) => ipcRenderer.invoke('mappings:preview', payload),
    openEditor: (url) => ipcRenderer.invoke('mappings:openEditor', url),
  },
  onMappingsChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('mappings:changed', handler);
    return () => ipcRenderer.removeListener('mappings:changed', handler);
  },

  // last-URL persistence
  getLastUrl: () => ipcRenderer.invoke('config:getLastUrl'),
  setLastUrl: (url) => ipcRenderer.invoke('config:setLastUrl', url),

  // opt-in password vault (advanced / .pfx path)
  secret: {
    available: () => ipcRenderer.invoke('secret:available'),
    has: (thumbprint) => ipcRenderer.invoke('secret:has', thumbprint),
    set: (thumbprint, password) => ipcRenderer.invoke('secret:set', { thumbprint, password }),
    forget: (thumbprint) => ipcRenderer.invoke('secret:forget', thumbprint),
  },

  // main -> renderer notifications
  onCertApplied: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('cert:applied', handler);
    return () => ipcRenderer.removeListener('cert:applied', handler);
  },
});
