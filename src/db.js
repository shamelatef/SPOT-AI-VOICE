import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, getDocs } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

export const hasDB = !!(firebaseConfig.apiKey && firebaseConfig.projectId);

const app  = hasDB ? initializeApp(firebaseConfig) : null;
const db   = hasDB ? getFirestore(app) : null;
const stor = hasDB ? getStorage(app) : null;

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
  // setDoc with merge = ignore-duplicate behaviour
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
  // doc id = round_name ensures one answer per player per round
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

// ── Storage ───────────────────────────────────────────────────────────────────
export async function uploadAudio(file, path) {
  if (!hasDB) return null;
  try {
    const storageRef = ref(stor, `game-audio/${path}`);
    await uploadBytes(storageRef, file);
    return await getDownloadURL(storageRef);
  } catch { return null; }
}
