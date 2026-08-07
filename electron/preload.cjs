const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  requestTestNotify: () => ipcRenderer.send('request-test-notify'),
});
