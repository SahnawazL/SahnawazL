// lib/db.js
import { db } from "./firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  getDocs,
  deleteDoc,
  orderBy,
  query,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── HISTORY ──────────────────────────────────────────────────────────────────

// Load all history for a user (newest last, max 120)
export async function loadHistoryFromFirestore(uid) {
  try {
    const q = query(
      collection(db, "users", uid, "history"),
      orderBy("ts", "asc"),
      limit(120)
    );
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(d => items.push({ firestoreId: d.id, ...d.data() }));
    return items;
  } catch (e) {
    console.warn("[DB] loadHistory failed:", e);
    return [];
  }
}

// Save one history entry to Firestore
export async function saveHistoryEntryToFirestore(uid, entry) {
  try {
    // Remove firestoreId if present (don't store it inside the doc)
    const { firestoreId, ...data } = entry;
    await addDoc(collection(db, "users", uid, "history"), {
      ...data,
      ts: data.ts || Date.now(),
    });
  } catch (e) {
    console.warn("[DB] saveHistory failed:", e);
  }
}

// Delete all history for a user
export async function clearHistoryFromFirestore(uid) {
  try {
    const snap = await getDocs(collection(db, "users", uid, "history"));
    const deletes = [];
    snap.forEach(d => deletes.push(deleteDoc(d.ref)));
    await Promise.all(deletes);
  } catch (e) {
    console.warn("[DB] clearHistory failed:", e);
  }
}

// ── PROFILES ─────────────────────────────────────────────────────────────────

// Load family profiles for a user
export async function loadProfilesFromFirestore(uid) {
  try {
    const ref = doc(db, "users", uid, "data", "profiles");
    const snap = await getDoc(ref);
    if (snap.exists()) return snap.data().profiles || [];
    return [];
  } catch (e) {
    console.warn("[DB] loadProfiles failed:", e);
    return [];
  }
}

// Save family profiles for a user (overwrites entire array)
export async function saveProfilesToFirestore(uid, profiles) {
  try {
    const ref = doc(db, "users", uid, "data", "profiles");
    await setDoc(ref, { profiles });
  } catch (e) {
    console.warn("[DB] saveProfiles failed:", e);
  }
}
