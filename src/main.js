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
const fs = require('fs')
const os = require('os')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let tray = null
let overlayWindows = []   // one BrowserWindow per physical display
let overlayReadyCount = 0
let annotationWindow = null
let capturePromise = Promise.resolve(new Map())  // resolves to Map<displayId, { dataUrl, scaleFactor, bounds }>

const dbg = (...args) => fs.appendFileSync(
  path.join(os.homedir(), 'Desktop', 'redcap-debug.log'),
  `${new Date().toISOString()} ${args.join(' ')}\n`
)

async function captureAllDisplays() {
  const displays = screen.getAllDisplays()

  // Match thumbnailSize to the largest native resolution so every display
  // is captured at full quality without upscaling.
  const maxW = Math.max(...displays.map(d => Math.ceil(d.bounds.width * d.scaleFactor)))
  const maxH = Math.max(...displays.map(d => Math.ceil(d.bounds.height * d.scaleFactor)))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
  })

  const map = new Map()
  for (let idx = 0; idx < sources.length; idx++) {
    const source = sources[idx]
    // Match by display_id (macOS); fall back to positional index
    const display = displays.find(d => String(d.id) === source.display_id) || displays[idx]
    if (!display) continue

    // Keep the NativeImage directly — calling toDataURL() on a full-screen Retina
    // image (e.g. 5120×2880) can take 2–4 seconds of main-thread PNG encoding.
    // We only encode the small cropped region later.
    const { width: thumbW, height: thumbH } = source.thumbnail.getSize()
    map.set(display.id, {
      nativeImg: source.thumbnail,
      thumbW,
      thumbH,
      bounds: display.bounds,
    })
    dbg(`captureAllDisplays: display[${idx}] id=${display.id} bounds=${display.bounds.width}x${display.bounds.height} thumb=${thumbW}x${thumbH}`)
  }
  return map
}

function closeAllOverlays() {
  const entries = [...overlayWindows]
  overlayWindows = []
  overlayReadyCount = 0
  for (const { win } of entries) {
    if (!win.isDestroyed()) win.close()
  }
}

