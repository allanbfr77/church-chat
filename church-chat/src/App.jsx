import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { db } from './firebase'
import { AVATARS, avatarUrl, INITIAL_AVATAR } from './avatars'
import {
  ref as dbRef,
  push,
  remove,
  set,
  update,
  onValue,
  onDisconnect,
  query,
  limitToLast,
  get,
  orderByChild,
  startAt,
  runTransaction,
} from 'firebase/database'

const ADMIN_CODE = 'invb'
const DAILY_RESET_TIME_ZONE = 'America/Sao_Paulo'
const DAILY_RESET_LOCK_MS = 2 * 60 * 1000
const DAILY_RESET_RETRY_MS = 15 * 1000

const DAILY_RESET_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: DAILY_RESET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function dailyResetDayKey(ts = Date.now()) {
  const parts = DAILY_RESET_DAY_FORMATTER.formatToParts(new Date(ts))
  const year = parts.find(part => part.type === 'year')?.value ?? '0000'
  const month = parts.find(part => part.type === 'month')?.value ?? '00'
  const day = parts.find(part => part.type === 'day')?.value ?? '00'
  return `${year}-${month}-${day}`
}

/** 00:00 do dia civil atual em DAILY_RESET_TIME_ZONE (ms UTC). */
function startOfResetDay(ts = Date.now()) {
  const dayKey = dailyResetDayKey(ts)
  const [year, month, day] = dayKey.split('-').map(Number)
  // America/Sao_Paulo: UTC−3 (sem horário de verão desde 2019)
  return Date.UTC(year, month - 1, day, 3, 0, 0, 0)
}

function filterMessagesFromToday(msgs, todayStartTs) {
  return msgs.filter(m => (m.ts || 0) >= todayStartTs)
}

/** Texto gravado no RTDB quando a mensagem é apagada (e exibido no chat) */
const MSG_APAGADA_FRASE = 'Esta mensagem foi apagada'
/** Valor antigo — ainda reconhecido como apagada para mensagens já salvas */
const LEGACY_MSG_SENTINEL = '__MSG_REMOVIDA__'

// Emojis rápidos (o teclado do sistema também funciona no campo de mensagem)
const EMOJI_PALETTE = [
  '😀', '😂', '🥰', '😍', '😘', '😊', '😅', '🤣', '😭', '😢', '🙏',
  '👍', '👎', '👏', '🙌', '🤝', '💪', '🔥', '❤️', '💯', '✨', '🎉',
  '👀', '😎', '🤔', '😴', '😤', '🤗', '✅', '❌', '⭐', '💕', '💬',
]

// ── Helpers ──────────────────────────────────────────────────
// Chave estável do nome (sem acento, minúsculas, sem caracteres proibidos em chaves do Firebase)
function nameKey(n) {
  return String(n || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').replace(/[.$#\[\]\/]/g, '_') || '_'
}

// Chave do avatar no Firebase (o id é o nome do arquivo, que tem "." — proibido em chaves)
function avatarKey(id) {
  return String(id || '').replace(/[.$#\[\]\/]/g, '_')
}

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36) }
function timeStr(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}
function fmtSize(b) {
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}
function fileIcon(type) {
  if (!type) return '📎'
  if (type.startsWith('image/')) return '🖼️'
  if (type.startsWith('video/')) return '🎥'
  if (type.startsWith('audio/')) return '🎵'
  if (type.includes('pdf')) return '📄'
  if (type.includes('word') || type.includes('document')) return '📝'
  if (type.includes('sheet') || type.includes('excel')) return '📊'
  if (type.includes('zip') || type.includes('rar')) return '🗜️'
  return '📎'
}
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result)
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

