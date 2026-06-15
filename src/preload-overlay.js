const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  overlayReady: () => ipcRenderer.send('overlay-ready'),
  cancelSelection: () => ipcRenderer.send('cancel-selection'),
  selectionComplete: (rect) => ipcRenderer.send('selection-complete', rect),
  mouseDebug: (data) => ipcRenderer.send('mouse-debug', data),
})
