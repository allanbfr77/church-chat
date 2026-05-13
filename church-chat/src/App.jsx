import { useState, useEffect, useRef } from 'react'
import { db } from './firebase'
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
} from 'firebase/database'

const ADMIN_CODE = 'invb@admin'

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
  const h = size === 'lg' ? 90 : 38
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
function userColor(name) {
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
function saveSession(userId, name, isAdmin = false) {
  try { localStorage.setItem('cruch_session', JSON.stringify({ userId, name, isAdmin })) } catch {}
}
function clearSession() {
  try { localStorage.removeItem('cruch_session') } catch {}
}

// ── File Preview ──────────────────────────────────────────────
function fileLooksLikeImage(file, src) {
  if (file.type && String(file.type).startsWith('image/')) return true
  if (typeof src === 'string' && src.startsWith('data:image/')) return true
  return /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i.test(String(file.name || ''))
}

function FilePreview({ file, mine }) {
  const src = file.dataUrl || file.url
  const [fullOpen, setFullOpen] = useState(false)

  useEffect(() => {
    if (!fullOpen) return
    const onKey = e => {
      if (e.key === 'Escape') setFullOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [fullOpen])

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
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Imagem em tamanho grande"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 400,
              background: 'rgba(0,0,0,0.93)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding:
                'max(12px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px))',
            }}
            onClick={() => setFullOpen(false)}
          >
            <button
              type="button"
              aria-label="Fechar"
              onClick={e => {
                e.stopPropagation()
                setFullOpen(false)
              }}
              style={{
                position: 'fixed',
                top: 'max(10px, env(safe-area-inset-top, 0px))',
                right: 'max(10px, env(safe-area-inset-right, 0px))',
                zIndex: 401,
                width: 44,
                height: 44,
                borderRadius: '50%',
                border: '1px solid rgba(255,255,255,0.28)',
                background: 'rgba(0,0,0,0.55)',
                color: '#fff',
                fontSize: 20,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
                fontFamily: 'inherit',
              }}
            >
              ✕
            </button>
            <div
              onClick={e => e.stopPropagation()}
              style={{
                flex: '1 1 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 0,
                minHeight: 0,
                width: '100%',
                height: '100%',
                maxHeight: '100%',
              }}
            >
              <img
                src={src}
                alt={file.name || 'Imagem enviada no chat'}
                style={{
                  maxWidth: '100%',
                  maxHeight: 'min(92dvh, calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 56px))',
                  width: 'auto',
                  height: 'auto',
                  objectFit: 'contain',
                  borderRadius: 4,
                  boxShadow: '0 12px 48px rgba(0,0,0,0.65)',
                }}
              />
            </div>
          </div>
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
            <div style={sm.empty}>Nenhum usuário ativo recentemente</div>
          )}
          {users.map((u, i) => (
            <div key={i} style={sm.userRow}>
              <div style={{ ...sm.dot, background: userColor(u), boxShadow: `0 0 6px ${userColor(u)}` }} />
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
  const [joined, setJoined]           = useState(!!stored?.name)
  const [messages, setMessages]       = useState([])
  const [input, setInput]             = useState('')
  const [onlineUsers, setOnlineUsers] = useState([])
  const [showOnline, setShowOnline]   = useState(false)
  const [sentIds, setSentIds]         = useState(new Set())
  const [pendingFile, setPendingFile] = useState(null)
  const [reading, setReading]         = useState(false)
  const [fileError, setFileError]     = useState('')
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
  /** Snapshot bruto de `typing/` (reavaliado no relógio para sumir entradas velhas sem novo evento) */
  const [typingSnap, setTypingSnap]     = useState(null)
  const [typingUsers, setTypingUsers]   = useState([])
  const [editingId, setEditingId]       = useState(null)
  const [editDraft, setEditDraft]       = useState('')
  const [msgActionBusy, setMsgActionBusy] = useState(null)
  const [confirmDialog, setConfirmDialog]   = useState(null)
  const bottomRef    = useRef(null)
  const messageInputRef = useRef(null)
  const fileRef      = useRef(null)
  const emojiPickerRef = useRef(null)
  const knownIdsRef  = useRef(null)
  const joinTimeRef  = useRef(Date.now())
  const userIdRef    = useRef(userId)
  const nameRef      = useRef(name)
  nameRef.current = name
  const typingTimersRef = useRef({ idle: null, trailing: null })
  const lastTypingWriteRef = useRef(0)

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

  const handleJoin = () => {
    if (!name.trim()) return
    const admin = adminCode.trim() === ADMIN_CODE
    saveSession(userId, name.trim(), admin)
    setIsAdmin(admin)
    joinTimeRef.current = Date.now()
    setJoined(true)
  }

  const handleExit = () => {
    clearTypingBroadcast()
    clearSession()
    setJoined(false)
    setIsAdmin(false)
    setName('')
    setAdminCode('')
    setShowAdminInput(false)
    setShowOnline(false)
    knownIdsRef.current = null
  }

  // Re-checa permissão quando o usuário volta para a aba (após mudar nas config do Chrome)
  useEffect(() => {
    if (typeof Notification === 'undefined') return
    const check = () => setNotifPerm(Notification.permission)
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])

  // Listen for messages in real time
  useEffect(() => {
    if (!joined) return
    const q = query(dbRef(db, 'messages'), limitToLast(100))
    const unsub = onValue(q, snap => {
      const data = snap.val()
      // Não usar Set() aqui: deixa knownIdsRef como null até o primeiro snapshot com dados.
      // Caso contrário, um snapshot vazio seguido do histórico faz o Chrome disparar dezenas de notificações
      // de uma vez (substituindo na bandeja) e o site pode ser silenciado ou parecer "sem notificação".
      if (!data) {
        setMessages([])
        setOnlineUsers([])
        return
      }
      const msgs = Object.entries(data).map(([id, v]) => ({ id, ...v }))
      msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
      const joinT = joinTimeRef.current

      // Primeira carga com dados: marcar tudo como visto; notificar só mensagens de outros com ts >= entrada na sala
      // (corrige sala vazia → primeira mensagem, que antes era tratada só como "seed" e nunca notificava)
      if (knownIdsRef.current === null) {
        knownIdsRef.current = new Set(msgs.map(m => m.id))
        msgs.forEach(m => {
          if (m.uid === userIdRef.current || messageIsTombstone(m)) return
          if ((m.ts || 0) >= joinT) {
            fireNotif((m.name || 'Alguém').toLocaleUpperCase('pt-BR'), collapseChatLineBreaks(m.text || ''), m.id)
          }
        })
      } else {
        msgs.forEach(m => {
          if (!knownIdsRef.current.has(m.id)) {
            knownIdsRef.current.add(m.id)
            if (m.uid !== userIdRef.current && !messageIsTombstone(m)) {
              fireNotif((m.name || 'Alguém').toLocaleUpperCase('pt-BR'), collapseChatLineBreaks(m.text || ''), m.id)
            }
          }
        })
      }

      setMessages(msgs)
      // Build online users from recent messages (last 5 min)
      const cutoff = Date.now() - 5 * 60 * 1000
      const userMap = new Map()
      msgs.filter(m => m.ts > cutoff).forEach(m => {
        if (!userMap.has(m.uid)) userMap.set(m.uid, m.name)
      })
      if (!userMap.has(userId)) userMap.set(userId, name)
      setOnlineUsers(Array.from(userMap.values()))
    })
    return () => unsub()
  }, [joined, userId, name])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!showEmojiPicker) return
    const close = e => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target)) {
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showEmojiPicker])

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
      el.focus()
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
        file: pendingFile || null,
      })
      setSentIds(prev => new Set([...prev, msgRef.key]))
      setInput('')
      setPendingFile(null)
      messageInputRef.current?.focus()
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

  const startEdit = m => {
    if (m.uid !== userId || messageIsTombstone(m) || m.editedOnce) return
    setEditingId(m.id)
    setEditDraft(collapseChatLineBreaks(m.text || ''))
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
          <p style={s.loginSub}>Entre com seu nome para começar</p>
          <input
            style={s.nameInput} placeholder="Seu nome..." value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && name.trim() && handleJoin()}
            autoFocus
          />
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
            style={{ ...s.joinBtn, opacity: name.trim() ? 1 : 0.35 }}
            disabled={!name.trim()} onClick={handleJoin}
          >Entrar</button>
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
    <div style={s.page}>
      <div style={s.bgBlur} />
      {showOnline && <OnlineModal users={onlineUsers} onClose={() => setShowOnline(false)} />}

      <div style={s.header}>
        <div style={s.headerLeft}>
          <Logo size="sm" />
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
          <button style={s.exitBtn} onClick={handleExit}>Sair</button>
        </div>
      </div>

      {joined && !isStandalonePWA() && (isAndroidDevice() || isIOSDevice()) && (
        <div style={s.pwaMobileHint}>
          <div style={s.pwaMobileHintTitle}>📱 Celular: avisos com o chat em segundo plano</div>
          {isAndroidDevice() && (
            <p style={s.pwaMobileHintText}>
              Instale o <strong>NVB Chat</strong> como aplicativo: menu do Chrome (<strong>⋮</strong>) →{' '}
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
                  Se abre pelo ícone na Tela de Início: <strong>Ajustes</strong> do iPhone → <strong>NVB Chat</strong> → <strong>Notificações</strong> → Permitir.
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

          <div style={s.msgArea}>
            {messages.length === 0 && (
              <div style={s.empty}>Nenhuma mensagem ainda. Diga olá! 👋</div>
            )}
            {messages.map((m, i) => {
              if (messageIsTombstone(m)) {
                return (
                  <div key={m.id} style={s.rowSystem}>
                    <div style={s.systemTombstone} role="status" aria-live="polite">
                      <span style={s.systemTombstoneLabel}>Sistema</span>
                      <span style={s.systemTombstoneText}>{MSG_APAGADA_FRASE}</span>
                      <span style={s.systemTombstoneMeta}>
                        {m.name} · {timeStr(m.deletedAt || m.ts)}
                      </span>
                    </div>
                  </div>
                )
              }

              const mine     = m.uid === userId
              const showName = !mine && (i === 0 || messages[i - 1]?.uid !== m.uid)
              const sent     = mine && sentIds.has(m.id)
              const isEditing = editingId === m.id
              const busy     = msgActionBusy === m.id
              const canEditMine = mine && !m.editedOnce

              const peerColor = !mine ? userColor(m.name || '') : null

              return (
                <div
                  key={m.id}
                  className={`chatMsgRow ${mine ? 'chatMsgRow--sent' : 'chatMsgRow--recv'}`}
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
                            {nameInitial(m.name)}
                          </div>
                        ) : (
                          <div className="chatMsgAvatarSpacer" aria-hidden />
                        )}
                      </div>
                    )}
                    <div className={`chatMsgStack ${mine ? 'chatMsgStack--sent' : 'chatMsgStack--recv'}`}>
                      {showName && !mine && (
                        <div className="chatMsgAuthor" style={{ color: userColor(m.name || '') }}>
                          {m.name}
                        </div>
                      )}
                      <div
                        className={`chatMsgBubble ${mine ? 'chatMsgBubble--sent' : 'chatMsgBubble--recv'}`}
                        style={!mine && peerColor ? { ['--chat-accent']: peerColor } : undefined}
                      >
                        <div className="chatMsgBody">
                          {isEditing ? (
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
                              {m.file && <FilePreview file={m.file} mine={mine} />}
                              {m.text && (
                                <div className="chatMsgText">{collapseChatLineBreaks(m.text)}</div>
                              )}
                              {m.editedOnce && <div className="chatMsgEdited">editada</div>}
                            </>
                          )}
                        </div>
                        {!isEditing && (
                          <div className="chatMsgMeta">
                            <span>{timeStr(m.ts)}</span>
                            {mine && (
                              <span className={sent ? 'check-on chatMsgCheck' : 'check-off chatMsgCheck'}>✓</span>
                            )}
                          </div>
                        )}
                      </div>
                      {mine && !isEditing && (
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

          <div style={s.inputBar}>
            <div ref={emojiPickerRef} style={s.emojiPickerWrap}>
              <button
                type="button"
                style={{ ...s.attachBtn, fontSize: 20 }}
                onClick={() => { setShowEmojiPicker(v => !v) }}
                title="Emoticons"
                aria-expanded={showEmojiPicker}
                aria-haspopup="true"
              >
                😊
              </button>
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
            <button
              style={s.attachBtn}
              onClick={() => fileRef.current?.click()}
              title="Anexar arquivo (máx 10MB)"
              disabled={reading}
            >
              {reading ? '⏳' : '📎'}
            </button>
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
            />
            <button
              style={{ ...s.sendBtn, opacity: canSend ? 1 : 0.3 }}
              onClick={send} disabled={!canSend}
            >
              {sending ? '…' : '➤'}
            </button>
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
  html, body { margin: 0; padding: 0; overflow: hidden; }
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
  .chatMsgRow--sent { justify-content: flex-end; }
  .chatMsgRow--recv { justify-content: flex-start; }

  /* Grupo: avatar + coluna de conteúdo. max-width fica AQUI. */
  .chatMsgGroup {
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: 10px;
    max-width: min(78vw, 560px);
  }

  /* Slot do avatar */
  .chatMsgAvatarSlot {
    width: 38px;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    padding-bottom: 2px;
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
    border: 1px solid rgba(212,175,55,0.35);
    border-radius: 18px 18px 4px 18px;
  }
  .chatMsgBubble--recv {
    background: #0d0d0d;
    border: 1px solid rgba(255,255,255,0.07);
    border-left: 4px solid var(--chat-accent, rgba(212,175,55,0.45));
    border-radius: 18px 18px 18px 4px;
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
  .chatMsgEdited {
    font-size: 10px;
    color: rgba(212,175,55,0.45);
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
    color: rgba(255,255,255,0.32);
    line-height: 1.2;
    white-space: nowrap;
    width: 0;
    min-width: 100%;
  }
  .chatMsgCheck {
    font-size: 13px;
    font-weight: 700;
    color: #D4AF37;
    line-height: 1;
  }

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
  .chat-msg-input::placeholder { color: rgba(255,255,255,0.25); }
  input:focus { border-color: rgba(212,175,55,0.6) !important; box-shadow: 0 0 0 3px rgba(212,175,55,0.08); }
  .chat-msg-input:focus { border-color: rgba(212,175,55,0.5) !important; }
  button, [role="button"] {
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
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
  page: { position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#000', isolation: 'isolate', fontFamily: "'Outfit', system-ui, sans-serif", color: '#e8e8ee' },
  bgBlur: { position: 'fixed', inset: 0, backgroundImage: 'url(/images/image.jpg)', backgroundSize: 'cover', backgroundPosition: 'center', filter: 'blur(2px)', transform: 'scale(1.04)', opacity: 0.62, zIndex: -1, pointerEvents: 'none' },

  // Login
  loginOuter: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(24px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(24px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))', position: 'relative', zIndex: 1 },
  loginCard: {
    width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    background: '#080808', border: `1px solid ${GOLD_DIM}`, borderRadius: 20, padding: '44px 36px',
  },
  loginLogo: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
  loginTitle: { fontSize: 26, fontWeight: 700, color: GOLD, letterSpacing: '0.02em' },
  loginSub: { fontSize: 14, color: 'rgba(255,255,255,0.35)', textAlign: 'center' },
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
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 'max(10px, env(safe-area-inset-top, 0px))',
    paddingRight: 'max(18px, env(safe-area-inset-right, 0px))',
    paddingBottom: '10px',
    paddingLeft: 'max(18px, env(safe-area-inset-left, 0px))',
    borderBottom: `2px solid rgba(212,175,55,0.45)`,
    background: '#0a0a0a', flexShrink: 0, zIndex: 10, position: 'relative',
    boxShadow: '0 2px 20px rgba(0,0,0,0.8)',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  headerTitle: { fontSize: 16, fontWeight: 700, color: GOLD, letterSpacing: '0.03em' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 7px #4ade80', flexShrink: 0 },
  onlineBtn: {
    display: 'flex', alignItems: 'center', gap: 7,
    background: GOLD_FAINT, border: `1px solid ${GOLD_DIM}`,
    borderRadius: 20, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background .2s',
  },
  onlineCount: { fontSize: 12, color: GOLD, fontWeight: 600 },
  exitBtn: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, padding: '5px 13px', color: 'rgba(255,255,255,0.4)', fontSize: 12,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Layout
  desktopWrapper: { flex: 1, display: 'flex', overflow: 'hidden', justifyContent: 'center', position: 'relative', zIndex: 1 },
  chatPanel: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', maxWidth: 720,
    borderLeft: `1px solid ${GOLD_DIM}`, borderRight: `1px solid ${GOLD_DIM}`,
  },
  msgArea: {
    flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3,
    background: 'rgba(0,0,0,0.08)',
    padding:
      '16px calc(14px + env(safe-area-inset-right, 0px)) 10px calc(14px + env(safe-area-inset-left, 0px))',
  },
  empty: { textAlign: 'center', color: 'rgba(212,175,55,0.2)', marginTop: 80, fontSize: 14 },
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
      '12px calc(12px + env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px))',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    borderLeft: '1px solid rgba(255,255,255,0.04)',
    borderRight: '1px solid rgba(255,255,255,0.04)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    background: 'rgba(14,14,18,0.78)',
    boxShadow: '0 -10px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
    flexShrink: 0, alignItems: 'center',
  },
  attachBtn: {
    width: 42, height: 42, borderRadius: 12, background: GOLD_FAINT, border: `1px solid ${GOLD_DIM}`,
    fontSize: 18, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  emojiPickerWrap: { position: 'relative', flexShrink: 0 },
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
    flex: 1, minWidth: 0, background: '#0d0d0d', border: `1.5px solid rgba(255,255,255,0.08)`,
    borderRadius: 12, padding: '10px 14px', color: '#fff', fontSize: 15,
    fontFamily: 'inherit', outline: 'none', lineHeight: 1.5, transition: 'border-color .2s',
    boxSizing: 'border-box',
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 12,
    background: `linear-gradient(135deg, #C9A84C, #FFD700)`,
    border: 'none', color: '#000', fontSize: 17, fontWeight: 700,
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
    userSelect: 'text', WebkitUserSelect: 'text',
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