/** Remove quebras de linha do texto do chat (exibição e persistência). */
// Detecta URLs (com protocolo, www. ou domínio.tld) e devolve nós React; só http(s) vira link
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>]+|(?<![\w@.\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|edu|gov|io|me|app|dev|info|biz|tv|co|br|pt|us|uk|ar|cl|mx|de|fr|es|it|ly|xyz|site|online|store|shop)(?![a-z0-9-])(?:[\/?#][^\s<>]*)?/gi

function linkifyText(text) {
  const str = String(text ?? '')
  const out = []
  let last = 0
  let key = 0
  for (const match of str.matchAll(LINK_RE)) {
    let url = match[0]
    // pontuação final não faz parte do link; ")" só sai se não houver "(" correspondente
    for (;;) {
      const c = url[url.length - 1]
      if (/[.,;:!?'"\]}]/.test(c)) url = url.slice(0, -1)
      else if (c === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1)
      else break
    }
    if (!url || /^[a-z]+:\/\/$/i.test(url)) continue
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`
    try {
      const u = new URL(href)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    } catch { continue }
    if (match.index > last) out.push(str.slice(last, match.index))
    out.push(
      <a key={key++} className="chatMsgLink" href={href} target="_blank" rel="noopener noreferrer">{url}</a>,
    )
    last = match.index + url.length
  }
  if (!out.length) return str
  if (last < str.length) out.push(str.slice(last))
  return out
}

function notifBody(m) {
  const t = collapseChatLineBreaks(m.text || '')
  if (t) return t
  if (m.file?.type && String(m.file.type).startsWith('audio/')) return 'Mensagem de voz'
  return m.file ? 'Enviou um arquivo' : ''
}

function fmtDuration(sec) {
  const t = Math.max(0, Math.round(sec || 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

const VOICE_MAX_SECS = 120

// Transcrição via função serverless (Whisper). Roda após o envio e grava o texto na mensagem.
async function transcribeVoiceMessage(messageId, dataUrl) {
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, dataUrl }),
    })
    if (!res.ok) return
    const { text } = await res.json()
    if (text && text.trim()) await set(dbRef(db, `messages/${messageId}/file/transcript`), text.trim())
  } catch (err) {
    console.error('transcribe', err)
  }
}

function Ticks({ level }) {
  // level: 1 enviado, 2 entregue, 3 lido
  const color = level >= 3 ? '#FFD700' : 'rgba(255,255,255,0.6)'
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label={level >= 3 ? 'Lida' : level === 2 ? 'Entregue' : 'Enviada'}>
      <path d="m1.5 7.5 3.5 3.5L12 3" />
      {level >= 2 && <path d="m8 10.5.5.5L16 3" />}
    </svg>
  )
}

function AudioBubble({ file }) {
  const src = file.dataUrl || file.url
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(file.duration || 0)

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }
  const seek = e => {
    const a = audioRef.current
    const d = a?.duration && isFinite(a.duration) ? a.duration : dur
    if (!a || !d) return
    const r = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * d
  }
  const total = dur || 0
  return (
    <div className="chatAudio">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(0) }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={e => { if (isFinite(e.currentTarget.duration)) setDur(e.currentTarget.duration) }}
      />
      <button type="button" className="chatAudioBtn" onClick={toggle} aria-label={playing ? 'Pausar' : 'Reproduzir'}>
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
        )}
      </button>
      <div className="chatAudioMain">
        <div className="chatAudioTrack" onClick={seek}>
          <div className="chatAudioFill" style={{ width: total ? `${Math.min(100, (pos / total) * 100)}%` : 0 }} />
        </div>
        <div className="chatAudioTime">{fmtDuration(playing || pos > 0 ? pos : total)}</div>
      </div>
      {file.transcript && <div className="chatAudioTranscript">{file.transcript}</div>}
    </div>
  )
}

const REACTION_EMOJIS = ['👍', '❤️', '🙏', '😂', '😮', '✅']

// Resumo curto da mensagem para citação (preserva mesmo se a original for apagada)
function replySnippet(m) {
  const t = notifBody(m).trim()
  if (t) return t.length > 90 ? `${t.slice(0, 90)}…` : t
  if (m.file?.type && String(m.file.type).startsWith('audio/')) return 'Mensagem de voz'
  return m.file ? (fileLooksLikeImage(m.file, m.file.dataUrl || m.file.url) ? 'Imagem' : (m.file.name || 'Arquivo')) : ''
}

const GROUP_GAP_MS = 5 * 60 * 1000
// Mensagens seguidas da mesma pessoa (com menos de 5 min entre elas) formam um grupo
function sameMsgGroup(a, b) {
  return !!a && !!b && !messageIsTombstone(a) && !messageIsTombstone(b)
    && a.uid === b.uid && Math.abs((b.ts || 0) - (a.ts || 0)) < GROUP_GAP_MS
}

function collapseChatLineBreaks(str) {
  return String(str ?? '').replace(/\r\n|\r|\n/g, ' ')
}

/** PWA aberta como app (fora do navegador em aba) */
function isStandalonePWA() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true
  if (window.navigator.standalone === true) return true
  return false
}

function isIOSDevice() {
  if (typeof navigator === 'undefined') return false
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function isAndroidDevice() {
  if (typeof navigator === 'undefined') return false
  return /Android/i.test(navigator.userAgent)
}

function isMobileDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (isIOSDevice() || isAndroidDevice()) return true
  return window.matchMedia?.('(pointer: coarse)').matches === true
}

const VIEWPORT_DEFAULT = 'width=device-width, initial-scale=1.0, viewport-fit=cover'
const VIEWPORT_NO_ZOOM = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
const IMAGE_ZOOM_MIN = 1
const IMAGE_ZOOM_MAX = 5

function touchDistance(touches) {
  if (touches.length < 2) return 0
  const [a, b] = touches
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
}

/** Mensagem apagada pelo remetente (status, boolean, texto legado ou metadados) */
function messageIsTombstone(m) {
  if (!m) return false
  if (m.status === 'deleted') return true
  if (m.deleted === true || m.deleted === 1 || m.deleted === 'true' || m.deleted === '1') return true
  const t = String(m.text ?? '').trim()
  if (t === LEGACY_MSG_SENTINEL) return true
  const hasFile = !!(m.file && (m.file.dataUrl || m.file.url || m.file.name))
  if (typeof m.deletedAt === 'number' && m.deletedAt > 0 && !hasFile && !t) return true
  if (t === MSG_APAGADA_FRASE && typeof m.deletedAt === 'number' && m.deletedAt > 0) return true
  return false
}

// ── Logo Component ───────────────────────────────────────────
function Logo({ size = 'lg' }) {
  const h = size === 'lg' ? 90 : 32
  return <img src="/images/logo.png" style={{ height: h, objectFit: 'contain', display: 'block' }} alt="Nova Vida Botafogo" />
}

// ── User Color ────────────────────────────────────────────────
const USER_COLORS = [
  '#FFD700', // gold
  '#FF6B6B', // coral
  '#4FC3F7', // sky blue
  '#81C784', // mint green
  '#CE93D8', // lavender
  '#FFAB40', // orange
  '#4DD0E1', // cyan
  '#F06292', // pink
  '#AED581', // lime
  '#FF8A65', // deep orange
  '#80DEEA', // light cyan
  '#FFD54F', // amber
]
// Cores atribuídas (nome -> cor): vêm da presença (quem está online) e das mensagens já enviadas,
// para que duas pessoas diferentes não fiquem com a mesma cor
const COLOR_REGISTRY = new Map()
function colorHashIndex(name) {
  const key = (name || '').toLowerCase()
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash)
    hash |= 0
  }
  return Math.abs(hash) % USER_COLORS.length
}
// Escolhe a cor preferida do nome (pelo hash) ou a próxima livre
function pickFreeColor(name, used) {
  const pref = colorHashIndex(name)
  for (let i = 0; i < USER_COLORS.length; i++) {
    const c = USER_COLORS[(pref + i) % USER_COLORS.length]
    if (!used.has(c)) return c
  }
  return USER_COLORS[pref]
}
const AVATAR_REGISTRY = new Map() // nome (minúsculo) -> id do avatar
function avatarOf(name) {
  return avatarUrl(AVATAR_REGISTRY.get(String(name || '').trim().toLowerCase()))
}
function userColor(name) {
  const known = COLOR_REGISTRY.get(String(name || '').trim().toLowerCase())
  if (known) return known
  const key = (name || '').toLowerCase()
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash)
    hash |= 0
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

/** Primeira letra para avatar (suporta caracteres compostos) */
function nameInitial(name) {
  const t = String(name ?? '').trim()
  if (!t) return '?'
  const ch = Array.from(t)[0]
  try {
    return ch.toLocaleUpperCase('pt-BR')
  } catch {
    return ch.toUpperCase()
  }
}

// ── Persistent Session ────────────────────────────────────────
function getStoredSession() {
  try {
    const raw = localStorage.getItem('cruch_session')
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}
function saveSession(userId, name, isAdmin = false, avatar = null) {
  try { localStorage.setItem('cruch_session', JSON.stringify({ userId, name, isAdmin, avatar })) } catch {}
}
function clearSession() {
  try { localStorage.removeItem('cruch_session') } catch {}
}

const DAILY_RESET_CACHE_KEY = 'cruch_daily_reset_day'

function getCachedDailyResetDay() {
  try { return localStorage.getItem(DAILY_RESET_CACHE_KEY) } catch { return null }
}

function cacheDailyResetDay(dayKey) {
  try { localStorage.setItem(DAILY_RESET_CACHE_KEY, dayKey) } catch {}
}

// ── File Preview ──────────────────────────────────────────────
function fileLooksLikeImage(file, src) {
  if (file.type && String(file.type).startsWith('image/')) return true
  if (typeof src === 'string' && src.startsWith('data:image/')) return true
  return /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i.test(String(file.name || ''))
}

function ChatImageLightbox({ src, fileName, onClose }) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const pinchRef = useRef({ dist: 0, baseScale: 1 })
  const panRef = useRef({ active: false, x: 0, y: 0, ox: 0, oy: 0 })
  const scaleRef = useRef(1)
  scaleRef.current = scale

  useEffect(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [src])

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const historyPushed = useRef(false)
  const [dlState, setDlState] = useState('idle') // idle | loading | done
  const dlTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(dlTimerRef.current), [])

  // Fecha via UI: desfaz a entrada de histórico (se houver) para o "voltar" do sistema ficar consistente
  const requestClose = () => {
    if (historyPushed.current) window.history.back()
    else onCloseRef.current()
  }

  useEffect(() => {
    const onPop = () => {
      historyPushed.current = false
      onCloseRef.current()
    }
    try {
      // StrictMode (dev) monta duas vezes: não empilha uma segunda entrada
      if (!window.history.state?.chatImageLightbox) {
        window.history.pushState({ chatImageLightbox: true }, '')
      }
      historyPushed.current = true
    } catch {}
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [])

  const handleDownload = async e => {
    e.stopPropagation()
    if (dlState === 'loading') return
    setDlState('loading')
    const startedAt = Date.now()
    const day = new Date().toISOString().slice(0, 10)
    const nameExt = (String(fileName || '').match(/\.([a-z0-9]{2,5})$/i) || [])[1]
    let blob = null
    try {
      blob = await (await fetch(src)).blob()
    } catch {}
    const mimeExt = blob?.type ? blob.type.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*/, '') : ''
    const ext = (nameExt || mimeExt || 'jpg').toLowerCase()
    const a = document.createElement('a')
    a.href = blob ? URL.createObjectURL(blob) : src
    a.download = `imagem-${day}.${ext}`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (blob) setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    // garante um tempo mínimo de "carregando" para o feedback ser perceptível
    await new Promise(r => setTimeout(r, Math.max(0, 700 - (Date.now() - startedAt))))
    setDlState('done')
    dlTimerRef.current = setTimeout(() => setDlState('idle'), 1800)
  }

  const handleTouchStart = e => {
    if (e.touches.length === 2) {
      pinchRef.current = { dist: touchDistance(e.touches), baseScale: scaleRef.current }
    } else if (e.touches.length === 1 && scaleRef.current > 1) {
      panRef.current = {
        active: true,
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        ox: offset.x,
        oy: offset.y,
      }
    }
  }

  const handleTouchMove = e => {
    e.stopPropagation()
    if (e.touches.length === 2) {
      e.preventDefault()
      const dist = touchDistance(e.touches)
      if (pinchRef.current.dist > 0) {
        const next = Math.min(
          IMAGE_ZOOM_MAX,
          Math.max(IMAGE_ZOOM_MIN, pinchRef.current.baseScale * (dist / pinchRef.current.dist)),
        )
        setScale(next)
      }
    } else if (panRef.current.active && e.touches.length === 1) {
      e.preventDefault()
      const t = e.touches[0]
      setOffset({
        x: panRef.current.ox + (t.clientX - panRef.current.x),
        y: panRef.current.oy + (t.clientY - panRef.current.y),
      })
    }
  }

  const handleTouchEnd = () => {
    panRef.current.active = false
    pinchRef.current.dist = 0
    if (scaleRef.current <= 1) {
      setScale(1)
      setOffset({ x: 0, y: 0 })
    }
  }

  const pillBtnStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 48,
    minWidth: 132,
    padding: '0 22px',
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.22)',
    background: 'rgba(30,30,36,0.78)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: 0.2,
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.2s, transform 0.1s',
  }
  const dlBtnStyle = {
    ...pillBtnStyle,
    border: '1px solid rgba(255,215,0,0.55)',
    background: dlState === 'done'
      ? 'linear-gradient(135deg, #3fa66a, #2f8a55)'
      : 'linear-gradient(135deg, #C9A84C, #FFD700)',
    color: dlState === 'done' ? '#fff' : '#1a1300',
    cursor: dlState === 'loading' ? 'progress' : 'pointer',
  }
  const iconProps = {
    width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  }

  return createPortal(
    <div
      className="chat-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Imagem em tamanho grande"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        background: 'rgba(0,0,0,0.93)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        WebkitTapHighlightColor: 'transparent',
        padding:
          'max(12px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px))',
      }}
    >
      <div
        style={{
          position: 'fixed',
          bottom: 'max(16px, env(safe-area-inset-bottom, 0px))',
          left: 0,
          right: 0,
          zIndex: 401,
          display: 'flex',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        <style>{`@keyframes lbSpin { to { transform: rotate(360deg) } }`}</style>
        <button type="button" aria-label="Voltar ao chat" onClick={requestClose} style={pillBtnStyle}>
          <svg {...iconProps}><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
          Voltar
        </button>
        <button
          type="button"
          aria-label="Baixar imagem"
          aria-busy={dlState === 'loading'}
          onClick={handleDownload}
          style={dlBtnStyle}
        >
          {dlState === 'loading' ? (
            <svg {...iconProps} style={{ animation: 'lbSpin 0.8s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.2-8.55" /></svg>
          ) : dlState === 'done' ? (
            <svg {...iconProps}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          ) : (
            <svg {...iconProps}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
          )}
          {dlState === 'loading' ? 'Baixando…' : dlState === 'done' ? 'Baixado' : 'Baixar'}
        </button>
      </div>
      <div
        className="chat-image-lightbox-stage"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onClick={e => e.stopPropagation()}
        style={{
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
          minHeight: 0,
          width: '100%',
          maxHeight: '100%',
          overflow: 'hidden',
          touchAction: 'none',
        }}
      >
        <img
          src={src}
          alt={fileName || 'Imagem enviada no chat'}
          draggable={false}
          style={{
            maxWidth: '100%',
            maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 150px)',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            borderRadius: 4,
            boxShadow: '0 12px 48px rgba(0,0,0,0.65)',
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: scale <= 1 ? 'transform 0.15s ease-out' : 'none',
            pointerEvents: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        />
      </div>
    </div>,
    document.body,
  )
}

function FilePreview({ file, mine }) {
  const src = file.dataUrl || file.url
  const [fullOpen, setFullOpen] = useState(false)

  if (src && String(file.type || '').startsWith('audio/')) return <AudioBubble file={file} />

  if (fileLooksLikeImage(file, src)) {
    if (!src) {
      return (
        <div style={{ fontSize: 12, color: 'rgba(212,175,55,0.45)', marginBottom: 4 }}>
          Imagem indisponível · {file.name || 'arquivo'}
        </div>
      )
    }
    return (
      <>
        <div style={{ marginBottom: 4 }}>
          <button
            type="button"
            onClick={() => setFullOpen(true)}
            aria-label="Ver imagem em tamanho grande"
            style={{
              display: 'block',
              padding: 0,
              margin: 0,
              border: `1px solid ${mine ? 'rgba(255,255,255,0.12)' : 'rgba(212,175,55,0.28)'}`,
              background: mine ? 'rgba(0,0,0,0.25)' : 'rgba(212,175,55,0.06)',
              borderRadius: 10,
              overflow: 'hidden',
              cursor: 'pointer',
              width: '100%',
              maxWidth: 220,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <div style={{ width: '100%', height: 120, position: 'relative' }}>
              <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            </div>
          </button>
          <div style={{ fontSize: 10, color: 'rgba(212,175,55,0.45)', marginTop: 4 }}>
            {file.name} · {fmtSize(file.size)} · toque para ampliar
          </div>
        </div>
        {fullOpen && (
          <ChatImageLightbox
            src={src}
            fileName={file.name}
            onClose={() => setFullOpen(false)}
          />
        )}
      </>
    )
  }
  return (
    <a
      href={src} download={file.name}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: mine ? 'rgba(0,0,0,0.35)' : 'rgba(212,175,55,0.06)',
        borderRadius: 10, padding: '10px 12px', marginBottom: 4,
        textDecoration: 'none', border: '1px solid rgba(212,175,55,0.2)',
      }}
    >
      <span style={{ fontSize: 24, flexShrink: 0 }}>{fileIcon(file.type)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {file.name}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(212,175,55,0.5)', marginTop: 2 }}>
          {fmtSize(file.size)} · baixar
        </div>
      </div>
    </a>
  )
}

// ── Online Users Modal ────────────────────────────────────────
function OnlineModal({ users, onClose }) {
  return (
    <div style={sm.overlay} onClick={onClose}>
      <div style={sm.panel} onClick={e => e.stopPropagation()}>
        <div style={sm.header}>
          <span style={sm.title}>Online agora</span>
          <button style={sm.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={sm.list}>
          {users.length === 0 && (
            <div style={sm.empty}>Ninguém online no momento</div>
          )}
          {users.map((u, i) => (
            <div key={i} style={sm.userRow}>
              {avatarOf(u)
                ? <img src={avatarOf(u)} alt="" style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${userColor(u)}` }} />
                : <div style={{ ...sm.dot, background: userColor(u), boxShadow: `0 0 6px ${userColor(u)}` }} />}
              <span style={{ ...sm.userName, color: userColor(u) }}>{u}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const sm = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
    paddingTop: 'max(62px, calc(16px + env(safe-area-inset-top, 0px)))',
    paddingRight: 'max(16px, env(safe-area-inset-right, 0px))',
    paddingBottom: 0,
    paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))',
  },
  panel: { background: '#0a0a0a', border: '1px solid rgba(212,175,55,0.4)', borderRadius: 14, minWidth: 200, boxShadow: '0 8px 40px rgba(0,0,0,0.8), 0 0 24px rgba(212,175,55,0.08)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(212,175,55,0.15)' },
  title: { fontSize: 11, fontWeight: 700, color: '#D4AF37', letterSpacing: '0.08em', textTransform: 'uppercase' },
  closeBtn: { background: 'none', border: 'none', color: 'rgba(212,175,55,0.5)', fontSize: 14, cursor: 'pointer', padding: '0 2px' },
  list: { padding: '6px 0', maxHeight: 260, overflowY: 'auto' },
  userRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px' },
  dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  userName: { fontSize: 15, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' },
  empty: { fontSize: 13, color: 'rgba(255,255,255,0.3)', padding: '10px 16px' },
}

// ── Main App ──────────────────────────────────────────────────
export default function App() {
  const stored = getStoredSession()
  const [userId]      = useState(() => stored?.userId || uid())
  const [name, setName]               = useState(stored?.name || '')
  const [avatar, setAvatar]           = useState(() => (avatarUrl(stored?.avatar) || stored?.avatar === INITIAL_AVATAR ? stored.avatar : null))
  const avatarRef = useRef(avatar)
  avatarRef.current = avatar
  const [joined, setJoined]           = useState(!!stored?.name)
  const [messages, setMessages]       = useState([])
  const [messagesReady, setMessagesReady] = useState(false)
  const [input, setInput]             = useState('')
  const [onlineUsers, setOnlineUsers] = useState([])
  const [showOnline, setShowOnline]   = useState(false)
  const [sentIds, setSentIds]         = useState(new Set())
  const [pendingFile, setPendingFile] = useState(null)
  const [reading, setReading]         = useState(false)
  const [fileError, setFileError]     = useState('')
  const [nameError, setNameError]     = useState('')
  const [claiming, setClaiming]       = useState(false)
  const [sending, setSending]         = useState(false)
  const [isAdmin, setIsAdmin]         = useState(stored?.isAdmin || false)
  const [adminCode, setAdminCode]     = useState('')
  const [showAdminInput, setShowAdminInput] = useState(false)
  const [clearing, setClearing]       = useState(false)
  const [notifPerm, setNotifPerm]     = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  )
  /** Chrome/Edge Android: evento nativo “Instalar app” */
  const [pwaInstallDeferred, setPwaInstallDeferred] = useState(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showPlusMenu, setShowPlusMenu] = useState(false)
  const [replyingTo, setReplyingTo] = useState(null)   // { id, name, text }
  const [copiedId, setCopiedId] = useState(null)
  const [msgMenuId, setMsgMenuId] = useState(null)     // mensagem com menu (reagir / responder) aberto
  const longPressRef = useRef(null)
  const swipeRef = useRef({ x: 0, y: 0, dx: 0, active: false })
  const msgAreaRef = useRef(null)
  const atBottomRef = useRef(true)
  const [newMsgCount, setNewMsgCount] = useState(0)
  const [showJump, setShowJump] = useState(false)
  const [visTick, setVisTick] = useState(0)
  const deliveredRef = useRef(new Set())
  const readRef = useRef(new Set())
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const recRef = useRef({ rec: null, chunks: [], stream: null, timer: null, cancelled: false, start: 0 })
  /** Snapshot bruto de `typing/` (reavaliado no relógio para sumir entradas velhas sem novo evento) */
  const [typingSnap, setTypingSnap]     = useState(null)
  const [typingUsers, setTypingUsers]   = useState([])
  const [editingId, setEditingId]       = useState(null)
  const [editDraft, setEditDraft]       = useState('')
  const [msgActionBusy, setMsgActionBusy] = useState(null)
  const [confirmDialog, setConfirmDialog]   = useState(null)
  const bottomRef    = useRef(null)
  const connIdRef    = useRef(uid())
  const myColorRef   = useRef(null)
  const [presenceColors, setPresenceColors] = useState({})
  const [presenceAvatars, setPresenceAvatars] = useState({})
  const [takenAvatars, setTakenAvatars] = useState(() => new Set()) // chaves em uso por outras pessoas
  const messageInputRef = useRef(null)

  // iOS: ao focar um campo que vai ficar atrás do teclado, o Safari rola a página inteira
  // (o header some e a tela vai pro meio do chat). Truque: no instante do foco o campo é
  // levado visualmente ao topo, então o iOS não rola nada; no frame seguinte ele volta e o
  // --kb posiciona a barra em cima do teclado. Use SEMPRE isto em vez de input.focus().
  const focusNoPan = el => {
    if (!el) return
    if (document.activeElement === el) return
    const top = el.getBoundingClientRect().top
    el.style.transform = `translateY(${-top}px)`
    el.style.opacity = '0'
    el.focus({ preventScroll: true })
    requestAnimationFrame(() => {
      el.style.transform = ''
      el.style.opacity = ''
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
    })
  }
  const fileRef      = useRef(null)
  const emojiPickerRef = useRef(null)
  const knownIdsRef  = useRef(null)
  const joinTimeRef  = useRef(Date.now())
  const userIdRef    = useRef(userId)
  const nameRef      = useRef(name)
  const joinedRef    = useRef(joined)
  nameRef.current = name
  joinedRef.current = joined
  const typingTimersRef = useRef({ idle: null, trailing: null })
  const lastTypingWriteRef = useRef(0)
  const serverTimeOffsetRef = useRef(0)
  const lastDailyResetSuccessRef = useRef(
    getCachedDailyResetDay() === dailyResetDayKey() ? getCachedDailyResetDay() : null,
  )
  const lastDailyResetAttemptRef = useRef({ dayKey: null, at: 0 })
  const messagesListenerGenRef = useRef(0)
  const messagesScrollInitRef = useRef(false)

  // ── Notificações ──
  const requestNotifPermission = async () => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') { setNotifPerm(Notification.permission); return }
    const perm = await Notification.requestPermission()
    setNotifPerm(perm)
  }

  const runPwaInstall = async () => {
    if (!pwaInstallDeferred) return
    try {
      await pwaInstallDeferred.prompt()
      await pwaInstallDeferred.userChoice
    } catch (_) { /* utilizador cancelou ou navegador recusou */ }
    setPwaInstallDeferred(null)
  }

  useEffect(() => {
    const onBeforeInstall = e => {
      e.preventDefault()
      setPwaInstallDeferred(e)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  }, [])

  // Mobile: bloqueia zoom da página na conversa (pinch + auto-zoom do iOS no input)
  useEffect(() => {
    if (!joined || !isMobileDevice()) return
    const meta = document.querySelector('meta[name="viewport"]')
    if (!meta) return
    const prev = meta.getAttribute('content') || VIEWPORT_DEFAULT
    meta.setAttribute('content', VIEWPORT_NO_ZOOM)

    const blockPinch = e => {
      if (document.querySelector('.chat-image-lightbox')) return
      if (e.touches?.length > 1) e.preventDefault()
    }
    const blockGesture = e => {
      if (document.querySelector('.chat-image-lightbox')) return
      e.preventDefault()
    }

    document.addEventListener('touchmove', blockPinch, { passive: false })
    document.addEventListener('gesturestart', blockGesture, { passive: false })
    document.addEventListener('gesturechange', blockGesture, { passive: false })
    document.addEventListener('gestureend', blockGesture, { passive: false })

    return () => {
      meta.setAttribute('content', prev)
      document.removeEventListener('touchmove', blockPinch)
      document.removeEventListener('gesturestart', blockGesture)
      document.removeEventListener('gesturechange', blockGesture)
      document.removeEventListener('gestureend', blockGesture)
    }
  }, [joined])

  useEffect(() => {
    const offsetRef = dbRef(db, '.info/serverTimeOffset')
    const unsub = onValue(offsetRef, snap => {
      const offset = Number(snap.val())
      serverTimeOffsetRef.current = Number.isFinite(offset) ? offset : 0
    })
    return () => unsub()
  }, [])

  // Notificações: no Android o caminho via Service Worker (showNotification) é o mais fiável.
  // Ícone absoluto e ficheiro existente (pwa-192) — URL /notif-icon.png ausente quebrava notifs em vários devices.
  // iOS: sem Web Push + FCM, o sistema só entrega bem com o app na Tela de Início e limites da Apple.
  async function fireNotif(senderName, text, messageId) {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const body = text
      ? (text.length > 80 ? text.slice(0, 80) + '…' : text)
      : '📎 Arquivo recebido'
    const tag = messageId ? `chat-${messageId}` : `chat-${Date.now()}`
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : ''
    const iconUrl = origin ? `${origin}/images/pwa-192x192.png` : '/images/pwa-192x192.png'

    const swOptions = {
      body,
      icon: iconUrl,
      badge: iconUrl,
      tag,
      lang: 'pt-BR',
      silent: false,
      data: { url: origin ? `${origin}/` : '/' },
    }
    if (!isIOSDevice()) swOptions.vibrate = [140, 60, 140]

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready
        await reg.showNotification(senderName, swOptions)
        return
      } catch (e) {
        console.warn('Notif via service worker:', e)
      }
    }

    try {
      new Notification(senderName, {
        body,
        icon: iconUrl,
        tag,
        lang: 'pt-BR',
        silent: false,
      })
    } catch (e) {
      console.warn('Notif via window:', e)
    }
  }

  // ── Admin ──
  const clearChat = () => {
    setConfirmDialog({
      title: 'Limpar histórico',
      body: 'Limpar todo o histórico do chat? Esta ação não pode ser desfeita.',
      variant: 'danger',
      confirmLabel: 'Limpar tudo',
      async onConfirm() {
        setClearing(true)
        try {
          await remove(dbRef(db, 'messages'))
          setMessages([])
          knownIdsRef.current = new Set()
        } catch (err) { console.error(err) }
        setClearing(false)
      },
    })
  }

  /** Remove indicador local de digitação e timers associados */
  const clearTypingBroadcast = () => {
    const T = typingTimersRef.current
    if (T.idle) { clearTimeout(T.idle); T.idle = null }
    if (T.trailing) { clearTimeout(T.trailing); T.trailing = null }
    lastTypingWriteRef.current = 0
    remove(dbRef(db, `typing/${userId}`)).catch(() => {})
  }

  /** Atualiza RTDB para outros verem "está digitando" (com throttle e parada automática) */
  const touchTypingBroadcast = textValue => {
    if (!joined) return
    const v = String(textValue ?? '').trim()
    if (!v) {
      clearTypingBroadcast()
      return
    }
    const r = dbRef(db, `typing/${userId}`)
    const now = Date.now()
    const T = typingTimersRef.current
    const writePayload = () => {
      lastTypingWriteRef.current = Date.now()
      const label = (nameRef.current || '').trim() || 'Alguém'
      set(r, { name: label, ts: lastTypingWriteRef.current }).catch(() => {})
    }
    if (now - lastTypingWriteRef.current >= 700) {
      if (T.trailing) { clearTimeout(T.trailing); T.trailing = null }
      writePayload()
    } else if (!T.trailing) {
      T.trailing = setTimeout(() => {
        T.trailing = null
        writePayload()
      }, 700 - (now - lastTypingWriteRef.current))
    }
    if (T.idle) clearTimeout(T.idle)
    T.idle = setTimeout(() => {
      T.idle = null
      clearTypingBroadcast()
    }, 2800)
  }

  // Reserva o nome: dois usuários diferentes não podem estar logados com o mesmo nome.
  // Várias abas da mesma pessoa (mesmo userId) são permitidas.
  const claimName = async nm => {
    const key = nameKey(nm)
    const connId = connIdRef.current
    const lockRef = dbRef(db, `nameLocks/${key}`)
    const res = await runTransaction(lockRef, cur => {
      const o = cur || {}
      if (Object.values(o).some(v => v !== userId)) return // nome em uso por outra pessoa: aborta
      return { ...o, [connId]: userId }
    })
    if (res.committed) {
      onDisconnect(dbRef(db, `nameLocks/${key}/${connId}`)).remove().catch(() => {})
    }
    return res.committed
  }

  // Mesma ideia do nome: um avatar só pode estar em uso por uma pessoa (várias abas da mesma pessoa ok)
  const claimAvatar = async id => {
    if (!id || id === INITIAL_AVATAR) return true
    const connId = connIdRef.current
    const lockRef = dbRef(db, `avatarLocks/${avatarKey(id)}`)
    const res = await runTransaction(lockRef, cur => {
      const o = cur || {}
      if (Object.values(o).some(v => v !== userId)) return
      return { ...o, [connId]: userId }
    })
    if (res.committed) {
      onDisconnect(dbRef(db, `avatarLocks/${avatarKey(id)}/${connId}`)).remove().catch(() => {})
    }
    return res.committed
  }

  const handleJoin = async () => {
    if (!name.trim() || claiming) return
    setNameError('')
    setClaiming(true)
    try {
      const ok = await claimName(name.trim())
      if (!ok) {
        setNameError('Este nome já está em uso por outra pessoa. Escolha outro.')
        setClaiming(false)
        return
      }
      const avOk = await claimAvatar(avatar)
      if (!avOk) {
        remove(dbRef(db, `nameLocks/${nameKey(name.trim())}/${connIdRef.current}`)).catch(() => {})
        setAvatar(null)
        setNameError('Este avatar já está em uso por outra pessoa. Escolha outro.')
        setClaiming(false)
        return
      }
    } catch (err) {
      console.error(err)
      // Sem conseguir verificar (ex.: regras do banco), não impede a entrada
    }
    setClaiming(false)
    const admin = adminCode.trim() === ADMIN_CODE
    saveSession(userId, name.trim(), admin, avatar)
    setIsAdmin(admin)
    joinTimeRef.current = Date.now()
    knownIdsRef.current = messages.length > 0
      ? new Set(messages.map(m => m.id))
      : null
    setJoined(true)
  }

  const handleExit = () => {
    clearTypingBroadcast()
    clearSession()
    setJoined(false)
    setIsAdmin(false)
    setName('')
    setAvatar(null)
    setAdminCode('')
    setShowAdminInput(false)
    setShowOnline(false)
    knownIdsRef.current = null
  }

  const getApproxServerNow = () => Date.now() + (Number(serverTimeOffsetRef.current) || 0)

  const runDailyResetDeletion = (dayKey, resetMetaRef) => {
    void update(dbRef(db), {
      messages: null,
      typing: null,
      'system/dailyReset': {
        dayKey,
        status: 'done',
        resetAt: getApproxServerNow(),
        resetBy: userIdRef.current || 'system',
      },
    })
      .then(() => {
        lastDailyResetSuccessRef.current = dayKey
        cacheDailyResetDay(dayKey)
      })
      .catch(err => {
        console.error('Falha ao zerar o chat automaticamente.', err)
        void set(resetMetaRef, {
          dayKey,
          status: 'error',
          failedAt: getApproxServerNow(),
          failedBy: userIdRef.current || 'system',
        }).catch(() => {})
      })
  }

  const ensureDailyChatReset = async () => {
    const now = getApproxServerNow()
    const dayKey = dailyResetDayKey(now)
    if (lastDailyResetSuccessRef.current === dayKey) return
    if (getCachedDailyResetDay() === dayKey) {
      lastDailyResetSuccessRef.current = dayKey
      return
    }

    const lastAttempt = lastDailyResetAttemptRef.current
    if (lastAttempt.dayKey === dayKey && now - lastAttempt.at < DAILY_RESET_RETRY_MS) return
    lastDailyResetAttemptRef.current = { dayKey, at: now }

    const resetMetaRef = dbRef(db, 'system/dailyReset')
    try {
      const tx = await runTransaction(resetMetaRef, current => {
        const sameDay = current?.dayKey === dayKey
        const alreadyDone = sameDay && current?.status === 'done'
        const runningFresh =
          sameDay &&
          current?.status === 'running' &&
          typeof current.startedAt === 'number' &&
          now - current.startedAt < DAILY_RESET_LOCK_MS

        if (alreadyDone || runningFresh) return
        return {
          dayKey,
          status: 'running',
          startedAt: now,
          startedBy: userIdRef.current || 'system',
        }
      }, { applyLocally: false })

      const meta = tx.snapshot?.val()
      if (!tx.committed) {
        if (meta?.dayKey === dayKey && meta?.status === 'done') {
          lastDailyResetSuccessRef.current = dayKey
          cacheDailyResetDay(dayKey)
        }
        return
      }

      // DELETE físico em background — a UI já filtra por ts >= meia-noite de hoje
      runDailyResetDeletion(dayKey, resetMetaRef)
    } catch (err) {
      console.error('Falha ao coordenar reset diário do chat.', err)
      await set(resetMetaRef, {
        dayKey,
        status: 'error',
        failedAt: getApproxServerNow(),
        failedBy: userIdRef.current || 'system',
      }).catch(() => {})
    }
  }

  // Meta do reset diário — evita transação desnecessária a cada reload
  useEffect(() => {
    const metaRef = dbRef(db, 'system/dailyReset')
    const unsub = onValue(metaRef, snap => {
      const meta = snap.val()
      const dayKey = dailyResetDayKey(getApproxServerNow())
      if (meta?.dayKey === dayKey && meta?.status === 'done') {
        lastDailyResetSuccessRef.current = dayKey
        cacheDailyResetDay(dayKey)
      }
    })
    return () => unsub()
  }, [])

  // Re-checa permissão quando o usuário volta para a aba (após mudar nas config do Chrome)
  useEffect(() => {
    const check = () => {
      if (typeof Notification !== 'undefined') setNotifPerm(Notification.permission)
      if (document.visibilityState === 'visible' && joinedRef.current) {
        window.setTimeout(() => void ensureDailyChatReset(), 2000)
      }
    }
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])

  // Reset diário adiado — só após entrar na sala, sem competir com a carga inicial
  useEffect(() => {
    if (!joined) return
    const deferId = window.setTimeout(() => void ensureDailyChatReset(), 2500)
    const intervalId = window.setInterval(() => void ensureDailyChatReset(), 30 * 1000)
    return () => {
      window.clearTimeout(deferId)
      window.clearInterval(intervalId)
    }
  }, [joined])

  // Pré-carrega mensagens ao abrir o app (antes de "Entrar") para eliminar delay na entrada
  useEffect(() => {
    const listenerGen = ++messagesListenerGenRef.current
    let gotSnapshot = false
    let unsub = () => {}
    let usingFallback = false

    const applyMessageSnapshot = data => {
      if (listenerGen !== messagesListenerGenRef.current) return
      gotSnapshot = true

      const todayStart = startOfResetDay(getApproxServerNow())

      if (!data) {
        setMessages(prev => (prev.length === 0 ? prev : []))
        setMessagesReady(true)
        return
      }

      let msgs = Object.entries(data).map(([id, v]) => ({ id, ...v }))
      msgs = filterMessagesFromToday(msgs, todayStart)
      msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
      const joinT = joinTimeRef.current
      const inRoom = joinedRef.current

      if (knownIdsRef.current === null) {
        knownIdsRef.current = new Set(msgs.map(m => m.id))
        if (inRoom) {
          msgs.forEach(m => {
            if (m.uid === userIdRef.current || messageIsTombstone(m)) return
            if ((m.ts || 0) >= joinT) {
              fireNotif((m.name || 'Alguém').toLocaleUpperCase('pt-BR'), notifBody(m), m.id)
            }
          })
        }
      } else if (inRoom) {
        msgs.forEach(m => {
          if (!knownIdsRef.current.has(m.id)) {
            knownIdsRef.current.add(m.id)
            if (m.uid !== userIdRef.current && !messageIsTombstone(m)) {
              fireNotif((m.name || 'Alguém').toLocaleUpperCase('pt-BR'), notifBody(m), m.id)
            }
          }
        })
      } else {
        msgs.forEach(m => knownIdsRef.current.add(m.id))
      }

      setMessages(msgs)
      setMessagesReady(true)
    }

    const todayStart = startOfResetDay(getApproxServerNow())
    const filteredQ = query(
      dbRef(db, 'messages'),
      orderByChild('ts'),
      startAt(todayStart),
      limitToLast(100),
    )
    const fallbackQ = query(
      dbRef(db, 'messages'),
      orderByChild('ts'),
      limitToLast(100),
    )

    const attachListener = (q, isFallback) => {
      return onValue(
        q,
        snap => applyMessageSnapshot(snap.val()),
        err => {
          if (!isFallback && !usingFallback) {
            console.warn('Query filtrada por ts indisponível; usando fallback.', err)
            usingFallback = true
            unsub()
            unsub = attachListener(fallbackQ, true)
          }
        },
      )
    }

    unsub = attachListener(filteredQ, false)

    const fallbackTimer = window.setTimeout(() => {
      if (gotSnapshot || usingFallback) return
      console.warn('Query filtrada demorou; usando fallback por ts.')
      usingFallback = true
      unsub()
      unsub = attachListener(fallbackQ, true)
    }, 600)

    return () => {
      window.clearTimeout(fallbackTimer)
      messagesListenerGenRef.current += 1
      unsub()
    }
  }, [userId])

  // Na tela de login: quais avatares já estão em uso por outras pessoas
  useEffect(() => {
    if (joined) return
    const off = onValue(
      dbRef(db, 'avatarLocks'),
      snap => {
        const taken = new Set()
        Object.entries(snap.val() || {}).forEach(([k, conns]) => {
          if (Object.values(conns || {}).some(u => u !== userId)) taken.add(k)
        })
        setTakenAvatars(taken)
        setAvatar(cur => (cur && taken.has(avatarKey(cur)) ? null : cur))
      },
      () => {},
    )
    return () => off()
  }, [joined, userId])

  // Presença real: cada aba logada registra uma conexão em presence/{uid}/{connId}; o servidor
  // remove sozinho (onDisconnect) ao fechar a aba/perder a conexão. Foco da aba não importa.
  useEffect(() => {
    if (!joined) {
      setOnlineUsers([])
      return
    }
    const connRef = dbRef(db, `presence/${userId}/${connIdRef.current}`)
    const lockKey = nameKey(nameRef.current)
    const lockAvatar = avatarRef.current
    const offConn = onValue(dbRef(db, '.info/connected'), snap => {
      if (snap.val() !== true) return
      // reafirma a reserva do nome (sessão restaurada ou reconexão); se outra pessoa tomou, sai
      claimName(nameRef.current).then(ok => {
        if (!ok) {
          handleExit()
          setNameError('Este nome já está em uso por outra pessoa. Escolha outro.')
          return
        }
        return claimAvatar(avatarRef.current).then(avOk => {
          if (!avOk) {
            handleExit()
            setNameError('Este avatar já está em uso por outra pessoa. Escolha outro.')
          }
        })
      }).catch(() => {})
      get(dbRef(db, 'presence'))
        .then(snap => {
          const used = new Set()
          Object.entries(snap.val() || {}).forEach(([u, conns]) => {
            if (u === userId) return
            const c = Object.values(conns || {})[0]?.color
            if (c) used.add(c)
          })
          if (!myColorRef.current || used.has(myColorRef.current)) {
            myColorRef.current = pickFreeColor(nameRef.current, used)
          }
        })
        .catch(() => { if (!myColorRef.current) myColorRef.current = userColor(nameRef.current) })
        .then(() => onDisconnect(connRef).remove())
        .then(() => set(connRef, { name: nameRef.current, ts: Date.now(), color: myColorRef.current, ...(avatarRef.current ? { avatar: avatarRef.current } : {}) }))
        .catch(() => {})
    })
    const offList = onValue(
      dbRef(db, 'presence'),
      snap => {
        const val = snap.val() || {}
        const entries = Object.values(val).map(conns => Object.values(conns || {})[0]).filter(e => e?.name)
        const colors = {}
        entries.forEach(e => { if (e.color) colors[String(e.name).trim().toLowerCase()] = e.color })
        setPresenceColors(colors)
        const avs = {}
        entries.forEach(e => { if (e.avatar) avs[String(e.name).trim().toLowerCase()] = e.avatar })
        setPresenceAvatars(avs)
        const names = entries.map(e => e.name)
        setOnlineUsers(names.length ? names : [nameRef.current])
      },
      () => setOnlineUsers([nameRef.current]),
    )
    return () => {
      offConn()
      offList()
      onDisconnect(connRef).cancel().catch(() => {})
      remove(connRef).catch(() => {})
      remove(dbRef(db, `nameLocks/${lockKey}/${connIdRef.current}`)).catch(() => {})
      if (lockAvatar) remove(dbRef(db, `avatarLocks/${avatarKey(lockAvatar)}/${connIdRef.current}`)).catch(() => {})
    }
  }, [joined, userId])

  // Rola ao fim quando chega mensagem nova — mas só se você já está no fim ou foi você quem enviou;
  // caso contrário mostra o botão "ir para o fim" com o contador de novas
  // Atualiza o registro de cores a cada render (mensagens antigas primeiro, presença por cima)
  messages.forEach(m => { if (m.color && m.name) COLOR_REGISTRY.set(String(m.name).trim().toLowerCase(), m.color) })
  Object.entries(presenceColors).forEach(([n, c]) => COLOR_REGISTRY.set(n, c))
  messages.forEach(m => { if (m.avatar && m.name) AVATAR_REGISTRY.set(String(m.name).trim().toLowerCase(), m.avatar) })
  Object.entries(presenceAvatars).forEach(([n, a]) => AVATAR_REGISTRY.set(n, a))

  const lastMsg = messages[messages.length - 1]
  const lastMsgId = lastMsg?.id
  useEffect(() => {
    if (!joined) return
    const first = !messagesScrollInitRef.current
    const mineLast = lastMsg?.uid === userId
    if (first || mineLast || atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: first ? 'auto' : 'smooth' })
      setNewMsgCount(0)
      setShowJump(false)
    } else if (lastMsg && !messageIsTombstone(lastMsg)) {
      setNewMsgCount(n => n + 1)
      setShowJump(true)
    }
    if (messages.length > 0) messagesScrollInitRef.current = true
  }, [lastMsgId, joined])

  const onMsgScroll = e => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = atBottom
    if (atBottom) {
      setShowJump(false)
      setNewMsgCount(0)
    } else {
      setShowJump(true)
    }
  }

  const jumpToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setNewMsgCount(0)
    setShowJump(false)
  }

  // Teclado virtual como overlay: o layout (página, header, fundo) não é redimensionado
  // (viewport meta overlays-content). Medimos só a área coberta pelo teclado (--kb) e
  // reservamos esse espaço na base do painel para o campo de texto ficar acima do teclado.
  // --app-top compensa o pan do visual viewport (iOS) para o header não se deslocar.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let raf = 0
    let lastKb = 0
    const apply = () => {
      raf = 0
      // iOS 26: depois de fechar o teclado o visualViewport fica alguns px menor que a
      // janela, e esse resto virava uma faixa vazia embaixo. Só conta como teclado acima de 100px.
      const gap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      const kb = gap > 100 ? gap : 0
      root.style.setProperty('--kb', `${kb}px`)
      root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`)
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
      if (kb > lastKb && atBottomRef.current) {
        bottomRef.current?.scrollIntoView({ behavior: 'auto' })
      }
      lastKb = kb
    }
    const sync = () => { if (!raf) raf = requestAnimationFrame(apply) }
    apply()
    vv.addEventListener('resize', sync)
    vv.addEventListener('scroll', sync)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      vv.removeEventListener('resize', sync)
      vv.removeEventListener('scroll', sync)
      root.style.removeProperty('--kb')
      root.style.removeProperty('--app-top')
    }
  }, [])

  // Recibos: marca como entregue ao receber e como lida quando a aba está visível
  useEffect(() => {
    const bump = () => setVisTick(t => t + 1)
    document.addEventListener('visibilitychange', bump)
    window.addEventListener('focus', bump)
    return () => {
      document.removeEventListener('visibilitychange', bump)
      window.removeEventListener('focus', bump)
    }
  }, [])

  useEffect(() => {
    if (!joined) return
    const visible = document.visibilityState === 'visible'
    const upd = {}
    messages.forEach(m => {
      if (m.uid === userId || messageIsTombstone(m)) return
      if (!m.deliveredTo?.[userId] && !deliveredRef.current.has(m.id)) {
        deliveredRef.current.add(m.id)
        upd[`messages/${m.id}/deliveredTo/${userId}`] = true
      }
      if (visible && !m.readBy?.[userId] && !readRef.current.has(m.id)) {
        readRef.current.add(m.id)
        upd[`messages/${m.id}/readBy/${userId}`] = true
      }
    })
    if (Object.keys(upd).length) update(dbRef(db), upd).catch(() => {})
  }, [messages, joined, userId, visTick])

  useEffect(() => {
    if (!showEmojiPicker && !showPlusMenu) return
    const close = e => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target)) {
        setShowEmojiPicker(false)
        setShowPlusMenu(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showEmojiPicker, showPlusMenu])

  useEffect(() => {
    if (!msgMenuId) return
    const close = e => {
      if (!e.target.closest?.('[data-msg-menu]')) setMsgMenuId(null)
    }
    const onKey = e => { if (e.key === 'Escape') setMsgMenuId(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('touchstart', close, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('touchstart', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [msgMenuId])

  // Presença em `typing/`: limpar ao cair conexão; remover entrada ao sair da sala
  useEffect(() => {
    if (!joined) return
    const selfTypingRef = dbRef(db, `typing/${userId}`)
    const connectedRef = dbRef(db, '.info/connected')
    const unsub = onValue(connectedRef, snap => {
      if (snap.val() === true) {
        onDisconnect(selfTypingRef).remove().catch(() => {})
      }
    })
    return () => {
      unsub()
      remove(selfTypingRef).catch(() => {})
    }
  }, [joined, userId])

  useEffect(() => {
    if (!joined) {
      setTypingSnap(null)
      return
    }
    const unsub = onValue(dbRef(db, 'typing'), snap => {
      setTypingSnap(snap.val())
    })
    return () => {
      unsub()
      setTypingSnap(null)
    }
  }, [joined])

  useEffect(() => {
    if (!joined) {
      setTypingUsers([])
      return
    }
    const STALE_MS = 4000
    const recompute = () => {
      const data = typingSnap
      const now = Date.now()
      const out = []
      if (data && typeof data === 'object') {
        Object.entries(data).forEach(([key, v]) => {
          if (key === userId) return
          if (!v || typeof v.ts !== 'number') return
          if (now - v.ts > STALE_MS) return
          const n = String(v.name ?? '').trim() || 'Alguém'
          out.push({ uid: key, name: n })
        })
      }
      setTypingUsers(out)
    }
    recompute()
    const id = setInterval(recompute, 600)
    return () => clearInterval(id)
  }, [joined, userId, typingSnap])

  const insertEmoji = emoji => {
    const el = messageInputRef.current
    if (!el) {
      setInput(prev => {
        const next = collapseChatLineBreaks(prev + emoji)
        touchTypingBroadcast(next)
        return next
      })
      return
    }
    const start = el.selectionStart ?? input.length
    const end = el.selectionEnd ?? input.length
    const next = collapseChatLineBreaks(input.slice(0, start) + emoji + input.slice(end))
    setInput(next)
    touchTypingBroadcast(next)
    requestAnimationFrame(() => {
      focusNoPan(el)
      // setSelectionRange usa índices UTF-16; string.length está alinhado a isso
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
    })
  }

  const send = async () => {
    if (!input.trim() && !pendingFile) return
    clearTypingBroadcast()
    setSending(true)
    try {
      const msgRef = await push(dbRef(db, 'messages'), {
        uid: userId,
        name,
        text: collapseChatLineBreaks(input).trim(),
        ts: Date.now(),
        ...(myColorRef.current ? { color: myColorRef.current } : {}),
        ...(avatarRef.current ? { avatar: avatarRef.current } : {}),
        ...(avatarRef.current ? { avatar: avatarRef.current } : {}),
        file: pendingFile || null,
        ...(replyingTo ? { replyTo: replyingTo } : {}),
      })
      setSentIds(prev => new Set([...prev, msgRef.key]))
      setInput('')
      setPendingFile(null)
      setReplyingTo(null)
      focusNoPan(messageInputRef.current)
    } catch (err) {
      console.error(err)
      setFileError('Erro ao enviar. Tente novamente.')
    }
    setSending(false)
  }

  const handleKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const handleFileChange = async e => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileError('')
    if (file.size > 10 * 1048576) {
      setFileError('Arquivo muito grande. Máximo 10MB.')
      e.target.value = ''
      return
    }
    setReading(true)
    try {
      const dataUrl = await readAsDataURL(file)
      setPendingFile({ name: file.name, size: file.size, type: file.type, dataUrl })
    } catch {
      setFileError('Erro ao ler o arquivo.')
    }
    setReading(false)
    e.target.value = ''
  }

  const canSend = (input.trim() || pendingFile) && !sending && !reading

  const pickFile = kind => {
    setShowPlusMenu(false)
    const el = fileRef.current
    if (!el) return
    el.accept = kind === 'gallery' ? 'image/*,video/*' : kind === 'camera' ? 'image/*' : ''
    if (kind === 'camera') el.setAttribute('capture', 'environment')
    else el.removeAttribute('capture')
    el.click()
  }

  const stopRecTimer = () => {
    window.clearInterval(recRef.current.timer)
    recRef.current.timer = null
  }

  const startRecording = async () => {
    if (recording || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setFileError('Gravação de áudio não é suportada neste navegador.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t))
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(stream)
      const r = recRef.current
      r.rec = rec; r.stream = stream; r.chunks = []; r.cancelled = false; r.start = Date.now()
      rec.ondataavailable = e => { if (e.data.size) r.chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        stopRecTimer()
        setRecording(false)
        if (r.cancelled || !r.chunks.length) return
        const duration = (Date.now() - r.start) / 1000
        if (duration < 0.7) return
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0]
        const blob = new Blob(r.chunks, { type })
        if (blob.size > 10 * 1048576) { setFileError('Áudio muito grande.'); return }
        try {
          const dataUrl = await readAsDataURL(blob)
          const ext = type.includes('mp4') ? 'm4a' : 'webm'
          await push(dbRef(db, 'messages'), {
            uid: userId, name, text: '', ts: Date.now(),
            ...(myColorRef.current ? { color: myColorRef.current } : {}),
            ...(avatarRef.current ? { avatar: avatarRef.current } : {}),
            file: { name: `audio.${ext}`, size: blob.size, type, dataUrl, duration: Math.round(duration) },
            ...(replyingTo ? { replyTo: replyingTo } : {}),
          }).then(ref => {
            setSentIds(prev => new Set([...prev, ref.key]))
            transcribeVoiceMessage(ref.key, dataUrl)
          })
          setReplyingTo(null)
        } catch (err) {
          console.error(err)
          setFileError('Erro ao enviar o áudio.')
        }
      }
      rec.start()
      setRecSecs(0)
      setRecording(true)
      r.timer = window.setInterval(() => {
        const secs = Math.round((Date.now() - r.start) / 1000)
        setRecSecs(secs)
        if (secs >= VOICE_MAX_SECS) rec.state !== 'inactive' && rec.stop()
      }, 250)
    } catch (err) {
      console.error(err)
      setFileError('Não foi possível acessar o microfone. Verifique a permissão.')
    }
  }

  const finishRecording = sendIt => {
    const r = recRef.current
    r.cancelled = !sendIt
    if (r.rec && r.rec.state !== 'inactive') r.rec.stop()
    else setRecording(false)
  }

  useEffect(() => () => {
    const r = recRef.current
    r.cancelled = true
    stopRecTimer()
    if (r.rec && r.rec.state !== 'inactive') r.rec.stop()
  }, [])

  // Arrastar pra direita pra responder (estilo WhatsApp)
  // - trava o eixo nos primeiros px: se o gesto for vertical, deixa a lista rolar e não mexe na bolha
  // - a bolha segue o dedo 1:1 até o gatilho e depois "pesa" (resistência)
  // - ícone de responder aparece atrás da bolha e "estala" ao passar do gatilho
  // - DOM atualizado em requestAnimationFrame (sem re-render do React durante o gesto)
  const SWIPE_TRIGGER = 56
  const SWIPE_MAX = 90
  const swipeStart = (e, m) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    const stack = e.currentTarget
    swipeRef.current = {
      x: t.clientX, y: t.clientY, dx: 0, axis: null, active: true, armed: false, raf: 0,
      stack, bubble: stack.querySelector('.chatMsgBubble'), icon: stack.querySelector('.chatSwipeIcon'),
    }
    startLongPress(m)
  }
  const swipePaint = () => {
    const sw = swipeRef.current
    sw.raf = 0
    if (!sw.bubble) return
    sw.bubble.style.transform = `translate3d(${sw.dx}px,0,0)`
    if (sw.icon) {
      const p = Math.min(1, sw.dx / SWIPE_TRIGGER)
      sw.icon.style.opacity = String(p)
      sw.icon.style.transform = `translateY(-50%) scale(${sw.armed ? 1.15 : 0.6 + p * 0.4})`
    }
  }
  const swipeMove = e => {
    const sw = swipeRef.current
    if (!sw.active || !sw.bubble) return
    const t = e.touches[0]
    const dx = t.clientX - sw.x
    const dy = t.clientY - sw.y
    if (!sw.axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      cancelLongPress()
      sw.axis = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y'
      if (sw.axis === 'y') { sw.active = false; return }
      sw.bubble.style.transition = 'none'
      sw.bubble.style.willChange = 'transform'
      if (sw.icon) {
        sw.icon.style.transition = 'transform .15s ease-out'
        sw.icon.style.top = `${sw.bubble.offsetTop + sw.bubble.offsetHeight / 2}px`
        sw.icon.style.left = `${sw.bubble.offsetLeft + 4}px`
      }
    }
    const raw = Math.max(0, dx - 10)
    sw.dx = raw <= SWIPE_TRIGGER ? raw : Math.min(SWIPE_MAX, SWIPE_TRIGGER + (raw - SWIPE_TRIGGER) * 0.35)
    sw.armed = raw >= SWIPE_TRIGGER
    if (!sw.raf) sw.raf = requestAnimationFrame(swipePaint)
  }
  const swipeEnd = (e, m) => {
    cancelLongPress()
    const sw = swipeRef.current
    if (sw.raf) cancelAnimationFrame(sw.raf)
    if (sw.bubble && sw.axis === 'x') {
      sw.bubble.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)'
      sw.bubble.style.transform = ''
      sw.bubble.style.willChange = ''
      if (sw.icon) {
        sw.icon.style.transition = 'opacity .18s, transform .18s'
        sw.icon.style.opacity = '0'
        sw.icon.style.transform = 'translateY(-50%) scale(0.6)'
      }
      if (sw.armed) startReply(m)
    }
    swipeRef.current = { x: 0, y: 0, dx: 0, active: false }
  }

  const copyMessage = async m => {
    const text = collapseChatLineBreaks(m.text || '').trim()
    if (!text) return
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch {}
    }
    if (ok) {
      setCopiedId(m.id)
      window.setTimeout(() => { setCopiedId(null); setMsgMenuId(null) }, 1200)
    } else {
      setMsgMenuId(null)
      setFileError('Não foi possível copiar.')
    }
  }

  const startReply = m => {
    if (messageIsTombstone(m)) return
    setReplyingTo({ id: m.id, name: m.name || 'Alguém', text: replySnippet(m) })
    setMsgMenuId(null)
    focusNoPan(messageInputRef.current)
  }

  const toggleReaction = async (m, emoji) => {
    setMsgMenuId(null)
    if (messageIsTombstone(m)) return
    const r = dbRef(db, `messages/${m.id}/reactions/${userId}`)
    try {
      if (m.reactions?.[userId] === emoji) await remove(r)
      else await set(r, emoji)
    } catch (e) {
      console.error(e)
      setFileError('Não foi possível reagir à mensagem.')
    }
  }

  const jumpToMessage = id => {
    const el = document.getElementById(`msg-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('chatMsgRow--flash')
    window.setTimeout(() => el.classList.remove('chatMsgRow--flash'), 1400)
  }

  const startLongPress = m => {
    window.clearTimeout(longPressRef.current)
    longPressRef.current = window.setTimeout(() => setMsgMenuId(m.id), 450)
  }
  const cancelLongPress = () => window.clearTimeout(longPressRef.current)

  // Toque no campo de mensagem: foca sem o iOS rolar a página (ver focusNoPan)
  const focusWithoutPan = e => {
    if (document.activeElement === e.currentTarget) return
    e.preventDefault()
    focusNoPan(e.currentTarget)
  }

  const startEdit = m => {
    if (m.uid !== userId || messageIsTombstone(m) || m.editedOnce) return
    setEditingId(m.id)
    setEditDraft(notifBody(m))
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditDraft('')
  }

  const saveEdit = async () => {
    if (!editingId) return
    const msg = messages.find(x => x.id === editingId)
    if (!msg || msg.uid !== userId || messageIsTombstone(msg) || msg.editedOnce) {
      cancelEdit()
      return
    }
    const nextText = collapseChatLineBreaks(editDraft).trim()
    if (!nextText && !msg.file) {
      setFileError('A mensagem não pode ficar vazia. Use apagar se quiser remover.')
      return
    }
    setMsgActionBusy(editingId)
    setFileError('')
    try {
      await update(dbRef(db, `messages/${editingId}`), {
        text: nextText,
        editedOnce: true,
        editedAt: Date.now(),
      })
      cancelEdit()
    } catch (e) {
      console.error(e)
      setFileError('Não foi possível salvar a edição.')
    }
    setMsgActionBusy(null)
  }

  const softDeleteMessage = msgId => {
    const msg = messages.find(x => x.id === msgId)
    if (!msg || msg.uid !== userId || messageIsTombstone(msg)) return
    setConfirmDialog({
      title: 'Apagar mensagem',
      body: 'Apagar esta mensagem para todos? O conteúdo some e fica indicado que foi apagada.',
      variant: 'danger',
      confirmLabel: 'Apagar',
      async onConfirm() {
        if (editingId === msgId) cancelEdit()
        setMsgActionBusy(msgId)
        setFileError('')
        try {
          await update(dbRef(db, `messages/${msgId}`), {
            deleted: true,
            status: 'deleted',
            deletedAt: Date.now(),
            text: MSG_APAGADA_FRASE,
            file: null,
          })
        } catch (e) {
          console.error(e)
          setFileError('Não foi possível apagar a mensagem.')
        }
        setMsgActionBusy(null)
      },
    })
  }

  useEffect(() => {
    if (!confirmDialog) return
    const onKey = e => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setConfirmDialog(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmDialog])

  const dismissConfirm = () => setConfirmDialog(null)

  const commitConfirm = async () => {
    const d = confirmDialog
    if (!d) return
    setConfirmDialog(null)
    try {
      await d.onConfirm()
    } catch (e) {
      console.error(e)
    }
  }

  const confirmModal = confirmDialog ? (
    <div
      style={s.confirmOverlay}
      onClick={e => e.target === e.currentTarget && dismissConfirm()}
    >
      <div
        style={s.confirmPanel}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div id="confirm-dialog-title" style={s.confirmTitle}>{confirmDialog.title}</div>
        <p style={s.confirmBody}>{confirmDialog.body}</p>
        <div style={s.confirmActions}>
          <button type="button" style={s.confirmBtnSecondary} onClick={dismissConfirm}>
            Cancelar
          </button>
          <button
            type="button"
            style={confirmDialog.variant === 'danger' ? s.confirmBtnDanger : s.confirmBtnPrimary}
            onClick={() => void commitConfirm()}
          >
            {confirmDialog.confirmLabel || 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  // ── Login ──
  if (!joined) return (
    <>
    {confirmModal}
    <style>{css}</style>
    <div style={s.page}>
      <div style={s.bgBlur} />
      <div style={s.loginOuter}>
        <div style={s.loginCard}>
          <Logo size="lg" />
          <p style={s.loginSub}>Escolha seu avatar e entre com seu nome para começar</p>
          {(
            <div style={s.avatarPicker} role="radiogroup" aria-label="Escolha seu avatar">
              {AVATARS.map(a => {
                const taken = takenAvatars.has(avatarKey(a.id))
                return (
                <button
                  type="button"
                  key={a.id}
                  role="radio"
                  aria-checked={avatar === a.id}
                  aria-disabled={taken}
                  disabled={taken}
                  title={taken ? 'Avatar em uso' : undefined}
                  aria-label={`Avatar ${a.id.replace(/\.[^.]+$/, '')}${taken ? ' (em uso)' : ''}`}
                  onClick={() => { setNameError(''); setAvatar(cur => (cur === a.id ? null : a.id)) }}
                  style={{
                    ...s.avatarOption,
                    ...(taken ? { cursor: 'not-allowed', filter: 'grayscale(1)', opacity: 0.3 } : null),
                    borderColor: avatar === a.id ? '#FFD700' : 'rgba(255,255,255,0.18)',
                    boxShadow: avatar === a.id ? '0 0 0 2px rgba(255,215,0,0.45), 0 0 14px rgba(255,215,0,0.3)' : 'none',
                    ...(taken ? null : { opacity: avatar && avatar !== a.id ? 0.55 : 1 }),
                  }}
                >
                  <img src={a.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </button>
                )
              })}
              <button
                type="button"
                role="radio"
                aria-checked={avatar === INITIAL_AVATAR}
                title="Usar a inicial do meu nome"
                aria-label="Usar a inicial do meu nome"
                onClick={() => { setNameError(''); setAvatar(cur => (cur === INITIAL_AVATAR ? null : INITIAL_AVATAR)) }}
                style={{
                  ...s.avatarOption,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'inherit', fontSize: name.trim() ? 24 : 17, fontWeight: 800, letterSpacing: name.trim() ? 0 : '-0.02em',
                  color: userColor(name.trim()),
                  background: `${userColor(name.trim())}18`,
                  borderColor: avatar === INITIAL_AVATAR ? '#FFD700' : 'rgba(255,255,255,0.18)',
                  boxShadow: avatar === INITIAL_AVATAR ? '0 0 0 2px rgba(255,215,0,0.45), 0 0 14px rgba(255,215,0,0.3)' : 'none',
                  opacity: avatar && avatar !== INITIAL_AVATAR ? 0.55 : 1,
                }}
              >
                {name.trim() ? nameInitial(name) : 'ABC'}
              </button>
            </div>
          )}
          <input
            style={s.nameInput} placeholder="Seu nome..." value={name}
            onChange={e => { setName(e.target.value); setNameError('') }}
            onKeyDown={e => e.key === 'Enter' && name.trim() && handleJoin()}
            autoFocus
          />
          {nameError && <p role="alert" style={{ color: '#f87171', fontSize: 13, textAlign: 'center', margin: 0 }}>{nameError}</p>}
          {showAdminInput && (
            <input
              style={{ ...s.nameInput, borderColor: 'rgba(212,175,55,0.5)' }}
              placeholder="Código admin..."
              type="password"
              value={adminCode}
              onChange={e => setAdminCode(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && name.trim() && handleJoin()}
            />
          )}
          <button
            style={{ ...s.joinBtn, opacity: name.trim() && !claiming ? 1 : 0.35 }}
            disabled={!name.trim() || claiming} onClick={handleJoin}
          >{claiming ? 'Entrando…' : 'Entrar'}</button>
          <button
            style={s.adminToggleBtn}
            onClick={() => setShowAdminInput(v => !v)}
          >{showAdminInput ? 'Cancelar acesso admin' : 'Acesso admin'}</button>
        </div>
      </div>
    </div>
    </>
  )

  // ── Chat ──
  return (
    <>
    {confirmModal}
    <style>{css}</style>
    <div style={s.page} className="chat-conversation-root">
      <div style={s.bgBlur} />
      {showOnline && <OnlineModal users={onlineUsers} onClose={() => setShowOnline(false)} />}

      <div style={s.header}>
        <div style={s.headerLeft}>
          <Logo size="sm" />
          <span style={s.versionTag}>v{__APP_VERSION__}</span>
        </div>
        <div style={s.headerRight}>
          {isAdmin && (
            <button
              style={s.clearBtn}
              onClick={clearChat}
              disabled={clearing}
              title="Limpar todo o chat"
            >
              {clearing ? '⏳' : '🗑️ Limpar chat'}
            </button>
          )}
          <button style={s.onlineBtn} onClick={() => setShowOnline(v => !v)}>
            <span style={s.dot} />
            <span style={s.onlineCount}>{onlineUsers.length} online</span>
          </button>
          <button style={s.exitBtn} onClick={handleExit} aria-label="Sair" title="Sair">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
          </button>
        </div>
      </div>

      {joined && !isStandalonePWA() && (isAndroidDevice() || isIOSDevice()) && (
        <div style={s.pwaMobileHint}>
          <div style={s.pwaMobileHintTitle}>📱 Celular: avisos com o chat em segundo plano</div>
          {isAndroidDevice() && (
            <p style={s.pwaMobileHintText}>
              Instale o <strong>INVB - Chat</strong> como aplicativo: menu do Chrome (<strong>⋮</strong>) →{' '}
              <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>. Depois use o ícone do app e ative as notificações abaixo.
            </p>
          )}
          {isIOSDevice() && (
            <p style={s.pwaMobileHintText}>
              No <strong>iPhone ou iPad</strong> (Safari ou outro navegador), toque em <strong>Compartilhar</strong> (↑) → <strong>Adicionar à Tela de Início</strong> → Adicionar.
              Abra o chat pelo novo ícone, entre na sala e toque em <strong>Ativar</strong> nas notificações.
              {' '}
              <strong>Nota:</strong> a Apple limita notificações web em segundo plano; com o Safari só numa aba, os avisos costumam aparecer sobretudo com o chat à frente ou recente na multitarefa.
            </p>
          )}
          {isAndroidDevice() && pwaInstallDeferred && (
            <button type="button" style={s.pwaInstallBtn} onClick={runPwaInstall}>
              Instalar app agora
            </button>
          )}
        </div>
      )}

      {notifPerm !== 'granted' && notifPerm !== 'unsupported' && (
        <div style={s.notifBanner}>
          {notifPerm === 'denied' ? (
            <span style={s.notifBannerText}>
              {isIOSDevice() ? (
                <>
                  Notificações bloqueadas. No Safari: ícone <strong>aA</strong> → <strong>Notificações</strong> → <strong>Permitir</strong>.
                  Se abre pelo ícone na Tela de Início: <strong>Ajustes</strong> do iPhone → <strong>INVB - Chat</strong> → <strong>Notificações</strong> → Permitir.
                  Depois recarregue esta página.
                </>
              ) : isAndroidDevice() ? (
                <>
                  Notificações bloqueadas. No Chrome: <strong>⋮</strong> → <strong>Definições</strong> → <strong>Definições do site</strong> → <strong>Notificações</strong> → permitir este site.
                  Ou toque no cadeado na barra de endereços → Permissões → Notificações. Depois recarregue.
                </>
              ) : (
                <>
                  🔒 Cadeado na barra → <b>Notificações</b> → <b>Permitir</b> → recarregue a página
                </>
              )}
            </span>
          ) : (
            <span style={s.notifBannerText}>
              🔔 Ative as notificações para ser avisado de novas mensagens (funciona melhor com o app instalado no Android ou o atalho na Tela de Início no iPhone).
            </span>
          )}
          {notifPerm === 'default' && (
            <button style={s.notifBannerBtn} onClick={requestNotifPermission}>Ativar</button>
          )}
          {notifPerm === 'denied' && (
            <button style={s.notifBannerBtn} onClick={() => window.location.reload()}>Recarregar</button>
          )}
        </div>
      )}
      {notifPerm === 'granted' && isAdmin && (
        <div style={{ ...s.notifBanner, background: 'rgba(74,222,128,0.08)', borderBottomColor: 'rgba(74,222,128,0.2)' }}>
          <span style={{ color: '#4ade80', fontSize: 12 }}>✅ Notificações ativas</span>
          <button style={{ ...s.notifBannerBtn, background: '#4ade80' }}
            onClick={() => { void fireNotif('Chat - Nova Vida', '🔔 Notificações estão funcionando!', null) }}>
            Testar
          </button>
        </div>
      )}

      <div style={s.desktopWrapper}>
        <div style={s.chatPanel}>

          <div style={s.msgArea} ref={msgAreaRef} onScroll={onMsgScroll}>
            {!messagesReady && (
              <div style={s.empty}>Carregando mensagens…</div>
            )}
            {messagesReady && messages.length === 0 && (
              <div style={s.emptyWelcome}>Nenhuma mensagem ainda. Diga olá! 👋</div>
            )}
            {messages.map((m, i) => {
              const dead = messageIsTombstone(m)
              const mine     = m.uid === userId
              const isFirst  = !sameMsgGroup(messages[i - 1], m)
              const isLast   = !sameMsgGroup(m, messages[i + 1])
              const showName = !mine && isFirst
              const sent     = mine && sentIds.has(m.id)
              const isEditing = !dead && editingId === m.id
              const busy     = msgActionBusy === m.id
              const canEditMine = mine && !m.editedOnce

              const peerColor = !mine ? userColor(m.name || '') : null

              return (
                <div
                  key={m.id}
                  id={`msg-${m.id}`}
                  className={`chatMsgRow ${mine ? 'chatMsgRow--sent' : 'chatMsgRow--recv'} ${isFirst ? 'chatMsgRow--first' : ''}`}
                >
                  <div className="chatMsgGroup">
                    {!mine && (
                      <div className="chatMsgAvatarSlot">
                        {showName ? (
                          <div
                            className="chatMsgAvatar"
                            style={{
                              color: peerColor,
                              borderColor: `${peerColor}55`,
                              background: `${peerColor}18`,
                              boxShadow: `0 0 0 1px ${peerColor}22 inset`,
                            }}
                            aria-label={m.name ? `Avatar: ${m.name}` : 'Avatar'}
                          >
                            {avatarOf(m.name)
                              ? <img src={avatarOf(m.name)} alt="" draggable={false} className="chatMsgAvatarImg" />
                              : nameInitial(m.name)}
                          </div>
                        ) : (
                          <div className="chatMsgAvatarSpacer" aria-hidden />
                        )}
                      </div>
                    )}
                    <div
                      className={`chatMsgStack ${mine ? 'chatMsgStack--sent' : 'chatMsgStack--recv'}`}
                      data-msg-menu
                      onContextMenu={e => {
                        if (isEditing || dead) return
                        e.preventDefault()
                        setMsgMenuId(m.id)
                      }}
                      onTouchStart={e => { if (!isEditing && !dead) swipeStart(e, m) }}
                      onTouchMove={swipeMove}
                      onTouchEnd={e => swipeEnd(e, m)}
                      onTouchCancel={e => swipeEnd(e, m)}
                    >
                      <span className="chatSwipeIcon" aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>
                      </span>
                      {showName && !mine && (
                        <div className="chatMsgAuthor" style={{ color: userColor(m.name || '') }}>
                          {m.name}
                        </div>
                      )}
                      <div
                        className={`chatMsgBubble ${mine ? 'chatMsgBubble--sent' : 'chatMsgBubble--recv'} ${isFirst ? 'chatMsgBubble--first' : ''} ${dead ? 'chatMsgBubble--dead' : ''}`}
                        style={!mine && peerColor ? { ['--chat-accent']: peerColor } : undefined}
                      >
                        <div className="chatMsgBody">
                          {dead ? (
                            <div className="chatMsgDeleted">
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="9" /><path d="m5.7 5.7 12.6 12.6" />
                              </svg>
                              {mine ? 'Você apagou esta mensagem' : 'Esta mensagem foi apagada'}
                            </div>
                          ) : isEditing ? (
                            <div className="chatMsgEditWrap">
                              {m.file && <FilePreview file={m.file} mine={mine} />}
                              <input
                                type="text"
                                className="chat-msg-input chatMsgEditInput"
                                style={s.editMsgInput}
                                value={editDraft}
                                onChange={e => setEditDraft(collapseChatLineBreaks(e.target.value))}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    saveEdit()
                                  }
                                }}
                                autoFocus
                              />
                              <div style={s.editActions}>
                                <button type="button" style={s.editSaveBtn} onClick={saveEdit} disabled={busy}>
                                  {busy ? '…' : 'Salvar'}
                                </button>
                                <button type="button" style={s.editCancelBtn} onClick={cancelEdit} disabled={busy}>
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {m.replyTo && (
                                <button
                                  type="button"
                                  className="chatMsgQuote"
                                  style={{ ['--quote-color']: userColor(m.replyTo.name || '') }}
                                  onClick={() => jumpToMessage(m.replyTo.id)}
                                  title="Ir para a mensagem original"
                                >
                                  <span className="chatMsgQuoteName">{m.replyTo.name}</span>
                                  <span className="chatMsgQuoteText">{m.replyTo.text || 'Mensagem'}</span>
                                </button>
                              )}
                              {m.file && <FilePreview file={m.file} mine={mine} />}
                              {m.text && (
                                <div className="chatMsgText">{linkifyText(collapseChatLineBreaks(m.text))}</div>
                              )}
                            </>
                          )}
                        </div>
                        {!isEditing && (dead || isLast || mine || m.editedOnce) && (
                          <div className={`chatMsgMeta ${m.editedOnce && !dead ? 'chatMsgMeta--wide' : ''}`}>
                            {m.editedOnce && !dead && <span className="chatMsgEditedTag">editada</span>}
                            {(dead || isLast) && <span>{timeStr(m.deletedAt || m.ts)}</span>}
                            {mine && !dead && (
                              <span className="chatMsgCheck">
                                <Ticks level={Object.keys(m.readBy || {}).length > 0 ? 3 : Object.keys(m.deliveredTo || {}).length > 0 ? 2 : 1} />
                              </span>
                            )}
                          </div>
                        )}
                        {!isEditing && !dead && (
                          <button
                            type="button"
                            className="chatMsgMore"
                            aria-label="Reagir ou responder"
                            title="Reagir ou responder"
                            onClick={() => setMsgMenuId(id => (id === m.id ? null : m.id))}
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01" /><path d="M15 9h.01" />
                            </svg>
                          </button>
                        )}
                      </div>
                      {!dead && m.reactions && Object.keys(m.reactions).length > 0 && (() => {
                        const counts = {}
                        Object.values(m.reactions).forEach(e => { counts[e] = (counts[e] || 0) + 1 })
                        return (
                          <div className="chatMsgReactions">
                            {Object.entries(counts).map(([emo, n]) => (
                              <button
                                type="button"
                                key={emo}
                                className={`chatMsgReaction ${m.reactions[userId] === emo ? 'chatMsgReaction--mine' : ''}`}
                                onClick={() => toggleReaction(m, emo)}
                                aria-label={`Reação ${emo}, ${n}`}
                              >
                                <span>{emo}</span><span>{n}</span>
                              </button>
                            ))}
                          </div>
                        )
                      })()}
                      {msgMenuId === m.id && !isEditing && !dead && (
                        <div
                          className={`chatMsgMenu ${mine ? 'chatMsgMenu--sent' : ''}`}
                          role="menu"
                          ref={el => {
                            // abre para baixo; só vira para cima se não couber na área visível
                            if (!el || !msgAreaRef.current) return
                            const below = msgAreaRef.current.getBoundingClientRect().bottom - el.parentElement.getBoundingClientRect().bottom
                            if (below < el.offsetHeight + 8) { el.style.top = 'auto'; el.style.bottom = 'calc(100% + 4px)' }
                            else { el.style.top = ''; el.style.bottom = '' }
                          }}
                        >
                          <div className="chatMsgMenuEmojis">
                            {REACTION_EMOJIS.map(emo => (
                              <button
                                type="button"
                                key={emo}
                                className={`chatMsgMenuEmoji ${m.reactions?.[userId] === emo ? 'chatMsgMenuEmoji--on' : ''}`}
                                onClick={() => toggleReaction(m, emo)}
                                aria-label={`Reagir com ${emo}`}
                              >
                                {emo}
                              </button>
                            ))}
                          </div>
                          <button type="button" role="menuitem" className="chatMsgMenuItem" onClick={() => startReply(m)}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
                            </svg>
                            Responder
                          </button>
                          {m.text && (
                            <button type="button" role="menuitem" className="chatMsgMenuItem" onClick={() => copyMessage(m)}>
                              {copiedId === m.id ? (
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                                </svg>
                              ) : (
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />
                                </svg>
                              )}
                              {copiedId === m.id ? 'Copiado' : 'Copiar'}
                            </button>
                          )}
                        </div>
                      )}
                      {mine && !isEditing && !dead && (
                        <div className="chatMsgActions">
                          {canEditMine && (
                            <button
                              type="button"
                              style={s.msgActionBtn}
                              disabled={busy}
                              onClick={() => startEdit(m)}
                              title="Você pode editar só uma vez"
                            >
                              Editar
                            </button>
                          )}
                          <button
                            type="button"
                            style={{ ...s.msgActionBtn, color: 'rgba(248,113,113,0.85)' }}
                            disabled={busy}
                            onClick={() => softDeleteMessage(m.id)}
                            title="Apagar para todos"
                          >
                            {busy ? '…' : 'Apagar'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
            {showJump && (
              <div className="chatJumpWrap">
                <button type="button" className="chatJumpBtn" onClick={jumpToBottom} aria-label="Ir para as mensagens mais recentes">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                  {newMsgCount > 0 && <span className="chatJumpBadge">{newMsgCount > 99 ? '99+' : newMsgCount}</span>}
                </button>
              </div>
            )}
          </div>

          {reading && (
            <div style={s.pendingBar}>
              <span style={{ fontSize: 14, color: 'rgba(212,175,55,0.7)' }}>⏳ Carregando arquivo...</span>
            </div>
          )}

          {pendingFile && !reading && (
            <div style={s.pendingBar}>
              <span style={{ fontSize: 20 }}>{fileIcon(pendingFile.type)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={s.pendingName}>{pendingFile.name}</div>
                <div style={s.pendingSize}>{fmtSize(pendingFile.size)}</div>
              </div>
              <button style={s.removePending} onClick={() => setPendingFile(null)}>✕</button>
            </div>
          )}

          {fileError && (
            <div style={s.fileError}>
              {fileError}
              <button style={s.clearErr} onClick={() => setFileError('')}>✕</button>
            </div>
          )}

          {typingUsers.length > 0 && (
            <div style={s.typingBar} role="status" aria-live="polite">
              {typingUsers.length === 1
                ? `${typingUsers[0].name} está digitando…`
                : typingUsers.length === 2
                  ? `${typingUsers[0].name} e ${typingUsers[1].name} estão digitando…`
                  : `${typingUsers
                      .slice(0, 2)
                      .map(u => u.name)
                      .join(', ')} e mais ${typingUsers.length - 2} estão digitando…`}
            </div>
          )}

          {replyingTo && (
            <div style={s.replyBar} role="status">
              <div style={{ flex: 1, minWidth: 0, borderLeft: `3px solid ${userColor(replyingTo.name)}`, paddingLeft: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: userColor(replyingTo.name) }}>
                  Respondendo a {replyingTo.name}
                </div>
                <div style={s.replyBarText}>{replyingTo.text || 'Mensagem'}</div>
              </div>
              <button type="button" style={s.removePending} onClick={() => setReplyingTo(null)} aria-label="Cancelar resposta">✕</button>
            </div>
          )}

          <div style={s.inputBar}>
            {recording && (
              <>
                <button type="button" style={s.attachBtn} onClick={() => finishRecording(false)} aria-label="Cancelar gravação" title="Cancelar">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" ><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></svg>
                </button>
                <div style={s.recBar} role="status">
                  <span className="chatRecDot" />
                  <span style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(recSecs)}</span>
                  <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>Gravando…</span>
                </div>
                <button type="button" style={{ ...s.sendBtn, boxShadow: '0 0 14px rgba(255,215,0,0.35)' }} onClick={() => finishRecording(true)} aria-label="Enviar áudio">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></svg>
                </button>
              </>
            )}
            <div hidden={recording} style={{ display: recording ? 'none' : 'contents' }}>
            <div ref={emojiPickerRef} style={s.emojiPickerWrap}>
              <button
                type="button"
                style={s.attachBtn}
                onClick={() => { setShowEmojiPicker(false); setShowPlusMenu(v => !v) }}
                title="Emoji e anexos"
                aria-label="Emoji e anexos"
                aria-expanded={showPlusMenu || showEmojiPicker}
                aria-haspopup="true"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                  style={{ transition: 'transform .15s', transform: (showPlusMenu || showEmojiPicker) ? 'rotate(45deg)' : 'none' }}>
                  <path d="M12 5v14" /><path d="M5 12h14" />
                </svg>
              </button>
              {showPlusMenu && (
                <div style={s.plusMenu} role="menu">
                  <button type="button" role="menuitem" style={s.plusMenuItem}
                    onClick={() => { setShowPlusMenu(false); setShowEmojiPicker(true) }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01" /><path d="M15 9h.01" />
                    </svg>
                    Emoji
                  </button>
                  <button type="button" role="menuitem" style={s.plusMenuItem} onClick={() => pickFile('camera')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 7h2l1.5-2h7L17 7h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" /><circle cx="12" cy="13" r="3.5" /></svg>
                    Câmera
                  </button>
                  <button type="button" role="menuitem" style={s.plusMenuItem} onClick={() => pickFile('gallery')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-8 8" /></svg>
                    Galeria
                  </button>
                  <button type="button" role="menuitem" style={s.plusMenuItem} disabled={reading} onClick={() => pickFile('document')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" /></svg>
                    {reading ? 'Carregando…' : 'Documento'}
                  </button>
                </div>
              )}
              {showEmojiPicker && (
                <div style={s.emojiPopover} role="listbox" aria-label="Emoticons">
                  {EMOJI_PALETTE.map((emo, i) => (
                    <button
                      type="button"
                      key={`${emo}-${i}`}
                      className="emoji-panel-btn"
                      style={s.emojiCell}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => insertEmoji(emo)}
                      title={emo}
                    >
                      {emo}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={handleFileChange} />
            <input
              type="text"
              ref={messageInputRef}
              className="chat-msg-input"
              style={s.chatMsgInput}
              placeholder={pendingFile ? 'Adicione uma legenda...' : 'Mensagem...'}
              value={input}
              onChange={e => {
                const v = collapseChatLineBreaks(e.target.value)
                setInput(v)
                touchTypingBroadcast(v)
              }}
              onKeyDown={handleKey}
              onTouchEnd={focusWithoutPan}
            />
            {!(canSend || sending) && (
              <button type="button" style={s.sendBtn} onClick={startRecording} aria-label="Gravar mensagem de voz" title="Gravar mensagem de voz">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>
              </button>
            )}
            <button
              aria-label="Enviar"
              style={{
                display: canSend || sending ? 'flex' : 'none',
                ...s.sendBtn,
                opacity: canSend ? 1 : 0.4,
                boxShadow: canSend ? '0 0 14px rgba(255,215,0,0.35)' : 'none',
              }}
              onClick={send} disabled={!canSend}
            >
              {sending ? '…' : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
                </svg>
              )}
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  )
}

// ── CSS ───────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Bebas+Neue&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { margin: 0; padding: 0; overflow: hidden; overscroll-behavior: none; background: #000; }
  /* Faixa do Safari abaixo da página: mesma cor da barra de mensagem, parece continuação dela */
  html { background: linear-gradient(to bottom, #000 0 50%, #0e0e12 50% 100%) #000; }
  body { position: fixed; inset: 0; width: 100%; }
  /* Sem seleção/cópia nativa do iOS: copiar só pelo menu do app */
  html, body, #root {
    -webkit-user-select: none; user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  input, textarea, [contenteditable="true"] {
    -webkit-user-select: text; user-select: text;
    -webkit-touch-callout: default;
  }
  /* iOS dá zoom (e "pula" a tela) em campo com fonte < 16px */
  @media (pointer: coarse) { input, textarea { font-size: 16px !important; } }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(212,175,55,0.2); border-radius: 2px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(212,175,55,0.4); }
  /* ── Mensagens do chat ── */

  /* Linha: empurra bolha para esquerda ou direita */
  .chatMsgRow {
    display: flex;
    width: 100%;
    padding: 1px 0;
  }
  .chatMsgRow--first { margin-top: 10px; }
  .chatMsgRow--first:first-child { margin-top: 0; }
  .chatMsgRow--sent { justify-content: flex-end; }
  .chatMsgRow--recv { justify-content: flex-start; }

  /* Grupo: avatar + coluna de conteúdo. max-width fica AQUI. */
  .chatMsgGroup {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 12px;
    max-width: min(78vw, 560px);
  }

  /* Slot do avatar */
  .chatMsgAvatarSlot {
    width: 38px;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 24px; /* alinha o avatar com o topo do balão (abaixo do nome) */
  }
  .chatMsgAvatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 800;
    font-family: inherit;
    border: 2px solid;
    flex-shrink: 0;
  }
  .chatMsgAvatar { overflow: hidden; }
  .chatMsgAvatarImg { width: 100%; height: 100%; object-fit: cover; display: block; }
  .chatMsgAvatarSpacer {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
  }

  /* Coluna: nome do autor + bolha + ações */
  .chatMsgStack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    /* sem max-width aqui — herdado do chatMsgGroup */
  }
  .chatMsgStack--sent { align-items: flex-end; }
  /* Gesto de responder: o navegador só cuida da rolagem vertical; o horizontal é nosso */
  .chatMsgStack { touch-action: pan-y; }
  .chatSwipeIcon {
    position: absolute; top: 50%; left: 4px; pointer-events: none;
    width: 30px; height: 30px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: rgba(212,175,55,0.18); color: #FFD700;
    opacity: 0; transform: translateY(-50%) scale(0.6);
  }
  .chatMsgBubble { position: relative; } /* sem z-index: o ícone vem antes no DOM e fica atrás */
  .chatMsgStack--recv { align-items: flex-start; }

  /* Nome do remetente */
  .chatMsgAuthor {
    font-size: 14px;
    font-weight: 700;
    padding-left: 2px;
    margin-bottom: 2px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /*
   * Bolha: cresce com o conteúdo, nunca além do container.
   * inline-block + align-items(start|end) no pai = shrink-to-fit automático.
   * min-width garante espaço mínimo para o horário.
   */
  .chatMsgBubble {
    display: inline-block;
    max-width: 100%;
    min-width: 72px;
    box-sizing: border-box;
    padding: 9px 12px 8px;
  }
  .chatMsgBubble--sent {
    background: linear-gradient(135deg, #2a1f00, #3d2d00);
    border: none;
    border-radius: 18px;
  }
    .chatMsgBubble--recv {
    background: #17171b;
    border: none;
    border-radius: 18px;
  }
  /* rabinho no canto superior esquerdo, apontando para o avatar/nome de quem enviou */
  .chatMsgBubble--recv.chatMsgBubble--first { border-top-left-radius: 0; }
  .chatMsgBubble--recv.chatMsgBubble--first::before {
    content: '';
    position: absolute;
    top: 0;
    left: -8px;
    width: 8px;
    height: 12px;
    background: #17171b;
    clip-path: polygon(100% 0, 100% 100%, 0 0);
  }

  /* Área de conteúdo (texto + arquivo) */
  .chatMsgBody {
    font-size: 15px;
    line-height: 1.5;
    color: #fff;
  }
  .chatMsgText {
    font-size: 15px;
    line-height: 1.5;
    color: #fff;
    white-space: normal;
    word-break: normal;       /* não quebra palavras normais no meio */
    overflow-wrap: anywhere;  /* quebra URLs e strings sem espaço */
  }
  .chatMsgLink {
    color: #8ecbff;
    text-decoration: underline;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
    word-break: break-all;
    padding: 4px 0;
    -webkit-tap-highlight-color: transparent;
  }
  .chatMsgLink:hover { color: #bfe3ff; }
  .chatMsgEditedTag { font-style: italic; color: rgba(255,255,255,0.62); }
  .chatMsgEdited {
    font-size: 10px;
    color: rgba(212,175,55,0.75);
    margin-top: 4px;
    font-weight: 500;
  }

  /*
   * Meta (horário + check): ocupa a largura da bolha mas NÃO a infla.
   * Técnica: width:0 faz o elemento contribuir zero para o cálculo
   * de largura intrínseca do pai; min-width:100% resolve depois que
   * a largura do pai já foi determinada pelo texto.
   * Resultado: bolha = largura do texto, horário alinhado à direita.
   */
  .chatMsgMeta {
    display: flex;
    flex-direction: row;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 10px;
    color: rgba(255,255,255,0.62);
    line-height: 1.2;
    white-space: nowrap;
    width: 0;
    min-width: 100%;
  }
  /* com "editada" o rodapé é mais largo que textos curtos: deixa o balão crescer */
  .chatMsgMeta--wide { width: auto; }
  .chatMsgCheck {
    font-size: 13px;
    font-weight: 700;
    color: #D4AF37;
    line-height: 1;
  }

  /* Ir para o fim */
  .chatJumpWrap { position: sticky; bottom: 0; height: 0; align-self: flex-end; width: 0; overflow: visible; }
  .chatJumpBtn {
    position: absolute; right: 0; bottom: 8px; width: 44px; height: 44px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: #1c1c22; border: 1px solid rgba(255,255,255,0.28); border-radius: 50%;
    color: #fff; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.55);
  }
  .chatJumpBadge {
    position: absolute; top: -8px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px;
    display: flex; align-items: center; justify-content: center;
    background: #FFD700; color: #1a1300; border-radius: 10px; font-size: 12px; font-weight: 700;
  }

  /* Gravação */
  .chatRecDot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: recPulse 1s ease-in-out infinite; }
  @keyframes recPulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

  /* Player de áudio */
  .chatAudio { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 210px; padding: 2px 0 4px; }
  .chatAudioTranscript { flex-basis: 100%; font-size: 13px; line-height: 1.35; font-style: italic; color: rgba(255,255,255,0.85); white-space: pre-wrap; word-break: break-word; }
  .chatAudioBtn {
    width: 40px; height: 40px; padding: 0; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #C9A84C, #FFD700); color: #1a1300; border: none; border-radius: 50%; cursor: pointer;
  }
  .chatAudioMain { flex: 1; min-width: 0; }
  .chatAudioTrack { height: 20px; display: flex; align-items: center; cursor: pointer; position: relative; }
  .chatAudioTrack::before { content: ''; position: absolute; left: 0; right: 0; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.25); }
  .chatAudioFill { position: relative; height: 4px; border-radius: 2px; background: #FFD700; }
  .chatAudioTime { font-size: 12px; color: rgba(255,255,255,0.7); font-variant-numeric: tabular-nums; }

  /* Mensagem apagada (estilo WhatsApp) */
  .chatMsgBubble--dead { background: #17171b; opacity: 0.85; }
  .chatMsgBubble--sent.chatMsgBubble--dead { background: rgba(61,45,0,0.55); }
  .chatMsgDeleted {
    display: flex; align-items: center; gap: 6px;
    font-size: 14px; font-style: italic; color: rgba(255,255,255,0.6);
  }

  /* Citação (resposta) */
  .chatMsgQuote {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    margin: 0 0 6px;
    padding: 5px 9px;
    background: rgba(255,255,255,0.07);
    border: none;
    border-left: 3px solid var(--quote-color, #D4AF37);
    border-radius: 6px;
    text-align: left;
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .chatMsgQuoteName { font-size: 12px; font-weight: 600; color: var(--quote-color, #D4AF37); }
  .chatMsgQuoteText {
    font-size: 13px; color: rgba(255,255,255,0.72); line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    overflow-wrap: anywhere; text-align: left;
  }
  .chatMsgRow--flash .chatMsgBubble { animation: msgFlash 1.4s ease-out; }
  @keyframes msgFlash {
    0%, 30% { box-shadow: 0 0 0 2px rgba(255,215,0,0.7); }
    100% { box-shadow: 0 0 0 2px rgba(255,215,0,0); }
  }

  /* Reações */
  .chatMsgReactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .chatMsgReaction {
    display: inline-flex; align-items: center; gap: 3px;
    min-height: 28px; padding: 0 4px;
    background: transparent; border: none;
    color: rgba(255,255,255,0.75); font-size: 13px; font-family: inherit; cursor: pointer;
  }
  .chatMsgReaction > span:first-child { font-size: 18px; line-height: 1; }
  .chatMsgReaction--mine { color: #FFD700; font-weight: 600; }

  /* Menu da mensagem (reagir / responder) */
  .chatMsgStack { position: relative; }
  .chatMsgBubble { position: relative; }
  .chatMsgMore {
    position: absolute; top: 50%; transform: translateY(-50%);
    width: 32px; height: 32px; padding: 0;
    display: none; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: 50%;
    color: rgba(255,255,255,0.6); cursor: pointer; z-index: 2;
  }
  .chatMsgMore:hover { color: #FFD700; background: rgba(255,255,255,0.08); }
  .chatMsgBubble--recv .chatMsgMore { left: 100%; }
  .chatMsgBubble--sent .chatMsgMore { right: 100%; }
  @media (hover: hover) and (pointer: fine) {
    .chatMsgBubble:hover .chatMsgMore, .chatMsgStack:has(.chatMsgMenu) .chatMsgMore { display: flex; }
  }
  .chatMsgMenu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 30;
    display: flex; flex-direction: column; gap: 2px; padding: 6px;
    background: #16161c; border: 1px solid rgba(255,255,255,0.18); border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.65);
  }
  .chatMsgMenu--sent { left: auto; right: 0; }
  .chatMsgMenuEmojis { display: flex; gap: 2px; }
  .chatMsgMenuEmoji {
    width: 40px; height: 40px; padding: 0; font-size: 22px; line-height: 1;
    background: transparent; border: none; border-radius: 10px; cursor: pointer;
  }
  .chatMsgMenuEmoji:hover, .chatMsgMenuEmoji--on { background: rgba(212,175,55,0.2); }
  .chatMsgMenuItem {
    display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 10px;
    background: transparent; border: none; border-radius: 10px; color: #fff;
    font-size: 15px; font-family: inherit; cursor: pointer; text-align: left;
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .chatMsgMenuItem:hover { background: rgba(255,255,255,0.07); }

  /* Ações (editar / apagar) */
  .chatMsgActions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  /* Modo de edição */
  .chatMsgEditWrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: min(100%, 260px);
  }
  .chatMsgEditInput {
    width: 100%;
  }

  @media (min-width: 700px) {
    .chatMsgGroup { max-width: min(70%, 560px); }
  }

  .check-on  { opacity: 1; animation: popIn .35s cubic-bezier(.34,1.56,.64,1) forwards; }
  .check-off { opacity: 0; }
  @keyframes popIn {
    0%   { transform: scale(0.3); opacity: 0; }
    70%  { transform: scale(1.25); }
    100% { transform: scale(1); opacity: 1; }
  }
  input::placeholder { color: rgba(212,175,55,0.35); }
  .chat-msg-input::placeholder { color: rgba(255,255,255,0.55); }
  input:focus { border-color: rgba(212,175,55,0.6) !important; box-shadow: 0 0 0 3px rgba(212,175,55,0.08); }
  .chat-msg-input:focus { border-color: rgba(212,175,55,0.5) !important; }
  button, [role="button"] {
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  @media (max-width: 768px), (pointer: coarse) {
    .chat-conversation-root {
      touch-action: pan-x pan-y;
    }
    .chat-msg-input,
    .chatMsgEditInput {
      font-size: 16px !important;
    }
  }
  .emoji-panel-btn:hover {
    background: rgba(212,175,55,0.12) !important;
    border-color: rgba(212,175,55,0.2) !important;
  }
`

// ── Styles ────────────────────────────────────────────────────
const GOLD = '#D4AF37'
const GOLD_DIM = 'rgba(212,175,55,0.25)'
const GOLD_FAINT = 'rgba(212,175,55,0.08)'

const s = {
  page: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, transform: 'translateY(var(--app-top, 0px))', display: 'flex', flexDirection: 'column', background: '#000', isolation: 'isolate', fontFamily: "'Outfit', system-ui, sans-serif", color: '#e8e8ee' },
  bgBlur: { position: 'fixed', inset: 0, backgroundImage: 'url(/images/image.png)', backgroundSize: 'cover', backgroundPosition: 'center', filter: 'blur(2px)', transform: 'scale(1.04)', opacity: 0.62, zIndex: -1, pointerEvents: 'none' },

  // Login
  loginOuter: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(24px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(24px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))', position: 'relative', zIndex: 1 },
  loginCard: {
    width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    background: '#080808', border: `1px solid ${GOLD_DIM}`, borderRadius: 20, padding: '44px 36px',
  },
  loginLogo: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
  loginTitle: { fontSize: 26, fontWeight: 700, color: GOLD, letterSpacing: '0.02em' },
  loginSub: { fontSize: 14, color: 'rgba(255,255,255,0.35)', textAlign: 'center' },
  avatarPicker: {
    width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))', gap: 10,
    justifyItems: 'center', maxHeight: 190, overflowY: 'auto', padding: 4,
  },
  avatarOption: {
    width: 56, height: 56, padding: 0, borderRadius: '50%', border: '2px solid',
    background: '#111', overflow: 'hidden', cursor: 'pointer', transition: 'opacity .15s, box-shadow .15s, border-color .15s',
  },
  nameInput: {
    width: '100%', background: '#0d0d0d', border: `1.5px solid ${GOLD_DIM}`, borderRadius: 12,
    padding: '13px 16px', color: '#fff', fontSize: 16, outline: 'none', fontFamily: 'inherit',
    transition: 'border-color .2s',
  },
  joinBtn: {
    width: '100%', background: `linear-gradient(135deg, #C9A84C, #FFD700, #A07830)`,
    border: 'none', borderRadius: 12, padding: '14px', color: '#000', fontSize: 16,
    fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.02em',
  },

  // Header — respeita entalhe / Dynamic Island / barra de status (iOS + viewport-fit=cover)
  versionTag: {
    fontSize: 10, fontWeight: 600, color: 'rgba(212,175,55,0.75)', whiteSpace: 'nowrap', letterSpacing: '0.04em', lineHeight: 1,
    padding: '3px 6px', borderRadius: 6, border: '1px solid rgba(212,175,55,0.25)', background: 'rgba(212,175,55,0.06)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12,
    paddingTop: 'max(10px, env(safe-area-inset-top, 0px))',
    paddingRight: 'max(14px, env(safe-area-inset-right, 0px))',
    paddingBottom: '10px',
    paddingLeft: 'max(14px, env(safe-area-inset-left, 0px))',
    borderBottom: `1px solid rgba(212,175,55,0.35)`,
    background: '#000', flexShrink: 0, zIndex: 10, position: 'relative',
    boxShadow: '0 2px 20px rgba(0,0,0,0.8)',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  headerTitle: { fontSize: 16, fontWeight: 700, color: GOLD, letterSpacing: '0.03em' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 7px #4ade80', flexShrink: 0 },
  onlineBtn: {
    display: 'flex', alignItems: 'center', gap: 7, height: 34,
    background: GOLD_FAINT, border: `1px solid ${GOLD_DIM}`,
    borderRadius: 17, padding: '0 12px', cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background .2s',
  },
  onlineCount: { fontSize: 12, color: GOLD, fontWeight: 600 },
  exitBtn: {
    width: 34, height: 34, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 17, color: 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Layout
  desktopWrapper: { flex: 1, display: 'flex', overflow: 'hidden', justifyContent: 'center', position: 'relative', zIndex: 1 },
  chatPanel: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', maxWidth: 720, paddingBottom: 'var(--kb, 0px)',
    borderLeft: `1px solid ${GOLD_DIM}`, borderRight: `1px solid ${GOLD_DIM}`,
  },
  msgArea: {
    flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3,
    background: 'rgba(0,0,0,0.08)',
    padding:
      '16px calc(14px + env(safe-area-inset-right, 0px)) 10px calc(14px + env(safe-area-inset-left, 0px))',
  },
  empty: { textAlign: 'center', color: 'rgba(212,175,55,0.2)', marginTop: 80, fontSize: 14 },
  emptyWelcome: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    color: '#ffd700',
    fontSize: 15,
    fontWeight: 500,
    padding: '0 24px',
  },
  rowSystem: {
    display: 'flex', justifyContent: 'center', width: '100%', marginBottom: 12, marginTop: 4, padding: '0 12px',
  },
  systemTombstone: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    maxWidth: 400, width: '100%', padding: '11px 18px 12px',
    background: 'linear-gradient(180deg, rgba(40,40,48,0.95), rgba(22,22,28,0.98))',
    border: '1px solid rgba(255,255,255,0.08)',
    borderLeft: '3px solid rgba(148,163,184,0.55)',
    borderRadius: 10,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 4px 20px rgba(0,0,0,0.35)',
  },
  systemTombstoneLabel: {
    fontSize: 9, fontWeight: 800, letterSpacing: '0.22em', textTransform: 'uppercase',
    color: 'rgba(148,163,184,0.85)', fontFamily: 'inherit',
  },
  systemTombstoneText: {
    fontSize: 13, lineHeight: 1.45, color: 'rgba(226,232,240,0.88)', textAlign: 'center',
    fontWeight: 500, fontStyle: 'normal', letterSpacing: '0.01em',
  },
  systemTombstoneMeta: {
    fontSize: 10, color: 'rgba(148,163,184,0.55)', letterSpacing: '0.03em',
    textTransform: 'uppercase',
  },
  msgActionBtn: {
    background: 'none', border: 'none', color: 'rgba(212,175,55,0.55)', fontSize: 11,
    fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '2px 4px', textDecoration: 'underline',
  },
  editMsgInput: {
    width: '100%', background: 'rgba(0,0,0,0.35)', border: `1px solid ${GOLD_DIM}`, borderRadius: 10,
    padding: '8px 10px', color: '#fff', fontSize: 14, fontFamily: 'inherit', outline: 'none',
    lineHeight: 1.45, boxSizing: 'border-box',
  },
  editActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  editSaveBtn: {
    background: `linear-gradient(135deg, #C9A84C, #FFD700)`, border: 'none', borderRadius: 8,
    padding: '6px 14px', color: '#000', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  },
  editCancelBtn: {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, padding: '6px 14px', color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Pending / errors
  pendingBar: {
    display: 'flex', alignItems: 'center', gap: 10, margin: '0 12px 6px', padding: '10px 14px',
    background: `rgba(212,175,55,0.07)`, border: `1px solid ${GOLD_DIM}`, borderRadius: 12,
  },
  pendingName: { fontSize: 13, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  pendingSize: { fontSize: 11, color: 'rgba(212,175,55,0.45)', marginTop: 2 },
  removePending: { background: 'none', border: 'none', color: 'rgba(212,175,55,0.5)', fontSize: 16, cursor: 'pointer', padding: '0 2px' },
  fileError: {
    margin: '0 12px 6px', padding: '8px 14px',
    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: 10, fontSize: 13, color: '#f87171', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  clearErr: { background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 14 },

  typingBar: {
    padding: '8px 18px 4px',
    fontSize: 12,
    color: 'rgba(212,175,55,0.55)',
    fontStyle: 'italic',
    flexShrink: 0,
    letterSpacing: '0.02em',
  },

  // Input bar
  inputBar: {
    display: 'flex', gap: 8,
    padding:
      '12px calc(12px + env(safe-area-inset-right, 0px)) max(10px, calc(env(safe-area-inset-bottom, 0px) - 14px - var(--kb, 0px))) calc(12px + env(safe-area-inset-left, 0px))',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    borderLeft: '1px solid rgba(255,255,255,0.04)',
    borderRight: '1px solid rgba(255,255,255,0.04)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    background: '#0e0e12',
    boxShadow: '0 -10px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
    flexShrink: 0, alignItems: 'center',
  },
  attachBtn: {
    width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.22)',
    color: '#e8e8ee', fontSize: 18, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  replyBar: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
    background: 'rgba(22,22,28,0.9)', borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  replyBarText: {
    fontSize: 13, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  recBar: {
    flex: 1, minWidth: 0, height: 44, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px',
    background: '#16161c', border: '1.5px solid rgba(255,255,255,0.28)', borderRadius: 12, color: '#fff',
  },
  emojiPickerWrap: { position: 'relative', flexShrink: 0 },
  plusMenu: {
    position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 50,
    display: 'flex', flexDirection: 'column', gap: 2, padding: 6, minWidth: 190,
    background: '#16161c', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.65)',
  },
  plusMenuItem: {
    display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, padding: '0 12px',
    background: 'transparent', border: 'none', borderRadius: 10, color: '#fff',
    fontSize: 15, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
  },
  emojiPopover: {
    position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 50,
    display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', gap: 4,
    padding: 10,
    width: 'min(calc(100vw - 24px), 304px)',
    maxWidth: 'min(calc(100vw - 24px), 304px)',
    boxSizing: 'border-box',
    background: '#121212', border: `1px solid ${GOLD_DIM}`, borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.65)',
  },
  emojiCell: {
    width: '100%',
    minWidth: 0,
    aspectRatio: '1',
    height: 'auto',
    padding: 0,
    fontSize: 'clamp(16px, 5.2vw, 22px)',
    lineHeight: 1,
    background: 'rgba(255,255,255,0.04)', border: '1px solid transparent', borderRadius: 8,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxSizing: 'border-box',
  },
  chatMsgInput: {
    flex: 1, minWidth: 0, background: '#16161c', border: `1.5px solid rgba(255,255,255,0.28)`,
    borderRadius: 12, padding: '10px 14px', color: '#fff', fontSize: 15, height: 44,
    fontFamily: 'inherit', outline: 'none', lineHeight: 1.5, transition: 'border-color .2s',
    boxSizing: 'border-box',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 12,
    background: `linear-gradient(135deg, #C9A84C, #FFD700)`,
    border: 'none', color: '#1a1300', transition: 'opacity .15s, box-shadow .15s', fontSize: 17, fontWeight: 700,
    cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  hint: { textAlign: 'center', fontSize: 10, color: 'rgba(212,175,55,0.2)', padding: '4px 0 8px', background: '#050505', flexShrink: 0 },

  // Admin / Notif extras
  adminToggleBtn: { background: 'none', border: 'none', color: 'rgba(212,175,55,0.35)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', padding: 0 },
  clearBtn: { background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '5px 12px', color: '#f87171', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  notifBanner: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 12,
    paddingTop: '10px',
    paddingRight: 'max(16px, env(safe-area-inset-right, 0px))',
    paddingBottom: '10px',
    paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))',
    flexShrink: 0, position: 'relative', zIndex: 9,
    background: 'rgba(212,175,55,0.1)', borderBottom: '1px solid rgba(212,175,55,0.2)',
    fontSize: 12, color: 'rgba(255,255,255,0.7)',
  },
  notifBannerText: {
    flex: '1 1 200px', textAlign: 'center', lineHeight: 1.45, minWidth: 0,
  },
  pwaMobileHint: {
    flexShrink: 0, position: 'relative', zIndex: 9,
    paddingTop: '12px',
    paddingRight: 'max(16px, env(safe-area-inset-right, 0px))',
    paddingBottom: '14px',
    paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))',
    background: 'rgba(30,58,138,0.22)', borderBottom: '1px solid rgba(96,165,250,0.25)',
    color: 'rgba(226,232,240,0.92)', fontSize: 13,
  },
  pwaMobileHintTitle: {
    fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
    color: 'rgba(147,197,253,0.95)', marginBottom: 8,
  },
  pwaMobileHintText: {
    margin: 0, lineHeight: 1.5, fontSize: 13, color: 'rgba(241,245,249,0.88)', maxWidth: 560, marginLeft: 'auto', marginRight: 'auto',
  },
  pwaInstallBtn: {
    display: 'block', margin: '12px auto 0', width: '100%', maxWidth: 280,
    background: 'linear-gradient(135deg, #3b82f6, #60a5fa)', border: 'none', borderRadius: 10,
    padding: '10px 16px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  },
  notifBannerBtn: {
    background: 'linear-gradient(135deg, #C9A84C, #FFD700)', border: 'none', borderRadius: 6,
    padding: '4px 14px', color: '#000', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  },

  // Modal de confirmação (substitui window.confirm)
  confirmOverlay: {
    position: 'fixed', inset: 0, zIndex: 220,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 'max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left))',
    background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    userSelect: 'none', WebkitUserSelect: 'none',
  },
  confirmPanel: {
    width: '100%', maxWidth: 400,
    background: 'linear-gradient(165deg, #161618 0%, #0c0c0e 55%, #080809 100%)',
    border: `1px solid rgba(212,175,55,0.28)`,
    borderRadius: 18,
    padding: '24px 22px 20px',
    boxShadow: '0 28px 70px rgba(0,0,0,0.85), 0 0 0 1px rgba(212,175,55,0.06) inset, 0 0 40px rgba(212,175,55,0.04)',
    userSelect: 'none', WebkitUserSelect: 'none',
  },
  confirmTitle: {
    fontSize: 11, fontWeight: 800, color: GOLD, letterSpacing: '0.14em', textTransform: 'uppercase',
    marginBottom: 12, lineHeight: 1.35,
  },
  confirmBody: {
    margin: 0, fontSize: 15, lineHeight: 1.55, color: 'rgba(245,245,250,0.9)', marginBottom: 24, fontWeight: 450,
  },
  confirmActions: { display: 'flex', gap: 10, justifyContent: 'stretch', flexWrap: 'wrap' },
  confirmBtnSecondary: {
    flex: '1 1 120px', minHeight: 46,
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 12, padding: '0 16px', color: 'rgba(255,255,255,0.88)', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  confirmBtnPrimary: {
    flex: '1 1 120px', minHeight: 46,
    background: `linear-gradient(135deg, #C9A84C, #FFD700)`, border: 'none',
    borderRadius: 12, padding: '0 16px', color: '#0a0a0a', fontSize: 14, fontWeight: 800,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  confirmBtnDanger: {
    flex: '1 1 120px', minHeight: 46,
    background: 'linear-gradient(135deg, #991b1b, #dc2626)', border: 'none',
    borderRadius: 12, padding: '0 16px', color: '#fff', fontSize: 14, fontWeight: 800,
    cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 4px 20px rgba(220,38,38,0.25)',
  },
}
