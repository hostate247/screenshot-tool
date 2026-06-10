// Playwright driver for screenshot-tool (macOS, no xvfb needed)
import { _electron as electron } from 'playwright-core'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = '/tmp/shots'
fs.mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = path.join(__dirname,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

// Tiny red-gradient PNG (100×80) as a stand-in for a real screenshot crop
const TEST_IMAGE_DATA_URL = generateTestImage()

let appInstance = null
let annotationPage = null

async function launch() {
  appInstance = await electron.launch({
    executablePath: electronBin,
    args: [__dirname],
    env: { ...process.env },
    timeout: 30_000,
  })
  console.log('app launched')
}

async function openAnnotation() {
  // Drive the app via its own IPC: emit 'selection-complete' with a test PNG
  await appInstance.evaluate(async ({ ipcMain }, dataUrl) => {
    // Simulate the overlay completing a selection
    ipcMain.emit('selection-complete', { sender: null }, dataUrl)
  }, TEST_IMAGE_DATA_URL)

  // Wait for annotation window to open (up to 5s)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const wins = appInstance.windows()
    const found = wins.find(w => !w.url().includes('overlay'))
    if (found) { annotationPage = found; break }
    await new Promise(r => setTimeout(r, 200))
  }
  if (!annotationPage) throw new Error('Annotation window never opened')
  await annotationPage.waitForLoadState('domcontentloaded')
  await new Promise(r => setTimeout(r, 800)) // let canvas draw
  console.log('annotation window ready:', annotationPage.url())
}

async function screenshot(name) {
  const p = path.join(SHOT_DIR, name + '.png')
  await annotationPage.screenshot({ path: p })
  console.log('screenshot saved:', p)
  return p
}

// ── Run ──────────────────────────────────────────────────────────────────────

try {
  await launch()
  await openAnnotation()
  const shot = await screenshot('01-annotation-window')

  // Click the Arrow tool button and screenshot again
  await annotationPage.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const arrowBtn = btns.find(b => b.title?.includes('Arrow'))
    if (arrowBtn) arrowBtn.click()
  })
  await new Promise(r => setTimeout(r, 200))
  await screenshot('02-arrow-tool-selected')

  // Click back to Rect tool
  await annotationPage.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const rectBtn = btns.find(b => b.title?.includes('Rectangle'))
    if (rectBtn) rectBtn.click()
  })
  await new Promise(r => setTimeout(r, 200))
  await screenshot('03-rect-tool-reselected')

  console.log('\nAll screenshots in', SHOT_DIR)
} catch (e) {
  console.error('FAILED:', e.message)
  process.exit(1)
} finally {
  if (appInstance) await appInstance.close().catch(() => {})
}

// ── helpers ───────────────────────────────────────────────────────────────────

function generateTestImage() {
  // 200×150 PNG with a red gradient — generated as base64 without external deps
  const { createCanvas } = (() => {
    try { return require('canvas') } catch { return null }
  })() ?? {}

  // Fallback: use a hard-coded small valid PNG (1×1 red pixel, scaled up by canvas)
  // We'll build it properly with a data URL of a simple gradient via an SVG rasterized
  // Actually simplest: use a real tiny PNG that decodes correctly
  const W = 200, H = 150
  // Build a minimal PNG manually: IHDR + IDAT (uncompressed) + IEND
  // This is a solid red 200x150 image
  const buf = buildRedPNG(W, H)
  return `data:image/png;base64,${buf.toString('base64')}`
}

function buildRedPNG(w, h) {
  // Minimal PNG encoder (no zlib — use stored blocks)
  const crc32 = makeCRC32()

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii')
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32BE(data.length, 0)
    const crcBuf = Buffer.allocUnsafe(4)
    crcBuf.writeInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
    return Buffer.concat([len, typeBytes, data, crcBuf])
  }

  // IHDR
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  // Raw scanlines: filter byte (0) + RGB per pixel
  const scanline = Buffer.allocUnsafe(1 + w * 3)
  scanline[0] = 0
  for (let x = 0; x < w; x++) {
    const g = Math.floor((x / w) * 80)
    scanline[1 + x * 3] = 200          // R
    scanline[1 + x * 3 + 1] = g        // G (slight gradient)
    scanline[1 + x * 3 + 2] = 50       // B
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => scanline))

  // Deflate stored blocks (no compression, type=0b01)
  const BSIZE = 65535
  const blocks = []
  for (let off = 0; off < raw.length; off += BSIZE) {
    const slice = raw.slice(off, off + BSIZE)
    const hdr = Buffer.allocUnsafe(5)
    const last = off + BSIZE >= raw.length ? 1 : 0
    hdr[0] = last
    hdr.writeUInt16LE(slice.length, 1)
    hdr.writeUInt16LE(~slice.length & 0xffff, 3)
    blocks.push(hdr, slice)
  }

  // zlib wrapper: CMF=0x78 FLG=0x01, adler32
  const cmf = Buffer.from([0x78, 0x01])
  const deflated = Buffer.concat([cmf, ...blocks, adler32(raw)])
  const idat = chunk('IDAT', deflated)

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    idat,
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function makeCRC32() {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return function crc32(buf) {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) | 0
  }
}

function adler32(buf) {
  let s1 = 1, s2 = 0
  for (const b of buf) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521 }
  const out = Buffer.allocUnsafe(4)
  out.writeUInt32BE((s2 << 16) | s1, 0)
  return out
}
