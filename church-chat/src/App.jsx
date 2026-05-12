import { useState, useEffect, useRef } from 'react'
import { db } from './firebase'
import {
  ref as dbRef,
  push,
  onValue,
  query,
  limitToLast,
} from 'firebase/database'

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

// ── File Preview ─────────────────────────────────────────────
function FilePreview({ file, mine }) {
  // file.dataUrl is a base64 data URL stored directly in Firebase
  const src = file.dataUrl || file.url
  if (file.type?.startsWith('image/')) return (
    <div style={{ marginBottom: 4 }}>
      <img
        src={src} alt={file.name}
        style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 8, display: 'block', cursor: 'pointer' }}
        onClick={() => { const w = window.open(); w.document.write(`<body style="margin:0;background:#000"><img src="${src}" style="max-width:100%;max-height:100vh;display:block;margin:auto"/></body>`) }}
      />
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
        {file.name} · {fmtSize(file.size)}
      </div>
    </div>
  )
  return (
    <a
      href={src} download={file.name}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: mine ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.06)',
        borderRadius: 10, padding: '10px 12px', marginBottom: 4,
        textDecoration: 'none', border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <span style={{ fontSize: 24, flexShrink: 0 }}>{fileIcon(file.type)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {file.name}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
          {fmtSize(file.size)} · baixar
        </div>
      </div>
    </a>
  )
}

// ── Main App ─────────────────────────────────────────────────
export default function App() {
  const [userId]      = useState(uid)
  const [name, setName]           = useState('')
  const [joined, setJoined]       = useState(false)
  const [messages, setMessages]   = useState([])
  const [input, setInput]         = useState('')
  const [online, setOnline]       = useState(1)
  const [sentIds, setSentIds]     = useState(new Set())
  const [pendingFile, setPendingFile] = useState(null)
  const [reading, setReading]     = useState(false)
  const [fileError, setFileError] = useState('')
  const [sending, setSending]     = useState(false)
  const bottomRef   = useRef(null)
  const textareaRef = useRef(null)
  const fileRef     = useRef(null)

  // Listen for messages in real time
  useEffect(() => {
    if (!joined) return
    const q = query(dbRef(db, 'messages'), limitToLast(100))
    const unsub = onValue(q, snap => {
      const data = snap.val()
      if (!data) { setMessages([]); return }
      const msgs = Object.entries(data).map(([id, v]) => ({ id, ...v }))
      msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
      setMessages(msgs)
      const cutoff = Date.now() - 5 * 60 * 1000
      const users = new Set(msgs.filter(m => m.ts > cutoff).map(m => m.uid))
      users.add(userId)
      setOnline(users.size)
    })
    return () => unsub()
  }, [joined, userId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
    <div style={s.page}>
      <style>{css}</style>
      <div style={s.loginOuter}>
        <div style={s.loginCard}>
          <div style={s.loginIcon}>💬</div>
          <h1 style={s.loginTitle}>Chat</h1>
          <p style={s.loginSub}>Entre com seu nome para começar</p>
          <input
            style={s.nameInput} placeholder="Seu nome..." value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && name.trim() && setJoined(true)}
            autoFocus
          />
          <button
            style={{ ...s.joinBtn, opacity: name.trim() ? 1 : 0.35 }}
            disabled={!name.trim()} onClick={() => setJoined(true)}
          >Entrar</button>
        </div>
      </div>
    </div>
  )

  // ── Chat ──
  return (
    <div style={s.page}>
      <style>{css}</style>

      <div style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.headerIcon}>💬</span>
          <span style={s.headerTitle}>Chat</span>
        </div>
        <div style={s.headerRight}>
          <span style={s.dot} />
          <span style={s.onlineCount}>{online} online</span>
          <button style={s.exitBtn} onClick={() => setJoined(false)}>Sair</button>
        </div>
      </div>

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
                    {showName && <div style={s.senderName}>{m.name}</div>}
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

          {/* Reading indicator */}
          {reading && (
            <div style={s.pendingBar}>
              <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>⏳ Carregando arquivo...</span>
            </div>
          )}

          {/* Pending file */}
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
          <div style={s.hint}>Enter para enviar · Shift+Enter nova linha · Máx 10MB</div>

        </div>
      </div>
    </div>
  )
}

