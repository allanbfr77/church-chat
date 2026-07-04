# NVB Chat

Chat em tempo real para a **Igreja Nova Vida Botafogo**. Aplicação web progressiva (PWA) com mensagens instantâneas, anexos, notificações e suporte mobile.

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-Realtime%20Database-FFCA28?logo=firebase&logoColor=black)

## Funcionalidades

- **Chat em tempo real** via Firebase Realtime Database
- **Mensagens de texto** com paleta de emojis integrada
- **Anexos** (imagens, PDF, documentos etc.) até 10 MB
- **Indicador de digitação** e lista de usuários online
- **Edição e exclusão** de mensagens (uma edição por mensagem)
- **Notificações push** no navegador (melhor experiência com o app instalado)
- **Reset diário automático** à meia-noite (fuso `America/Sao_Paulo`)
- **Modo admin** para limpar o histórico completo do chat
- **PWA instalável** no Android e iOS (Tela de Início)
- **Visualização ampliada** de imagens com zoom por pinça

## Tecnologias

| Camada        | Stack                          |
|---------------|--------------------------------|
| Frontend      | React 18, Vite                 |
| Backend / DB  | Firebase Realtime Database     |
| Hospedagem    | Vercel                         |
| PWA           | Service Worker + Web Manifest  |

## Estrutura do projeto

```
church-chat/
├── public/
│   ├── manifest.json      # Configuração PWA
│   ├── sw.js              # Service Worker
│   └── images/            # Ícones e assets
├── src/
│   ├── App.jsx            # Componente principal do chat
│   ├── firebase.js        # Credenciais e conexão Firebase
│   └── main.jsx           # Entry point React
├── index.html
├── vite.config.js
└── vercel.json            # Rewrite SPA para deploy
```

## Pré-requisitos

- [Node.js](https://nodejs.org/) 18 ou superior
- Conta no [Firebase](https://console.firebase.google.com)
- Conta no [GitHub](https://github.com) (para deploy)
- Conta na [Vercel](https://vercel.com) (hospedagem gratuita)

## Desenvolvimento local

```bash
cd church-chat
npm install
npm run dev
```

O app estará disponível em `http://localhost:5173`.

Outros scripts:

```bash
npm run build    # Gera build de produção em dist/
npm run preview  # Pré-visualiza o build localmente
```

## Configuração do Firebase

### 1. Criar o projeto

1. Acesse o [Console Firebase](https://console.firebase.google.com)
2. Crie um novo projeto (ex.: `meu-chat`)
3. Em **Build → Realtime Database**, crie o banco na região **us-central1** (modo de teste)
4. Em **Build → Storage**, ative o storage (modo de teste)

### 2. Obter credenciais

1. **Configurações do projeto** → **Seus apps** → ícone **Web** (`</>`)
2. Registre o app e copie o objeto `firebaseConfig`

### 3. Configurar no código

Edite `church-chat/src/firebase.js` e substitua os valores:

```js
const firebaseConfig = {
  apiKey:            "sua-chave-aqui",
  authDomain:        "seu-projeto.firebaseapp.com",
  databaseURL:       "https://seu-projeto-default-rtdb.firebaseio.com",
  projectId:         "seu-projeto",
  storageBucket:     "seu-projeto.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abcdef",
}
```

> **Importante:** não commite credenciais de produção em repositórios públicos. Para projetos open source, use variáveis de ambiente ou um projeto Firebase dedicado ao desenvolvimento.

### 4. Regras de segurança (recomendado)

**Realtime Database → Regras:**

```json
{
  "rules": {
    "messages": {
      ".read": true,
      ".write": true,
      ".indexOn": ["ts"]
    },
    "typing": {
      ".read": true,
      ".write": true
    },
    "system": {
      ".read": true,
      ".write": true
    }
  }
}
```

O índice em `ts` permite filtrar mensagens do dia atual sem baixar todo o histórico.

**Storage → Regras:**

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{allPaths=**} {
      allow read, write: if true;
    }
  }
}
```

> Para uso em produção com dados sensíveis, configure autenticação no Firebase e restrinja leitura/escrita.

## Deploy na Vercel

1. Faça push do código para o GitHub
2. Acesse [vercel.com](https://vercel.com) e conecte o repositório
3. Defina o **Root Directory** como `church-chat` (se o repositório contiver a pasta pai)
4. A Vercel detecta o Vite automaticamente — clique em **Deploy**

Cada `git push` na branch principal dispara um novo deploy automaticamente.

## Instalar como app (PWA)

### Android (Chrome)

Menu **⋮** → **Instalar app** ou **Adicionar à tela inicial**. Depois, ative as notificações dentro do chat.

### iOS (Safari)

**Compartilhar** (↑) → **Adicionar à Tela de Início**. Abra pelo ícone instalado e permita notificações.

> No iOS, as notificações web em segundo plano têm limitações impostas pela Apple. A experiência é melhor com o atalho na Tela de Início.

## Modo administrador

Na tela de login, toque em **Acesso admin** e informe o código configurado no app. Administradores podem:

- Limpar todo o histórico de mensagens
- Testar notificações push

## Licença

Projeto privado — Igreja Nova Vida Botafogo.
