import { useState, useEffect, useRef } from 'react'
import { db } from './firebase'
import {
  ref as dbRef,
  push,
  remove,
  update,
  onValue,
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
function FilePreview({ file, mine }) {
  const src = file.dataUrl || file.url
  if (file.type?.startsWith('image/')) return (
    <div style={{ marginBottom: 4 }}>
      <img
        src={src} alt={file.name}
        style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 8, display: 'block', cursor: 'pointer', border: '1px solid rgba(212,175,55,0.25)' }}
        onClick={() => { const w = window.open(); w.document.write(`<body style="margin:0;background:#000"><img src="${src}" style="max-width:100%;max-height:100vh;display:block;margin:auto"/></body>`) }}
      />
      <div style={{ fontSize: 10, color: 'rgba(212,175,55,0.45)', marginTop: 3 }}>
        {file.name} · {fmtSize(file.size)}
      </div>
    </div>
  )
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
  overlay: { position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: '62px 16px 0' },
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
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [editingId, setEditingId]       = useState(null)
  const [editDraft, setEditDraft]       = useState('')
  const [msgActionBusy, setMsgActionBusy] = useState(null)
  const [confirmDialog, setConfirmDialog]   = useState(null)
  const bottomRef    = useRef(null)
  const textareaRef  = useRef(null)
  const fileRef      = useRef(null)
  const emojiPickerRef = useRef(null)
  const knownIdsRef  = useRef(null)
  const joinTimeRef  = useRef(Date.now())
  const userIdRef    = useRef(userId)

  // ── Notificações ──
  const requestNotifPermission = async () => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') { setNotifPerm(Notification.permission); return }
    const perm = await Notification.requestPermission()
    setNotifPerm(perm)
  }

  // Função global de notificação — não depende de closure
  // messageId em tag evita que o Chrome substitua todas pelas mesmas (tag fixa = só a última aparece)
  function fireNotif(senderName, text, messageId) {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    const body = text
      ? (text.length > 80 ? text.slice(0, 80) + '…' : text)
      : '📎 Arquivo recebido'
    const tag = messageId ? `chat-${messageId}` : `chat-${Date.now()}`
    try {
      new Notification(senderName, {
        body,
        icon: '/images/notif-icon.png',
        tag,
        lang: 'pt-BR',
        silent: false,
      })
    } catch (e) { console.warn('Notif error:', e) }
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

  const handleJoin = () => {
    if (!name.trim()) return
    const admin = adminCode.trim() === ADMIN_CODE
    saveSession(userId, name.trim(), admin)
    setIsAdmin(admin)
    joinTimeRef.current = Date.now()
    setJoined(true)
  }

  const handleExit = () => {
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
            fireNotif((m.name || 'Alguém').toLocaleUpperCase('pt-BR'), m.text || '', m.id)
          }
        })
      } else {
        msgs.forEach(m => {
          if (!knownIdsRef.current.has(m.id)) {
            knownIdsRef.current.add(m.id)
            if (m.uid !== userIdRef.current && !messageIsTombstone(m)) {
              fireNotif((m.name || 'Alguém').toLocaleUpperCase('pt-BR'), m.text || '', m.id)
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

  const insertEmoji = emoji => {
    const el = textareaRef.current
    if (!el) {
      setInput(prev => prev + emoji)
      setShowEmojiPicker(false)
      return
    }
    const start = el.selectionStart ?? input.length
    const end = el.selectionEnd ?? input.length
    const next = input.slice(0, start) + emoji + input.slice(end)
    setInput(next)
    setShowEmojiPicker(false)
    requestAnimationFrame(() => {
      el.focus()
      // setSelectionRange usa índices UTF-16; string.length está alinhado a isso
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
    })
  }

  const send = async () => {
    if (!input.trim() && !pendingFile) return
    setSending(true)
    try {
      const msgRef = await push(dbRef(db, 'messages'), {
        uid: userId,
        name,
        text: input.trim(),
        ts: Date.now(),
        file: pendingFile || null,
      })
      setSentIds(prev => new Set([...prev, msgRef.key]))
      setInput('')
      setPendingFile(null)
      textareaRef.current?.focus()
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
    setEditDraft(m.text || '')
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
    const nextText = editDraft.trim()
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

      {notifPerm !== 'granted' && notifPerm !== 'unsupported' && (
        <div style={s.notifBanner}>
          {notifPerm === 'denied' ? (
            <span>
              🔒 Cadeado na barra → <b>Notificações</b> → <b>Permitir</b> → recarregue a página
            </span>
          ) : (
            <span>🔔 Ative notificações para avisos de novas mensagens</span>
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
            onClick={() => fireNotif('Chat - Nova Vida', '🔔 Notificações estão funcionando!', null)}>
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
                  style={{
                    ...s.row,
                    justifyContent: mine ? 'flex-end' : 'flex-start',
                  }}
                >
                  <div style={mine ? s.msgRowOuterMine : s.msgRowOuterPeer}>
                    {!mine && (
                      <div style={s.peerAvatarCol}>
                        {showName ? (
                          <div
                            style={{
                              ...s.peerAvatar,
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
                          <div style={s.peerAvatarSpacer} aria-hidden />
                        )}
                      </div>
                    )}
                  <div style={s.msgRowWithReaction}>
                    <div className="bubble-wrap" style={{ flexShrink: 0 }}>
                    {showName && (
                      <div
                        style={{
                          ...s.senderName,
                          ...(mine ? {} : s.senderNamePeer),
                          color: userColor(m.name || ''),
                        }}
                      >
                        {m.name}
                      </div>
                    )}
                    <div
                      style={
                        mine
                          ? s.bubbleMine
                          : { ...s.bubbleOther, borderLeft: `4px solid ${peerColor}` }
                      }
                    >
                      <div style={s.bubbleTopRow}>
                        <div style={s.bubbleBody}>
                          {isEditing ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {m.file && <FilePreview file={m.file} mine={mine} />}
                              <textarea
                                style={{ ...s.editMsgTextarea, minHeight: 72 }}
                                value={editDraft}
                                onChange={e => setEditDraft(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault()
                                    saveEdit()
                                  }
                                }}
                                autoFocus
                                rows={3}
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
                              {m.text && <div style={s.msgText}>{m.text}</div>}
                              {m.editedOnce && (
                                <div style={s.msgEditedHint}>editada</div>
                              )}
                            </>
                          )}
                        </div>
                        <div style={s.bubbleMetaInline}>
                          <span style={s.msgTime}>{timeStr(m.ts)}</span>
                          {mine && (
                            <span className={sent ? 'check-on' : 'check-off'} style={s.check}>✓</span>
                          )}
                        </div>
                      </div>
                    </div>
                    {mine && !isEditing && (
                      <div style={s.msgActions}>
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
            <textarea
              ref={textareaRef} style={s.textarea}
              placeholder={pendingFile ? 'Adicione uma legenda...' : 'Mensagem...'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
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
  .bubble-wrap { width: fit-content; max-width: min(78vw, 520px); min-width: min(100%, 120px); }
  .check-on  { opacity: 1; animation: popIn .35s cubic-bezier(.34,1.56,.64,1) forwards; }
  .check-off { opacity: 0; }
  @keyframes popIn {
    0%   { transform: scale(0.3); opacity: 0; }
    70%  { transform: scale(1.25); }
    100% { transform: scale(1); opacity: 1; }
  }
  @media (min-width: 700px) {
    .bubble-wrap { max-width: min(65%, 480px) !important; min-width: min(100%, 120px) !important; }
  }
  textarea { field-sizing: content; min-height: 40px; max-height: 140px; overflow-y: auto; }
  input::placeholder { color: rgba(212,175,55,0.35); }
  textarea::placeholder { color: rgba(255,255,255,0.25); }
  input:focus { border-color: rgba(212,175,55,0.6) !important; box-shadow: 0 0 0 3px rgba(212,175,55,0.08); }
  textarea:focus { border-color: rgba(212,175,55,0.5) !important; }
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
  loginOuter: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', position: 'relative', zIndex: 1 },
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

  // Header
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 18px', borderBottom: `2px solid rgba(212,175,55,0.45)`,
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
  row: { display: 'flex', marginBottom: 2 },
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
  senderName: {
    fontSize: 14, fontWeight: 700, paddingLeft: 12, marginBottom: 3,
    letterSpacing: '0.06em', textTransform: 'uppercase',
  },
  senderNamePeer: { paddingLeft: 2 },
  msgRowOuterMine: {
    display: 'inline-flex', flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    maxWidth: 'min(100%, 520px)', position: 'relative',
  },
  msgRowOuterPeer: {
    display: 'inline-flex', flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    maxWidth: 'min(100%, 520px)', position: 'relative',
  },
  peerAvatarCol: {
    width: 38, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
    alignItems: 'center', paddingBottom: 2,
  },
  peerAvatar: {
    width: 34, height: 34, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 800, fontFamily: 'inherit', border: '2px solid', flexShrink: 0,
  },
  peerAvatarSpacer: { width: 34, height: 34, flexShrink: 0 },

  // Bubbles
  bubbleMine: {
    background: `linear-gradient(135deg, #2a1f00, #3d2d00)`,
    border: `1px solid rgba(212,175,55,0.35)`,
    borderRadius: '18px 18px 4px 18px', padding: '8px 11px',
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0,
    boxSizing: 'border-box',
    width: 'fit-content', maxWidth: '100%', minWidth: 'min(100%, 120px)',
  },
  bubbleOther: {
    background: '#0d0d0d', border: `1px solid rgba(255,255,255,0.07)`,
    borderRadius: '18px 18px 18px 4px', padding: '8px 11px',
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0,
    boxSizing: 'border-box',
    width: 'fit-content', maxWidth: '100%', minWidth: 'min(100%, 120px)',
  },
  bubbleBody: { width: '100%', minWidth: 0 },
  bubbleTopRow: {
    display: 'flex', flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    width: '100%', minWidth: 0,
  },
  bubbleMetaInline: {
    display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
    gap: 5, flexShrink: 0, alignSelf: 'flex-end', paddingBottom: 1, marginLeft: 4,
  },
  msgText: {
    fontSize: 15, lineHeight: 1.5, color: '#fff',
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal',
  },
  msgEditedHint: { fontSize: 10, color: 'rgba(212,175,55,0.45)', marginTop: 4, fontWeight: 500 },
  msgRowWithReaction: {
    display: 'inline-flex', flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    position: 'relative', flex: '1 1 auto', minWidth: 0,
  },
  msgActions: {
    display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6,
    paddingRight: 14, paddingLeft: 4, boxSizing: 'border-box', width: '100%',
  },
  msgActionBtn: {
    background: 'none', border: 'none', color: 'rgba(212,175,55,0.55)', fontSize: 11,
    fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '2px 4px', textDecoration: 'underline',
  },
  editMsgTextarea: {
    width: '100%', background: 'rgba(0,0,0,0.35)', border: `1px solid ${GOLD_DIM}`, borderRadius: 10,
    padding: '8px 10px', color: '#fff', fontSize: 14, fontFamily: 'inherit', outline: 'none', resize: 'vertical',
    lineHeight: 1.45,
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
  msgTime: { fontSize: 10, color: 'rgba(255,255,255,0.32)', whiteSpace: 'nowrap', lineHeight: 1.2 },
  check: { fontSize: 13, color: GOLD, fontWeight: 700, lineHeight: 1 },

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
    flexShrink: 0, alignItems: 'flex-end',
  },
  attachBtn: {
    width: 42, height: 42, borderRadius: 12, background: GOLD_FAINT, border: `1px solid ${GOLD_DIM}`,
    fontSize: 18, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  emojiPickerWrap: { position: 'relative', flexShrink: 0 },
  emojiPopover: {
    position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 50,
    display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4,
    padding: 10, maxWidth: 280,
    background: '#121212', border: `1px solid ${GOLD_DIM}`, borderRadius: 14,
    boxShadow: '0 12px 40px rgba(0,0,0,0.65)',
  },
  emojiCell: {
    width: 34, height: 34, padding: 0, fontSize: 20, lineHeight: 1,
    background: 'rgba(255,255,255,0.04)', border: '1px solid transparent', borderRadius: 8,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  textarea: {
    flex: 1, background: '#0d0d0d', border: `1.5px solid rgba(255,255,255,0.08)`,
    borderRadius: 12, padding: '10px 14px', color: '#fff', fontSize: 15,
    fontFamily: 'inherit', outline: 'none', resize: 'none', lineHeight: 1.5, transition: 'border-color .2s',
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
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
    padding: '8px 16px', flexShrink: 0, position: 'relative', zIndex: 9,
    background: 'rgba(212,175,55,0.1)', borderBottom: '1px solid rgba(212,175,55,0.2)',
    fontSize: 12, color: 'rgba(255,255,255,0.7)',
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
