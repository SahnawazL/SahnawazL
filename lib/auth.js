// lib/auth.js
import { auth, provider } from "./firebase.js";
import {
  signInWithRedirect,
  signInWithPopup,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Use redirect on mobile (more reliable), popup on desktop
function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function signInWithGoogle() {
  if (isMobile()) {
    // Redirect method — page redirects to Google then comes back
    return signInWithRedirect(auth, provider);
  } else {
    // Popup method — works fine on desktop
    return signInWithPopup(auth, provider);
  }
}

// Call this on page load to handle the redirect result coming back
export async function handleRedirectResult() {
  try {
    const result = await getRedirectResult(auth);
    return result;
  } catch (e) {
    console.error('[Auth] Redirect result error:', e);
    return null;
  }
}

export function signOutUser() {
  return signOut(auth);
}

export function onUserChanged(callback) {
  return onAuthStateChanged(auth, callback);
}
