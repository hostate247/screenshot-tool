import React, { useEffect, useRef } from 'react'

export default function OverlayApp() {
  const canvasRef = useRef(null)
  const dprRef = useRef(1)
  const dragging = useRef(false)
  const startPos = useRef(null)
  const selRef = useRef(null)
  const rafRef = useRef(null)

  const displayIndex = parseInt(new URLSearchParams(window.location.search).get('displayIndex') || '0', 10)

  function draw() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = dprRef.current
    const W = canvas.width / dpr
    const H = canvas.height / dpr

    ctx.clearRect(0, 0, W, H)

    const s = selRef.current
    if (s && s.w > 2 && s.h > 2) {
      const { x, y, w, h } = s

      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
      ctx.fillRect(0, 0, W, y)
      ctx.fillRect(0, y, x, h)
      ctx.fillRect(x + w, y, W - x - w, h)
      ctx.fillRect(0, y + h, W, H - y - h)

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([])
      ctx.strokeRect(x, y, w, h)

      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
      const label = `${Math.round(w)} × ${Math.round(h)}`
      const labelY = y > 20 ? y - 6 : y + h + 14
      ctx.fillText(label, x + 4, labelY)
    }
  }

  function scheduleDraw() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(draw)
  }

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

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    dragging.current = true
    startPos.current = { x: e.clientX, y: e.clientY }
    selRef.current = null
    scheduleDraw()
  }

  const onMouseMove = (e) => {
    if (!dragging.current || !startPos.current) return
    const { x: sx, y: sy } = startPos.current
    selRef.current = {
      x: Math.min(sx, e.clientX),
      y: Math.min(sy, e.clientY),
      w: Math.abs(e.clientX - sx),
      h: Math.abs(e.clientY - sy),
    }
    scheduleDraw()
  }

  const onMouseUp = (e) => {
    if (!dragging.current) return
    dragging.current = false
    const s = selRef.current
    if (!s || s.w < 4 || s.h < 4) {
      selRef.current = null
      scheduleDraw()
      return
    }
    window.electronAPI.selectionComplete(s)
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
