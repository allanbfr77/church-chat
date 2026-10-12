// Avatares pré-cadastrados: todo arquivo de imagem em src/assets/avatars/ entra automaticamente.
const files = import.meta.glob('./assets/avatars/*.{png,jpg,jpeg,webp,gif,svg}', {
  eager: true,
  query: '?url',
  import: 'default',
})

export const AVATARS = Object.entries(files)
  .map(([path, url]) => ({ id: path.split('/').pop(), url }))
  .sort((a, b) => a.id.localeCompare(b.id, 'pt-BR', { numeric: true }))

// O id vem de outros usuários (mensagens/presença): só vale se existir no catálogo local
export function avatarUrl(id) {
  return AVATARS.find(a => a.id === id)?.url || null
}
