const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  requestTestNotify: () => ipcRenderer.send('request-test-notify'),
  // Clicking a toast (a watch note especially) asks the deck to open that
  // token. contextIsolation is on, so the renderer cannot reach ipcRenderer
  // directly -- without this entry the main process would send `open-token`
  // into nothing and the click would look like it did nothing.
  onOpenToken: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('open-token', handler);
    return () => ipcRenderer.removeListener('open-token', handler);
  },
});