// ── CSS ───────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; }
  body { overflow: hidden; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
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
`

// ── Styles ────────────────────────────────────────────────────
const s = {
  page: { height: '100svh', display: 'flex', flexDirection: 'column', background: '#0f0f13', fontFamily: "'Outfit', system-ui, sans-serif", color: '#e8e8ee', overflow: 'hidden' },
  loginOuter: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' },
  loginCard: { width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, padding: '40px 32px' },
  loginIcon: { fontSize: 52, lineHeight: 1 },
  loginTitle: { fontSize: 26, fontWeight: 600, color: '#fff', letterSpacing: '-0.02em' },
  loginSub: { fontSize: 14, color: 'rgba(255,255,255,0.4)', textAlign: 'center' },
  nameInput: { width: '100%', background: 'rgba(255,255,255,0.06)', border: '1.5px solid rgba(255,255,255,0.12)', borderRadius: 12, padding: '13px 16px', color: '#fff', fontSize: 16, outline: 'none', fontFamily: 'inherit' },
  joinBtn: { width: '100%', background: '#4f8ef7', border: 'none', borderRadius: 12, padding: '14px', color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(15,15,19,0.95)', backdropFilter: 'blur(8px)', flexShrink: 0, zIndex: 10 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  headerIcon: { fontSize: 20 },
  headerTitle: { fontSize: 16, fontWeight: 600, color: '#fff' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 6px #4ade80' },
  onlineCount: { fontSize: 12, color: 'rgba(255,255,255,0.4)' },
  exitBtn: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 13px', color: 'rgba(255,255,255,0.5)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' },
  desktopWrapper: { flex: 1, display: 'flex', overflow: 'hidden', justifyContent: 'center' },
  chatPanel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', maxWidth: 720, borderLeft: '1px solid rgba(255,255,255,0.05)', borderRight: '1px solid rgba(255,255,255,0.05)' },
  msgArea: { flex: 1, overflowY: 'auto', padding: '16px 14px 8px', display: 'flex', flexDirection: 'column', gap: 3 },
  empty: { textAlign: 'center', color: 'rgba(255,255,255,0.2)', marginTop: 80, fontSize: 14 },
  row: { display: 'flex', marginBottom: 2 },
  senderName: { fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.35)', paddingLeft: 12, marginBottom: 3 },
  bubbleMine: { background: '#4f8ef7', borderRadius: '18px 18px 4px 18px', padding: '9px 12px', display: 'flex', alignItems: 'flex-end', gap: 8 },
  bubbleOther: { background: 'rgba(255,255,255,0.09)', borderRadius: '18px 18px 18px 4px', padding: '9px 12px', display: 'flex', alignItems: 'flex-end', gap: 8 },
  msgText: { fontSize: 15, lineHeight: 1.5, color: '#fff', wordBreak: 'break-word' },
  metaCol: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0, paddingBottom: 1 },
  msgTime: { fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' },
  check: { fontSize: 13, color: '#4ade80', fontWeight: 700, lineHeight: 1 },
  pendingBar: { display: 'flex', alignItems: 'center', gap: 10, margin: '0 12px 6px', padding: '10px 14px', background: 'rgba(79,142,247,0.15)', border: '1px solid rgba(79,142,247,0.3)', borderRadius: 12 },
  pendingName: { fontSize: 13, fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  pendingSize: { fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 },
  removePending: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: 16, cursor: 'pointer', padding: '0 2px' },
  fileError: { margin: '0 12px 6px', padding: '8px 14px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, fontSize: 13, color: '#f87171', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  clearErr: { background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 14 },
  inputBar: { display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.25)', flexShrink: 0, alignItems: 'flex-end' },
  attachBtn: { width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', fontSize: 18, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  textarea: { flex: 1, background: 'rgba(255,255,255,0.07)', border: '1.5px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '10px 14px', color: '#fff', fontSize: 15, fontFamily: 'inherit', outline: 'none', resize: 'none', lineHeight: 1.5 },
  sendBtn: { width: 42, height: 42, borderRadius: 12, background: '#4f8ef7', border: 'none', color: '#fff', fontSize: 17, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  hint: { textAlign: 'center', fontSize: 10, color: 'rgba(255,255,255,0.18)', padding: '4px 0 8px', background: 'rgba(0,0,0,0.25)', flexShrink: 0 },
}
