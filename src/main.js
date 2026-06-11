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
  Tray,
  Menu,
} = require('electron')
const path = require('path')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let tray = null
let overlayWindow = null
let overlayBounds = null  // combined bounding rect of all displays
let annotationWindow = null

const dbg = (...args) => fs.appendFileSync(
  path.join(os.homedir(), 'Desktop', 'redcap-debug.log'),
  `${new Date().toISOString()} ${args.join(' ')}\n`
)

function captureRegion(x, y, w, h) {
  const tmpPath = path.join(os.tmpdir(), `sc-${Date.now()}.png`)
  const cmd = `screencapture -x -t png -R ${x},${y},${w},${h} "${tmpPath}"`
  dbg(`captureRegion cmd: ${cmd}`)
  try {
    execSync(cmd)
    const data = fs.readFileSync(tmpPath)
    fs.unlinkSync(tmpPath)
    return `data:image/png;base64,${data.toString('base64')}`
  } catch (err) {
    dbg(`captureRegion ERROR: ${err.message}`)
    return null
  }
}

function createOverlayWindow() {
  const displays = screen.getAllDisplays()

  // Compute a single rect that covers every display.
  const minX = Math.min(...displays.map(d => d.bounds.x))
  const minY = Math.min(...displays.map(d => d.bounds.y))
  const maxX = Math.max(...displays.map(d => d.bounds.x + d.bounds.width))
  const maxY = Math.max(...displays.map(d => d.bounds.y + d.bounds.height))
  overlayBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }

  overlayWindow = new BrowserWindow({
    ...overlayBounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
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

  overlayWindow.setBounds(overlayBounds)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.loadFile(path.join(__dirname, '../dist/overlay.html'))
  overlayWindow.on('closed', () => { overlayWindow = null; overlayBounds = null })
}

function createAnnotationWindow(croppedDataUrl) {
  if (annotationWindow) {
    annotationWindow.focus()
    return
  }

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
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    } catch {}
    if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true
  }

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

function triggerScreenshot() {
  if (overlayWindow) { overlayWindow.close(); return }
  if (annotationWindow) annotationWindow.close()
  createOverlayWindow()
}

// Close the tray menu (if open) then wait for its dismiss animation before
// showing the overlay. macOS suspends globalShortcut handlers while a native
// menu is open, so the menu item's click handler — fired via its accelerator —
// is the only path that runs. tray.closeContextMenu() + setTimeout ensures the
// NSMenu is fully gone before we create the overlay window.
function scheduleScreenshot() {
  if (tray) tray.closeContextMenu()
  setTimeout(triggerScreenshot, 150)
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Take Screenshot',
      accelerator: 'Alt+Command+B',
      click: scheduleScreenshot,
    },
    { type: 'separator' },
    { label: 'Launch at Login (requires signed app)', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
}

app.whenReady().then(async () => {
  // Menu-bar-only app: hide dock icon. The app won't appear in ⌘Tab — that is
  // expected macOS behavior for LSUIElement-style apps.
  if (process.platform === 'darwin') app.dock.hide()

  const allowed = await ensureScreenPermission()
  if (!allowed) return

  // ── Menu bar tray ──────────────────────────────────────────────────────────
  // Not a template image — the red rectangle must render in its actual color.
  // Electron auto-loads tray-icon@2x.png on Retina displays from the same directory.
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png')
  tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip('RedCap')
  tray.setContextMenu(buildTrayMenu())

  // ── Global shortcut ────────────────────────────────────────────────────────
  // Fires when no menu is open. Use scheduleScreenshot so any partially-closed
  // menu doesn't race with the overlay appearing.
  const ok = globalShortcut.register('Alt+Command+B', scheduleScreenshot)
  if (!ok) console.error('Failed to register global shortcut Alt+Command+B')
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.on('overlay-ready', () => {
  if (!overlayWindow || !overlayBounds) return
  overlayWindow.show()
  overlayWindow.setBounds(overlayBounds)
  // Re-assert after show() — macOS can reset the window level when a window becomes visible.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.focus()
})

ipcMain.on('cancel-selection', () => {
  if (overlayWindow) overlayWindow.close()
})

ipcMain.on('selection-complete', (_, { x, y, w, h }) => {
  if (!overlayWindow || !overlayBounds) return
  const screenX = overlayBounds.x + Math.round(x)
  const screenY = overlayBounds.y + Math.round(y)
  const selW = Math.round(w)
  const selH = Math.round(h)
  const actualBounds = overlayWindow.getBounds()
  dbg(`selection-complete: renderer x=${x} y=${y} w=${w} h=${h}`)
  dbg(`  overlayBounds=${JSON.stringify(overlayBounds)}`)
  dbg(`  actualWindowBounds=${JSON.stringify(actualBounds)}`)
  dbg(`  => screenX=${screenX} screenY=${screenY} w=${selW} h=${selH}`)
  dbg(`  displays=${JSON.stringify(screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds })))}`)
  if (actualBounds.y !== overlayBounds.y) {
    dbg(`  WARNING: window y clamped from ${overlayBounds.y} to ${actualBounds.y} — coordinates will be off by ${actualBounds.y - overlayBounds.y}px`)
  }

  overlayWindow.once('closed', () => {
    setTimeout(() => {
      const dataUrl = captureRegion(screenX, screenY, selW, selH)
      if (dataUrl) createAnnotationWindow(dataUrl)
    }, 80)
  })
  overlayWindow.close()
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
