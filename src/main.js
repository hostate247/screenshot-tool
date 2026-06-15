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
let overlayWindows = []   // one BrowserWindow per physical display
let overlayReadyCount = 0
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

function triggerScreenshot() {
  if (overlayWindows.length > 0) { closeAllOverlays(); return }
  if (annotationWindow) annotationWindow.close()
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

ipcMain.on('selection-complete', (event, { x, y, w, h }) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  if (!senderWin || senderWin.isDestroyed()) return

  // Use stored display.bounds (not win.getBounds()) so macOS window-position
  // clamping doesn't corrupt the screenshot coordinates.
  const entry = overlayWindows.find(o => o.win === senderWin)
  const originBounds = entry ? entry.display.bounds : senderWin.getBounds()
  const screenX = originBounds.x + Math.round(x)
  const screenY = originBounds.y + Math.round(y)
  const selW = Math.round(w)
  const selH = Math.round(h)

  dbg(`selection-complete: renderer x=${x} y=${y} w=${w} h=${h}`)
  dbg(`  originBounds (display)=${JSON.stringify(originBounds)} win.getBounds()=${JSON.stringify(senderWin.getBounds())}`)
  dbg(`  => screenX=${screenX} screenY=${screenY} w=${selW} h=${selH}`)
  dbg(`  displays=${JSON.stringify(screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })))}`)

  closeAllOverlays()
  setTimeout(() => {
    const dataUrl = captureRegion(screenX, screenY, selW, selH)
    if (dataUrl) createAnnotationWindow(dataUrl)
  }, 80)
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
