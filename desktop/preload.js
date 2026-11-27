/**
 * The only desktop features the dashboard can reach. Everything else stays on the local
 * HTTP API; the main process refuses these calls from any page not served by amem.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("amemDesktop", {
  info: () => ipcRenderer.invoke("amem:info"),
  addToPath: () => ipcRenderer.invoke("amem:path-add"),
  checkForUpdates: () => ipcRenderer.invoke("amem:update-check"),
  installUpdate: () => ipcRenderer.invoke("amem:update-install"),
  setAutoInstall: (on) => ipcRenderer.invoke("amem:auto-install", Boolean(on)),
  pickFolder: () => ipcRenderer.invoke("amem:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("amem:open-external", String(url)),
  onUpdateStatus: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on("amem:update-status", listener);
    return () => ipcRenderer.removeListener("amem:update-status", listener);
  },
});
