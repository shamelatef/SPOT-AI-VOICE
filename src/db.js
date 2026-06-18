import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, getDocs } from 'firebase/firestore';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const CLOUDINARY_CLOUD  = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

export const hasDB      = !!(firebaseConfig.apiKey && firebaseConfig.projectId);
export const hasStorage = !!(CLOUDINARY_CLOUD && CLOUDINARY_PRESET);

const app = hasDB ? initializeApp(firebaseConfig) : null;
const db  = hasDB ? getFirestore(app) : null;

// ── Game state ────────────────────────────────────────────────────────────────
export async function upsertGameState(session, data) {
  if (!hasDB) return;
  await setDoc(doc(db, 'game_state', session), data, { merge: true });
}

export async function getGameState(session) {
  if (!hasDB) return null;
  const snap = await getDoc(doc(db, 'game_state', session));
  return snap.exists() ? snap.data() : null;
}

export async function patchGameState(session, patch) {
  if (!hasDB) return;
  await updateDoc(doc(db, 'game_state', session), patch);
}

// ── Players ───────────────────────────────────────────────────────────────────
export async function joinGame(session, name) {
  if (!hasDB) return;
  await setDoc(doc(db, 'game_state', session, 'players', name), { name, session }, { merge: true });
}

export async function getPlayers(session) {
  if (!hasDB) return [];
  const snap = await getDocs(collection(db, 'game_state', session, 'players'));
  return snap.docs.map(d => d.data()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Answers ───────────────────────────────────────────────────────────────────
export async function submitAnswer(session, round, name, choice, elapsed) {
  if (!hasDB) return;
  const id = `${round}_${name}`;
  await setDoc(
    doc(db, 'game_state', session, 'answers', id),
    { session, round, name, choice, elapsed },
    { merge: true },
  );
}

export async function getAnswers(session) {
  if (!hasDB) return [];
  const snap = await getDocs(collection(db, 'game_state', session, 'answers'));
  return snap.docs.map(d => d.data());
}

// ── Storage (Cloudinary unsigned upload — no credit card required) ────────────
export async function uploadAudio(file) {
  if (!hasStorage) return null;
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('upload_preset', CLOUDINARY_PRESET);
    form.append('resource_type', 'video'); // Cloudinary uses 'video' for audio files
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/video/upload`,
      { method: 'POST', body: form },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.secure_url ?? null;
  } catch { return null; }
}
