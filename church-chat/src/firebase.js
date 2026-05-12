import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

const firebaseConfig = {
  apiKey: "AIzaSyBFEBZIYHApja2wkWqkpVDNEdM7-93IlWs",
  authDomain: "church-chat-dd8ea.firebaseapp.com",
  databaseURL: "https://church-chat-dd8ea-default-rtdb.firebaseio.com",
  projectId: "church-chat-dd8ea",
  storageBucket: "church-chat-dd8ea.appspot.com",
  messagingSenderId: "695515727180",
  appId: "1:695515727180:web:dca5e78b722a7e3649bbe9"
}

const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)