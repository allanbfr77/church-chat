# Chat — Guia de Deploy (Firebase + Vercel)

## O que você vai precisar
- Conta Google (para o Firebase)
- Conta GitHub (para subir o código)
- Conta Vercel (gratuita, para hospedar)

---

## PASSO 1 — Criar projeto no Firebase

1. Acesse https://console.firebase.google.com
2. Clique em **"Adicionar projeto"** → dê um nome (ex: `meu-chat`) → Criar
3. No menu lateral, clique em **Build → Realtime Database**
   - Clique em **"Criar banco de dados"**
   - Escolha a região **us-central1** → Próximo
   - Selecione **"Iniciar no modo de teste"** → Ativar
4. No menu lateral, clique em **Build → Storage**
   - Clique em **"Primeiros passos"**
   - Modo de teste → Próximo → Concluir

---

## PASSO 2 — Pegar as credenciais

1. No Firebase, clique na engrenagem ⚙️ → **Configurações do projeto**
2. Role até **"Seus apps"** → Clique em **`</>`** (Web)
3. Dê um nome ao app → **Registrar app**
4. Copie o objeto `firebaseConfig` exibido

---

## PASSO 3 — Colar as credenciais no código

Abra o arquivo **`src/firebase.js`** e substitua os campos:

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

---

## PASSO 4 — Subir no GitHub

1. Crie um repositório novo em https://github.com/new (pode ser privado)
2. Na pasta do projeto, rode:

```bash
git init
git add .
git commit -m "primeiro commit"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git
git push -u origin main
```

---

## PASSO 5 — Deploy no Vercel

1. Acesse https://vercel.com → faça login com o GitHub
2. Clique em **"Add New Project"**
3. Importe o repositório que você criou
4. Mantenha as configurações padrão (Vite é detectado automaticamente)
5. Clique em **Deploy** ✅

Em ~1 minuto seu chat estará no ar com uma URL pública (ex: `https://meu-chat.vercel.app`).

---

## Regras de segurança no Firebase (recomendado)

Após testar, troque as regras do **Realtime Database** e **Storage** para:

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

> O índice em `ts` permite filtrar mensagens do dia atual na query (`orderByChild('ts')`) sem baixar o histórico completo. Sem ele, o app usa fallback com filtro local.

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

> ⚠️ Para produção real, configure autenticação no Firebase para restringir acesso.

---

## Atualizar o app no futuro

Basta fazer `git push` novamente — o Vercel faz o redeploy automático.
