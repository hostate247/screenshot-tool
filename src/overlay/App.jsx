import React, { useEffect, useRef, useCallback, useState } from 'react'

const DEBUG_TINTS = ['rgba(255,0,0,0.2)', 'rgba(0,0,255,0.2)', 'rgba(0,255,0,0.2)', 'rgba(255,165,0,0.2)']

export default function OverlayApp() {
  const canvasRef = useRef(null)
  const dprRef = useRef(1)
  const dragging = useRef(false)
  const startPos = useRef(null)
  const [sel, setSel] = useState(null)

  const displayIndex = parseInt(new URLSearchParams(window.location.search).get('displayIndex') || '0', 10)
  const debugTint = DEBUG_TINTS[displayIndex] ?? 'rgba(255,255,0,0.2)'

  const draw = useCallback((selection) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width / dprRef.current
    const H = canvas.height / dprRef.current

    ctx.clearRect(0, 0, W, H)

    if (selection && selection.w > 0 && selection.h > 0) {
      const { x, y, w, h } = selection

      // Dim everything outside the selection
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
      ctx.fillRect(0, 0, W, y)                  // top
      ctx.fillRect(0, y, x, h)                  // left
      ctx.fillRect(x + w, y, W - x - w, h)      // right
      ctx.fillRect(0, y + h, W, H - y - h)      // bottom

      // Selection border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([])
      ctx.strokeRect(x, y, w, h)

      // Size label
      const label = `${Math.round(w)} × ${Math.round(h)}`
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
      const labelY = y > 20 ? y - 6 : y + h + 14
      ctx.fillText(label, x + 4, labelY)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const dpr = window.devicePixelRatio || 1
    dprRef.current = dpr
    canvas.width = window.innerWidth * dpr
    canvas.height = window.innerHeight * dpr
    canvas.getContext('2d').scale(dpr, dpr)

    window.electronAPI.overlayReady()
    window.electronAPI.mouseDebug({
      event: 'init',
      displayIndex,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      dpr,
    })

    const onKey = (e) => {
      if (e.key === 'Escape') window.electronAPI.cancelSelection()
    }

    // Throttled raw mousemove to confirm events reach this renderer
    let lastLog = 0
    const onRawMove = (e) => {
      const now = Date.now()
      if (now - lastLog < 500) return
      lastLog = now
      window.electronAPI.mouseDebug({
        event: 'mousemove',
        displayIndex,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
      })
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('mousemove', onRawMove)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousemove', onRawMove)
    }
  }, [])

  useEffect(() => { draw(sel) }, [sel, draw])

  const getPos = (e) => ({ x: e.clientX, y: e.clientY })

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    dragging.current = true
    startPos.current = getPos(e)
    setSel(null)
  }

  const onMouseMove = (e) => {
    if (!dragging.current || !startPos.current) return
    const cur = getPos(e)
    setSel({
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

    if (w < 4 || h < 4) { setSel(null); return }

    window.electronAPI.selectionComplete({ x, y, w, h })
  }

  return (
    <div
      style={{ width: '100%', height: '100%', cursor: 'crosshair', background: debugTint }}
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
