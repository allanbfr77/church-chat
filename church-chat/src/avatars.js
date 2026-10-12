// Avatares pré-cadastrados: todo arquivo de imagem em src/assets/avatars/ entra automaticamente.
const files = import.meta.glob('./assets/avatars/*.{png,jpg,jpeg,webp,gif,svg}', {
  eager: true,
  query: '?url',
  import: 'default',
})

// Ordem de exibição na tela de login (ids = nome do arquivo; não renomeie). Os demais vêm depois, em ordem alfabética.
const ORDER = ['avatar (4).jpg', 'avatar (3).jpg', 'avatar (1).jpg', 'avatar (2).jpg']
const rank = id => { const i = ORDER.indexOf(id); return i === -1 ? ORDER.length : i }

export const AVATARS = Object.entries(files)
  .map(([path, url]) => ({ id: path.split('/').pop(), url }))
  .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id, 'pt-BR', { numeric: true }))

// O id vem de outros usuários (mensagens/presença): só vale se existir no catálogo local
export function avatarUrl(id) {
  return AVATARS.find(a => a.id === id)?.url || null
}

// Opção especial (sem imagem): a pessoa aparece com a inicial do nome. Pode ser usada por várias pessoas.
export const INITIAL_AVATAR = 'initial'
