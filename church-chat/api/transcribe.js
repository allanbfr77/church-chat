// Função serverless da Vercel: transcreve uma mensagem de voz com Whisper (Groq).
// Requer a variável de ambiente GROQ_API_KEY.
const DB_URL = 'https://church-chat-dd8ea-default-rtdb.firebaseio.com'
const MAX_BYTES = 4 * 1024 * 1024

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' })
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'missing GROQ_API_KEY' })

  const { messageId, dataUrl } = req.body || {}
  const m = /^data:(audio\/[\w.+-]+);base64,(.+)$/.exec(String(dataUrl || ''))
  if (!m || !/^[\w-]{10,40}$/.test(String(messageId || ''))) return res.status(400).json({ error: 'bad request' })

  // Só transcreve mensagens de voz reais ainda sem transcrição (evita uso indevido da chave)
  try {
    const r = await fetch(`${DB_URL}/messages/${messageId}/file.json`)
    const file = r.ok ? await r.json() : null
    if (!file || !String(file.type || '').startsWith('audio/') || file.transcript) {
      return res.status(403).json({ error: 'not allowed' })
    }
  } catch {
    return res.status(502).json({ error: 'db' })
  }

  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'too large' })

  const ext = m[1].includes('mp4') ? 'm4a' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([buf], { type: m[1] }), `audio.${ext}`)
  form.append('model', 'whisper-large-v3-turbo')
  form.append('language', 'pt')
  form.append('response_format', 'json')

  const ai = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  })
  if (!ai.ok) {
    console.error('whisper', ai.status, await ai.text())
    return res.status(502).json({ error: 'whisper' })
  }
  const { text } = await ai.json()
  return res.status(200).json({ text: text || '' })
}
