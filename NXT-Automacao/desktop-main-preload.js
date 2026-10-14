const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopReports", {
  savePdf(options) {
    return ipcRenderer.invoke("report:save-pdf", options || {});
  }
});
