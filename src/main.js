const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  dialog,
  shell,
  nativeImage,
  clipboard,
  desktopCapturer,
  systemPreferences,
} = require('electron')
const path = require('path')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let overlayWindow = null
let annotationWindow = null

function captureScreen() {
  const tmpPath = path.join(os.tmpdir(), `sc-${Date.now()}.png`)
  try {
    execSync(`screencapture -x -t png "${tmpPath}"`)
    const data = fs.readFileSync(tmpPath)
    fs.unlinkSync(tmpPath)
    return `data:image/png;base64,${data.toString('base64')}`
  } catch (err) {
    console.error('screencapture failed:', err.message)
    return null
  }
}

function createOverlayWindow(screenshotDataUrl) {
  // Use the display the cursor is currently on, not necessarily the primary
  const cursorPos = screen.getCursorScreenPoint()
  const activeDisplay = screen.getDisplayNearestPoint(cursorPos)
  const { x, y, width, height } = activeDisplay.bounds

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // macOS cascades new windows away from (0,0) — override immediately and
  // again after show so the overlay always covers the full display exactly.
  overlayWindow.setBounds({ x, y, width, height })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.loadFile(path.join(__dirname, '../dist/overlay.html'))

  overlayWindow.webContents.once('did-finish-load', () => {
    // Send display dimensions alongside the screenshot so the renderer
    // can size the canvas correctly even while the window is hidden
    overlayWindow.webContents.send('screenshot-data', { dataUrl: screenshotDataUrl, width, height })
  })

  overlayWindow.on('closed', () => { overlayWindow = null })
}

function createAnnotationWindow(croppedDataUrl) {
  if (annotationWindow) {
    annotationWindow.focus()
    return
  }

  // Size the window sensibly around the image
  const img = nativeImage.createFromDataURL(croppedDataUrl)
  const { width: iw, height: ih } = img.getSize()
  const toolbar = 52
  const padding = 48
  const winW = Math.max(480, Math.min(1600, iw + padding))
  const winH = Math.max(360, Math.min(1100, ih + padding + toolbar))

  annotationWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 480,
    minHeight: 360,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload-annotation.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  annotationWindow.loadFile(path.join(__dirname, '../dist/annotation.html'))

  annotationWindow.webContents.once('did-finish-load', () => {
    annotationWindow.webContents.send('image-data', croppedDataUrl)
  })

  annotationWindow.on('closed', () => { annotationWindow = null })
}

// ── Screen recording permission ───────────────────────────────────────────────

async function ensureScreenPermission() {
  if (process.platform !== 'darwin') return true

  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted') return true

  if (status === 'not-determined') {
    // Calling getSources triggers the macOS permission dialog
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    } catch {}
    if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true
  }

  // Denied or user dismissed — explain and offer to open Settings
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Open System Settings', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    title: 'Screen Recording Permission Required',
    message: 'Screenshot Tool needs Screen Recording access.',
    detail: 'Grant permission in System Settings → Privacy & Security → Screen Recording, then relaunch the app.',
  })

  if (response === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  }
  app.quit()
  return false
}

app.whenReady().then(async () => {
  // Check permission before hiding dock so dialogs are visible
  const allowed = await ensureScreenPermission()
  if (!allowed) return

  if (process.platform === 'darwin') app.dock.hide()

  const ok = globalShortcut.register('Alt+Command+B', () => {
    if (overlayWindow) {
      overlayWindow.close()
      return
    }
    const dataUrl = captureScreen()
    if (dataUrl) createOverlayWindow(dataUrl)
  })

  if (!ok) console.error('Failed to register global shortcut Alt+Command+B')
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  // Stay alive on macOS — app lives in background, accessible via hotkey
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.on('overlay-ready', () => {
  if (overlayWindow) {
    overlayWindow.show()
    // setSimpleFullScreen covers the full screen including the menu bar on macOS
    // without entering a new Space (unlike setFullScreen)
    overlayWindow.setSimpleFullScreen(true)
    overlayWindow.focus()
  }
})

ipcMain.on('cancel-selection', () => {
  if (overlayWindow) overlayWindow.close()
})

ipcMain.on('selection-complete', (_, croppedDataUrl) => {
  if (overlayWindow) overlayWindow.close()
  createAnnotationWindow(croppedDataUrl)
})

ipcMain.handle('copy-to-clipboard', (_, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl)
  clipboard.writeImage(img)
  return { success: true }
})

ipcMain.handle('save-image', async (_, dataUrl) => {
  const result = await dialog.showSaveDialog(annotationWindow, {
    defaultPath: path.join(os.homedir(), 'Desktop', `screenshot-${Date.now()}.png`),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  })

  if (!result.canceled && result.filePath) {
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    fs.writeFileSync(result.filePath, Buffer.from(b64, 'base64'))
    return { success: true }
  }

  return { success: false }
})
