import React, { useEffect, useRef, useState, useCallback } from 'react'

const TOOL = { RECT: 'rect', ARROW: 'arrow' }
const STROKE = '#FF3B30'
const LINE_WIDTH = 3

export default function AnnotationApp() {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const shapesRef = useRef([])
  const [activeTool, setActiveTool] = useState(TOOL.RECT)
  const [loaded, setLoaded] = useState(false)
  const dragging = useRef(false)
  const startPos = useRef(null)
  const liveShape = useRef(null)

  // ── Drawing helpers ───────────────────────────────────────────────────────

  const drawArrow = (ctx, x1, y1, x2, y2) => {
    const headLen = Math.max(12, Math.hypot(x2 - x1, y2 - y1) * 0.18)
    const angle = Math.atan2(y2 - y1, x2 - x1)

    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6),
    )
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6),
    )
    ctx.closePath()
    ctx.fill()
  }

  const redraw = useCallback((extra = null) => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)

    const all = extra ? [...shapesRef.current, extra] : shapesRef.current

    ctx.strokeStyle = STROKE
    ctx.fillStyle = STROKE
    ctx.lineWidth = LINE_WIDTH
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const s of all) {
      if (s.type === TOOL.RECT) {
        ctx.strokeRect(s.x, s.y, s.w, s.h)
      } else if (s.type === TOOL.ARROW) {
        drawArrow(ctx, s.x1, s.y1, s.x2, s.y2)
      }
    }
  }, [])

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    window.electronAPI.onImageData((dataUrl) => {
      const img = new Image()
      img.onload = () => {
        imgRef.current = img
        const canvas = canvasRef.current
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        redraw()
        setLoaded(true)
      }
      img.src = dataUrl
    })
  }, [redraw])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = async (e) => {
      if (!(e.metaKey || e.ctrlKey)) return

      if (e.key === 'c') {
        e.preventDefault()
        const canvas = canvasRef.current
        if (!canvas) return
        const dataUrl = canvas.toDataURL('image/png')
        await window.electronAPI.copyToClipboard(dataUrl)
      }

      if (e.key === 's') {
        e.preventDefault()
        const canvas = canvasRef.current
        if (!canvas) return
        const dataUrl = canvas.toDataURL('image/png')
        await window.electronAPI.saveImage(dataUrl)
      }

      if (e.key === 'z') {
        e.preventDefault()
        shapesRef.current = shapesRef.current.slice(0, -1)
        redraw()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [redraw])

  // ── Mouse events ──────────────────────────────────────────────────────────

  const getCanvasPos = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    }
  }

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    dragging.current = true
    startPos.current = getCanvasPos(e)
  }

  const onMouseMove = (e) => {
    if (!dragging.current || !startPos.current) return
    const cur = getCanvasPos(e)
    const s = startPos.current

    if (activeTool === TOOL.RECT) {
      liveShape.current = {
        type: TOOL.RECT,
        x: Math.min(s.x, cur.x),
        y: Math.min(s.y, cur.y),
        w: Math.abs(cur.x - s.x),
        h: Math.abs(cur.y - s.y),
      }
    } else {
      liveShape.current = { type: TOOL.ARROW, x1: s.x, y1: s.y, x2: cur.x, y2: cur.y }
    }

    redraw(liveShape.current)
  }

  const onMouseUp = () => {
    if (!dragging.current) return
    dragging.current = false

    if (liveShape.current) {
      const s = liveShape.current
      const tooSmall =
        (s.type === TOOL.RECT && s.w < 3 && s.h < 3) ||
        (s.type === TOOL.ARROW && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 5)

      if (!tooSmall) {
        shapesRef.current = [...shapesRef.current, liveShape.current]
      }
      liveShape.current = null
      redraw()
    }

    startPos.current = null
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.root}>
      <Toolbar activeTool={activeTool} onSelect={setActiveTool} />

      <div style={styles.canvasWrap}>
        {!loaded && <div style={styles.placeholder} />}
        <canvas
          ref={canvasRef}
          style={{ ...styles.canvas, cursor: 'crosshair', display: loaded ? 'block' : 'none' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
      </div>
    </div>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function Toolbar({ activeTool, onSelect }) {
  return (
    <div style={styles.toolbar}>
      <div style={styles.toolGroup}>
        <ToolBtn
          active={activeTool === TOOL.RECT}
          onClick={() => onSelect(TOOL.RECT)}
          title="Rectangle (R)"
        >
          <RectIcon />
        </ToolBtn>
        <ToolBtn
          active={activeTool === TOOL.ARROW}
          onClick={() => onSelect(TOOL.ARROW)}
          title="Arrow (A)"
        >
          <ArrowIcon />
        </ToolBtn>
      </div>

      <div style={styles.hints}>
        <span style={styles.hint}>⌘Z undo</span>
        <span style={styles.hintSep}>·</span>
        <span style={styles.hint}>⌘C copy</span>
        <span style={styles.hintSep}>·</span>
        <span style={styles.hint}>⌘S save</span>
      </div>
    </div>
  )
}

function ToolBtn({ active, onClick, title, children }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.toolBtn,
        background: active ? '#FF3B30' : hover ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: active ? '#fff' : hover ? '#fff' : '#aaa',
      }}
    >
      {children}
    </button>
  )
}

function RectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <polyline points="8,3 13,3 13,8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#1e1e1e',
    userSelect: 'none',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: 52,
    padding: '0 16px',
    background: '#252525',
    borderBottom: '1px solid #333',
    WebkitAppRegion: 'drag',
    flexShrink: 0,
  },
  toolGroup: {
    display: 'flex',
    gap: 2,
    WebkitAppRegion: 'no-drag',
    marginLeft: 70, // clear traffic light buttons
  },
  toolBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'background 0.12s, color 0.12s',
    outline: 'none',
  },
  hints: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    WebkitAppRegion: 'no-drag',
  },
  hint: {
    fontSize: 11,
    color: '#555',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  },
  hintSep: {
    fontSize: 11,
    color: '#3a3a3a',
  },
  canvasWrap: {
    flex: 1,
    overflow: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  canvas: {
    maxWidth: '100%',
    maxHeight: '100%',
    boxShadow: '0 2px 24px rgba(0,0,0,0.6)',
    borderRadius: 2,
  },
  placeholder: {
    width: 200,
    height: 150,
    background: '#2a2a2a',
    borderRadius: 4,
  },
}
