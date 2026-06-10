const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onImageData: (cb) =>
    ipcRenderer.on('image-data', (_, data) => cb(data)),
  copyToClipboard: (dataUrl) =>
    ipcRenderer.invoke('copy-to-clipboard', dataUrl),
  saveImage: (dataUrl) =>
    ipcRenderer.invoke('save-image', dataUrl),
})
