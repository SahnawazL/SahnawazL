// lib/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCKINcYZ9RVKyK6rfkozVQXjoMVbH5G6zU",
  authDomain: "studylens-ca3c5.firebaseapp.com",
  projectId: "studylens-ca3c5",
  storageBucket: "studylens-ca3c5.firebasestorage.app",
  messagingSenderId: "1034041024580",
  appId: "1:1034041024580:web:e6fd8c0c4039bacb5e5c11",
  measurementId: "G-FE00LWKQNL"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