function createOverlayWindows() {
  const displays = screen.getAllDisplays()
  overlayWindows = []
  overlayReadyCount = 0

  dbg(`createOverlayWindows: ${displays.length} display(s)`)
  displays.forEach((d, i) => dbg(`  display[${i}]: bounds=${JSON.stringify(d.bounds)} scaleFactor=${d.scaleFactor}`))

  displays.forEach((display, i) => {
    const { x, y, width, height } = display.bounds
    const win = new BrowserWindow({
      x, y, width, height,
      // 'panel' type (NSPanel) has different positioning rules on macOS
      // and is less likely to be clamped to the primary display.
      type: 'panel',
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

    // Log immediately after construction — before show() — to catch constructor-time clamping
    dbg(`  window[${i}] post-constructor getBounds()=${JSON.stringify(win.getBounds())}`)

    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // Force bounds NOW (before show) so macOS has the correct position before compositing starts
    win.setBounds({ x, y, width, height })
    dbg(`  window[${i}] pre-show setBounds(target) → getBounds()=${JSON.stringify(win.getBounds())}`)

    // Pass display index so renderer can pick a debug tint color
    win.loadFile(path.join(__dirname, '../dist/overlay.html'), { query: { displayIndex: i } })
    win.on('closed', () => { overlayWindows = overlayWindows.filter(o => o.win !== win) })

    // Store display alongside window so overlay-ready handler can re-assert bounds
    overlayWindows.push({ win, display })
  })
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

async function triggerScreenshot() {
  if (overlayWindows.length > 0) { closeAllOverlays(); return }
  if (annotationWindow) annotationWindow.close()

  // Fire capture immediately as a background promise so the overlay appears without delay.
  // Capture completes well before the user finishes dragging a selection (~200-500ms vs ~1s+).
  capturePromise = captureAllDisplays().catch(err => {
    dbg(`captureAllDisplays ERROR: ${err.message}`)
    return new Map()
  })

  createOverlayWindows()
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
  overlayReadyCount++
  dbg(`overlay-ready: ${overlayReadyCount}/${overlayWindows.length} windows ready`)
  if (overlayReadyCount < overlayWindows.length) return

  overlayWindows.forEach(({ win, display }, i) => {
    const { x, y, width, height } = display.bounds
    if (win.isDestroyed()) { dbg(`  window[${i}] already destroyed, skipping show()`); return }

    win.show()
    dbg(`  window[${i}] show() → getBounds()=${JSON.stringify(win.getBounds())}`)

    // Re-assert position after show() — macOS can clamp/reset when the window becomes visible.
    win.setBounds({ x, y, width, height })
    win.setPosition(x, y, false)   // false = no animation
    dbg(`  window[${i}] after setBounds+setPosition(false) → getBounds()=${JSON.stringify(win.getBounds())}`)

    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  })

  // Focus the window on whichever display the cursor is currently on
  const cursorPoint = screen.getCursorScreenPoint()
  dbg(`  cursor at ${JSON.stringify(cursorPoint)}`)
  const focusEntry = overlayWindows.find(({ display }) => {
    const { x, y, width, height } = display.bounds
    return cursorPoint.x >= x && cursorPoint.x < x + width &&
           cursorPoint.y >= y && cursorPoint.y < y + height
  }) || overlayWindows[0]
  if (focusEntry && !focusEntry.win.isDestroyed()) {
    focusEntry.win.focus()
    dbg(`  focused window[${overlayWindows.indexOf(focusEntry)}] bounds=${JSON.stringify(focusEntry.display.bounds)}`)
  }
})

ipcMain.on('cancel-selection', () => {
  closeAllOverlays()
})

ipcMain.on('selection-complete', async (event, { x, y, w, h }) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  if (!senderWin || senderWin.isDestroyed()) return

  const entry = overlayWindows.find(o => o.win === senderWin)
  const winBounds = senderWin.getBounds()
  const displayBounds = entry ? entry.display.bounds : winBounds

  dbg(`selection-complete: renderer x=${x} y=${y} w=${w} h=${h}`)
  dbg(`  win.getBounds()=${JSON.stringify(winBounds)} display.bounds=${JSON.stringify(displayBounds)}`)

  closeAllOverlays()

  // Await the capture that was started when the hotkey fired
  const capturedImages = await capturePromise
  capturePromise = Promise.resolve(new Map())

  const displayId = entry?.display.id
  const captured = capturedImages.get(displayId)

  if (!captured) {
    dbg('selection-complete: no captured image for display, aborting')
    return
  }

  const { nativeImg, thumbW, thumbH, bounds } = captured

  // Account for macOS window-position clamping (e.g. menu bar on primary display)
  const offsetX = winBounds.x - bounds.x
  const offsetY = winBounds.y - bounds.y

  // nativeImage.getSize() returns logical (DIP) pixels; derive the pixel ratio from
  // actual thumbnail dimensions vs display logical bounds — correct for any scale factor.
  const xRatio = thumbW / bounds.width
  const yRatio = thumbH / bounds.height

  const cropX = Math.round((offsetX + x) * xRatio)
  const cropY = Math.round((offsetY + y) * yRatio)
  const cropW = Math.round(w * xRatio)
  const cropH = Math.round(h * yRatio)

  dbg(`  offsetX=${offsetX} offsetY=${offsetY} thumbRatio=${xRatio.toFixed(3)}x${yRatio.toFixed(3)}`)
  dbg(`  crop: x=${cropX} y=${cropY} w=${cropW} h=${cropH}`)

  try {
    const safeX = Math.max(0, Math.min(cropX, thumbW - 1))
    const safeY = Math.max(0, Math.min(cropY, thumbH - 1))
    const safeW = Math.min(cropW, thumbW - safeX)
    const safeH = Math.min(cropH, thumbH - safeY)

    // Crop the NativeImage directly — then toDataURL() only encodes the small region.
    const cropped = nativeImg.crop({ x: safeX, y: safeY, width: safeW, height: safeH })
    createAnnotationWindow(cropped.toDataURL())
  } catch (err) {
    dbg(`selection-complete crop ERROR: ${err.message}`)
  }
})

ipcMain.on('mouse-debug', (_, data) => {
  dbg(`mouse-debug: ${JSON.stringify(data)}`)
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
