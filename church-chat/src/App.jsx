import { useState, useEffect, useRef } from 'react'
import { db } from './firebase'
import {
  ref as dbRef,
  push,
  remove,
  onValue,
  query,
  limitToLast,
} from 'firebase/database'

const ADMIN_CODE = 'invb@admin'

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
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
    hash |= 0
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
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
  userName: { fontSize: 14, fontWeight: 600 },
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
  const clearChat = async () => {
    if (!window.confirm('Limpar todo o histórico do chat? Esta ação não pode ser desfeita.')) return
    setClearing(true)
    try {
      await remove(dbRef(db, 'messages'))
      setMessages([])
      knownIdsRef.current = new Set()
    } catch (err) { console.error(err) }
    setClearing(false)
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
          if (m.uid === userIdRef.current) return
          if ((m.ts || 0) >= joinT) {
            fireNotif(m.name || 'Alguém', m.text || '', m.id)
          }
        })
      } else {
        msgs.forEach(m => {
          if (!knownIdsRef.current.has(m.id)) {
            knownIdsRef.current.add(m.id)
            if (m.uid !== userIdRef.current) {
              fireNotif(m.name || 'Alguém', m.text || '', m.id)
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

  // ── Login ──
  if (!joined) return (
    <>
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
              const mine     = m.uid === userId
              const showName = !mine && (i === 0 || messages[i - 1]?.uid !== m.uid)
              const sent     = mine && sentIds.has(m.id)
              return (
                <div key={m.id} style={{ ...s.row, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                  <div className="bubble-wrap">
                    {showName && (
                      <div style={{ ...s.senderName, color: userColor(m.name || '') }}>
                        {m.name}
                      </div>
                    )}
                    <div style={mine ? s.bubbleMine : s.bubbleOther}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {m.file && <FilePreview file={m.file} mine={mine} />}
                        {m.text && <div style={s.msgText}>{m.text}</div>}
                      </div>
                      <div style={s.metaCol}>
                        <span style={s.msgTime}>{timeStr(m.ts)}</span>
                        {mine && (
                          <span className={sent ? 'check-on' : 'check-off'} style={s.check}>✓</span>
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
                onClick={() => setShowEmojiPicker(v => !v)}
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
  .bubble-wrap { max-width: min(78vw, 520px); }
  .check-on  { opacity: 1; animation: popIn .35s cubic-bezier(.34,1.56,.64,1) forwards; }
  .check-off { opacity: 0; }
  @keyframes popIn {
    0%   { transform: scale(0.3); opacity: 0; }
    70%  { transform: scale(1.25); }
    100% { transform: scale(1); opacity: 1; }
  }
  @media (min-width: 700px) {
    .bubble-wrap { max-width: min(65%, 480px) !important; }
  }
  textarea { field-sizing: content; min-height: 40px; max-height: 140px; overflow-y: auto; }
  input::placeholder { color: rgba(212,175,55,0.35); }
  textarea::placeholder { color: rgba(255,255,255,0.25); }
  input:focus { border-color: rgba(212,175,55,0.6) !important; box-shadow: 0 0 0 3px rgba(212,175,55,0.08); }
  textarea:focus { border-color: rgba(212,175,55,0.5) !important; }
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
  bgBlur: { position: 'fixed', inset: 0, backgroundImage: 'url(/images/image.jpg)', backgroundSize: 'cover', backgroundPosition: 'center', filter: 'blur(5px)', transform: 'scale(1.08)', opacity: 0.45, zIndex: -1, pointerEvents: 'none' },

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
  msgArea: { flex: 1, overflowY: 'auto', padding: '16px 14px 8px', display: 'flex', flexDirection: 'column', gap: 3 },
  empty: { textAlign: 'center', color: 'rgba(212,175,55,0.2)', marginTop: 80, fontSize: 14 },
  row: { display: 'flex', marginBottom: 2 },
  senderName: { fontSize: 11, fontWeight: 700, paddingLeft: 12, marginBottom: 3, letterSpacing: '0.02em' },

  // Bubbles
  bubbleMine: {
    background: `linear-gradient(135deg, #2a1f00, #3d2d00)`,
    border: `1px solid rgba(212,175,55,0.35)`,
    borderRadius: '18px 18px 4px 18px', padding: '9px 12px',
    display: 'flex', alignItems: 'flex-end', gap: 8,
  },
  bubbleOther: {
    background: '#0d0d0d', border: `1px solid rgba(255,255,255,0.07)`,
    borderRadius: '18px 18px 18px 4px', padding: '9px 12px',
    display: 'flex', alignItems: 'flex-end', gap: 8,
  },
  msgText: { fontSize: 15, lineHeight: 1.5, color: '#fff', wordBreak: 'break-word' },
  metaCol: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0, paddingBottom: 1 },
  msgTime: { fontSize: 10, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap' },
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
    display: 'flex', gap: 8, padding: '10px 12px',
    borderTop: `1px solid ${GOLD_DIM}`, background: '#050505',
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
}
