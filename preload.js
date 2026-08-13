// Preload script — exposes safe IPC methods to the renderer process
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Get the migration server URL from main process
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  // Diagnostic: execute arbitrary JS and return result
  diagExec: (code) => ipcRenderer.invoke('diag-exec', code),
  // Diagnostic: get captured console logs
  diagLogs: () => ipcRenderer.invoke('diag-logs'),
});
