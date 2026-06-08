const BASE = import.meta.env.VITE_SUPABASE_URL ?? '';
const KEY  = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
export const hasDB = !!(BASE && KEY);

async function api(path, opts = {}) {
  if (!hasDB) return null;
  try {
    const r = await fetch(`${BASE}/rest/v1/${path}`, {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        ...opts.extraHeaders,
      },
      ...opts,
    });
    if (r.status === 204 || r.status === 201) return null;
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// ── Game state ────────────────────────────────────────────────────────────────
export async function upsertGameState(session, data) {
  return api('game_state', {
    method: 'POST',
    extraHeaders: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ session, ...data }),
  });
}
export async function getGameState(session) {
  const d = await api(`game_state?session=eq.${session}&select=*`);
  return Array.isArray(d) ? (d[0] ?? null) : null;
}
export async function patchGameState(session, patch) {
  return api(`game_state?session=eq.${session}`, {
    method: 'PATCH',
    extraHeaders: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// ── Players ───────────────────────────────────────────────────────────────────
export async function joinGame(session, name) {
  return api('players', {
    method: 'POST',
    extraHeaders: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ session, name }),
  });
}
export async function getPlayers(session) {
  const d = await api(`players?session=eq.${session}&select=name&order=name.asc`);
  return d ?? [];
}

// ── Storage ───────────────────────────────────────────────────────────────────
export async function uploadAudio(file, path) {
  if (!hasDB) return null;
  try {
    const r = await fetch(`${BASE}/storage/v1/object/game-audio/${path}`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': file.type, 'x-upsert': 'true' },
      body: file,
    });
    if (!r.ok) return null;
    return `${BASE}/storage/v1/object/public/game-audio/${path}`;
  } catch { return null; }
}

// ── Answers ───────────────────────────────────────────────────────────────────
export async function submitAnswer(session, round, name, choice, elapsed) {
  return api('answers', {
    method: 'POST',
    extraHeaders: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ session, round, name, choice, elapsed }),
  });
}
export async function getAnswers(session) {
  const d = await api(`answers?session=eq.${session}&select=round,name,choice,elapsed`);
  return d ?? [];
}
