// Runs in the Electron main process context — launches annotation window directly
// Usage: electron test-open-annotation.js
const { app, BrowserWindow, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Build a small test PNG (300×200, red-to-blue gradient)
function makeTestPNG(w, h) {
  const crc32tbl = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc32tbl[i] = c
  }
  function crc32(buf) {
    let c = -1
    for (const b of buf) c = crc32tbl[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  function chunk(type, data) {
    const tb = Buffer.from(type, 'ascii')
    const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length, 0)
    const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
    return Buffer.concat([lb, tb, data, cb])
  }
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = ihdr[11] = ihdr[12] = 0

  const scanlines = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.allocUnsafe(1 + w * 3); row[0] = 0
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = Math.floor(200 * (1 - x / w))
      row[1 + x * 3 + 1] = Math.floor(60 + 80 * (y / h))
      row[1 + x * 3 + 2] = Math.floor(200 * (x / w))
    }
    scanlines.push(row)
  }
  const raw = Buffer.concat(scanlines)

  // Stored deflate
  const BSIZE = 32767
  const blocks = []
  for (let off = 0; off < raw.length; off += BSIZE) {
    const sl = raw.slice(off, Math.min(off + BSIZE, raw.length))
    const last = off + BSIZE >= raw.length ? 1 : 0
    const hdr = Buffer.allocUnsafe(5)
    hdr[0] = last
    hdr.writeUInt16LE(sl.length, 1)
    hdr.writeUInt16LE((~sl.length) & 0xffff, 3)
    blocks.push(hdr, sl)
  }
  let s1 = 1, s2 = 0
  for (const b of raw) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521 }
  const adler = Buffer.allocUnsafe(4); adler.writeUInt32BE((s2 << 16) | s1, 0)
  const deflated = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adler])

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.show()

  const pngBuf = makeTestPNG(300, 200)
  const dataUrl = `data:image/png;base64,${pngBuf.toString('base64')}`

  const img = nativeImage.createFromDataURL(dataUrl)
  const { width: iw, height: ih } = img.getSize()

  const win = new BrowserWindow({
    width: Math.max(480, iw + 48),
    height: Math.max(360, ih + 48 + 52),
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'src/preload-annotation.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, 'dist/annotation.html'))
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('image-data', dataUrl)
  })

  win.on('closed', () => app.quit())
})
