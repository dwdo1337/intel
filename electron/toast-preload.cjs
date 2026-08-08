const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onToastData: (cb) => ipcRenderer.on('toast-data', (_e, data) => cb(data)),
  onToastAction: (cb) => ipcRenderer.on('toast-action', (_e, action) => cb(action)),
  sendToastAction: (payload) => ipcRenderer.send('toast-action', payload),
});
