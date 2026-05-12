// ============================================================
//  PASSO 1: Cole aqui as credenciais do seu projeto Firebase
//  Acesse: https://console.firebase.google.com
//  → Seu projeto → Configurações → Seus apps → SDK
// ============================================================

import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { getStorage } from 'firebase/storage'

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBFEBZIYHApja2wkWqkpVDNEdM7-93IlWs",
  authDomain: "church-chat-dd8ea.firebaseapp.com",
  databaseURL: "https://church-chat-dd8ea-default-rtdb.firebaseio.com",
  projectId: "church-chat-dd8ea",
  storageBucket: "church-chat-dd8ea.firebasestorage.app",
  messagingSenderId: "695515727180",
  appId: "1:695515727180:web:dca5e78b722a7e3649bbe9",
  measurementId: "G-T13HEQTTM6"
};

const app     = initializeApp(firebaseConfig)
export const db      = getDatabase(app)
export const storage = getStorage(app)
