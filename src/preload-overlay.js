const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onScreenshotData: (cb) =>
    ipcRenderer.on('screenshot-data', (_, data) => cb(data)),
  overlayReady: () => ipcRenderer.send('overlay-ready'),
  cancelSelection: () => ipcRenderer.send('cancel-selection'),
  selectionComplete: (croppedDataUrl) =>
    ipcRenderer.send('selection-complete', croppedDataUrl),
})
