import React, { useEffect, useRef, useState, useCallback } from 'react'

export default function OverlayApp() {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const dragging = useRef(false)
  const startPos = useRef(null)
  const [selection, setSelection] = useState(null)

  // ── Canvas drawing ──────────────────────────────────────────────────────

  const redraw = useCallback((sel) => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const H = canvas.height

    // 1. Screenshot background
    ctx.drawImage(img, 0, 0, W, H)

    // 2. Dim overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fillRect(0, 0, W, H)

    if (sel && sel.w > 0 && sel.h > 0) {
      const { x, y, w, h } = sel

      // 3. Reveal selection by redrawing screenshot region
      const sx = x * (img.naturalWidth / W)
      const sy = y * (img.naturalHeight / H)
      const sw = w * (img.naturalWidth / W)
      const sh = h * (img.naturalHeight / H)
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)

      // 4. Selection border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([])
      ctx.strokeRect(x, y, w, h)

      // 5. Size label
      const labelText = `${Math.round(w * (img.naturalWidth / W))} × ${Math.round(h * (img.naturalHeight / H))}`
      const labelX = x + 4
      const labelY = y > 20 ? y - 6 : y + h + 14
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillText(labelText, labelX, labelY)
    }
  }, [])

  // ── Bootstrap ────────────────────────────────────────────────────────────

  useEffect(() => {
    // Canvas dimensions come from main process (display bounds), not window.innerWidth,
    // because the window is hidden at this point and layout may not have happened yet.
    window.electronAPI.onScreenshotData(({ dataUrl, width, height }) => {
      const canvas = canvasRef.current
      canvas.width = width
      canvas.height = height

      const img = new Image()
      img.onload = () => {
        imgRef.current = img
        redraw(null)
        window.electronAPI.overlayReady()
      }
      img.src = dataUrl
    })

    const onKey = (e) => {
      if (e.key === 'Escape') window.electronAPI.cancelSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [redraw])

  // Redraw when selection changes
  useEffect(() => {
    redraw(selection)
  }, [selection, redraw])

  // ── Mouse events ─────────────────────────────────────────────────────────

  const getPos = (e) => ({ x: e.clientX, y: e.clientY })

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    dragging.current = true
    startPos.current = getPos(e)
    setSelection(null)
  }

  const onMouseMove = (e) => {
    if (!dragging.current || !startPos.current) return
    const cur = getPos(e)
    setSelection({
      x: Math.min(startPos.current.x, cur.x),
      y: Math.min(startPos.current.y, cur.y),
      w: Math.abs(cur.x - startPos.current.x),
      h: Math.abs(cur.y - startPos.current.y),
    })
  }

  const onMouseUp = (e) => {
    if (!dragging.current) return
    dragging.current = false

    const cur = getPos(e)
    const x = Math.min(startPos.current.x, cur.x)
    const y = Math.min(startPos.current.y, cur.y)
    const w = Math.abs(cur.x - startPos.current.x)
    const h = Math.abs(cur.y - startPos.current.y)

    if (w < 4 || h < 4) {
      setSelection(null)
      return
    }

    // Crop the screenshot at native resolution
    const img = imgRef.current
    const canvas = canvasRef.current
    const scaleX = img.naturalWidth / canvas.width
    const scaleY = img.naturalHeight / canvas.height

    const crop = document.createElement('canvas')
    crop.width = Math.round(w * scaleX)
    crop.height = Math.round(h * scaleY)
    crop.getContext('2d').drawImage(
      img,
      x * scaleX, y * scaleY, w * scaleX, h * scaleY,
      0, 0, crop.width, crop.height,
    )

    window.electronAPI.selectionComplete(crop.toDataURL('image/png'))
  }

  return (
    <div
      style={{ width: '100%', height: '100%', cursor: 'crosshair' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  )
}
