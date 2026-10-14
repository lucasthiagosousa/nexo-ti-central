const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nxtDesktop", {
  obterConfiguracao: () => ipcRenderer.invoke("nxt-config:get"),
  salvarConfiguracao: (dados) => ipcRenderer.invoke("nxt-config:save", dados),
  pularConfiguracao: () => ipcRenderer.invoke("nxt-config:skip"),
});
