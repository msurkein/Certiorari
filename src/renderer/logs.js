'use strict';

const api = window.certiorari;
const container = document.getElementById('log-container');

function addLog(type, msg, data = null) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  
  const time = document.createElement('div');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString();
  
  const content = document.createElement('div');
  content.className = 'log-msg';
  content.textContent = msg;
  
  entry.appendChild(time);
  entry.appendChild(content);
  
  if (data) {
    const pre = document.createElement('pre');
    pre.className = 'diag-json';
    pre.textContent = JSON.stringify(data, null, 2);
    entry.appendChild(pre);
  }
  
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

// Initial logs or any generic logs from main
api.onLog((payload) => {
  addLog(payload.type || 'info', payload.message, payload.data);
});

// Specifically hook the diag event for rich display
api.onCertDiag((d) => {
  addLog('diag', `[client-cert] EVENT FIRING for ${d.host}`, d);
});

document.getElementById('clear-btn').addEventListener('click', () => {
  container.innerHTML = '';
});

addLog('info', 'Log window initialized.');
