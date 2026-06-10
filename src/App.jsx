import { useState, useEffect, useRef } from "react";
import {
  hasDB, upsertGameState, getGameState, patchGameState,
  joinGame, getPlayers, submitAnswer, getAnswers, uploadAudio,
} from "./db.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genId() { return Math.random().toString(36).slice(2, 10); }
function encodeConfig(cfg) { try { return btoa(JSON.stringify(cfg)); } catch { return ''; } }
function decodeConfig(s) { try { return JSON.parse(atob(s)); } catch { return null; } }

function calcLeaderboard(allAnswers, rounds, upToRound, allPlayers = []) {
  const map = {};
  // Seed every registered player so no-shows / non-answerers still appear (with 0 pts)
  allPlayers.forEach(p => { map[p.name] = { score: 0, correct: 0 }; });
  for (let r = 0; r <= upToRound && r < rounds.length; r++) {
    const correctIdx = rounds[r].ai;
    allAnswers.filter(a => a.round === r).forEach(a => {
      if (!map[a.name]) map[a.name] = { score: 0, correct: 0 };
      if (a.choice === correctIdx) {
        map[a.name].score += Math.max(100, Math.round(1000 - a.elapsed * 40));
        map[a.name].correct += 1;
      }
    });
  }
  return Object.entries(map)
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => b.score - a.score);
}

function calcMyScore(myAnswers, rounds) {
  let score = 0, correct = 0;
  Object.entries(myAnswers).forEach(([r, { choice, elapsed }]) => {
    if (+r < rounds.length && choice === rounds[+r].ai) {
      score += Math.max(100, Math.round(1000 - elapsed * 40));
      correct++;
    }
  });
  return { score, correct };
}

// choice/ai: 0 = Real voice, 1 = AI-generated voice
// audio: direct URL or YouTube URL  |  ytStart/ytEnd: crop in seconds (YouTube only)
// audioDuration: auto-detected from <audio> metadata (direct files only)
const DEFAULT_ROUNDS = Array.from({ length: 10 }, (_, i) => ({
  label: `Round ${i + 1}`,
  audio: '',
  ytStart: 0,
  ytEnd: '',
  audioDuration: null,
  ai: 0,
}));

// Returns the effective timer duration for a round (seconds)
function getRoundDuration(rd, fallback = 20) {
  if (rd?.ytEnd !== '' && rd?.ytEnd != null && rd?.ytStart !== undefined) {
    return Math.max(3, Number(rd.ytEnd) - Number(rd.ytStart || 0));
  }
  if (rd?.audioDuration) return Math.ceil(rd.audioDuration);
  return fallback;
}

// ─── YouTube helpers ──────────────────────────────────────────────────────────
function parseYouTube(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([^&\s#]+)/,
    /youtu\.be\/([^?&\s#]+)/,
    /youtube\.com\/shorts\/([^?&\s#]+)/,
    /youtube\.com\/embed\/([^?&\s#]+)/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

// Full video embed — used only in host setup crop preview
function YTPlayer({ videoId, ytStart = 0, ytEnd = '', height = 200 }) {
  const p = new URLSearchParams({ start: ytStart || 0, rel: 0, modestbranding: 1 });
  if (ytEnd !== '' && ytEnd !== null) p.set('end', ytEnd);
  const src = `https://www.youtube-nocookie.com/embed/${videoId}?${p}`;
  return (
    <iframe key={src} width="100%" height={height} src={src}
      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen style={{ border: 'none', borderRadius: 8, display: 'block' }} />
  );
}

// Audio-only: CSS-clips the iframe so only the 40 px control bar is visible.
// The video frame sits above the container boundary and is never seen.
function YTAudioPlayer({ videoId, ytStart = 0, ytEnd = '', replayKey = 0 }) {
  const p = new URLSearchParams({ start: ytStart || 0, rel: 0, modestbranding: 1, autoplay: 1 });
  if (ytEnd !== '' && ytEnd !== null) p.set('end', ytEnd);
  const src = `https://www.youtube-nocookie.com/embed/${videoId}?${p}`;
  return (
    <div style={{
      position: 'relative', width: '100%', height: 42,
      overflow: 'hidden', borderRadius: 8, background: '#000',
      boxShadow: '0 0 0 1px rgba(255,255,255,0.06)',
    }}>
      <iframe key={`${src}-${replayKey}`} src={src} width="100%" height="240"
        style={{ position: 'absolute', bottom: 0, left: 0, border: 'none', width: '100%' }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen />
    </div>
  );
}

// AudioPlayer: preview=true → full video embed (host setup only)
//              preview=false (default) → audio-only bar, autoplays on mount
function AudioPlayer({ rd, preview = false, height = 200, replayKey = 0 }) {
  const ytId = parseYouTube(rd?.audio);
  if (!rd?.audio) return (
    <div style={{ textAlign: 'center', color: '#444', fontSize: 13, padding: 24 }}>No audio set</div>
  );
  if (ytId) {
    if (preview) return <YTPlayer videoId={ytId} ytStart={rd.ytStart ?? 0} ytEnd={rd.ytEnd ?? ''} height={height} />;
    return <YTAudioPlayer videoId={ytId} ytStart={rd.ytStart ?? 0} ytEnd={rd.ytEnd ?? ''} replayKey={replayKey} />;
  }
  return <audio key={`${rd.audio}-${replayKey}`} src={rd.audio} controls autoPlay style={{ width: '100%' }} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const pg = {
  minHeight: '100vh', background: '#0a0a0f', display: 'flex',
  alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
  padding: '24px 16px', fontFamily: "'Segoe UI', system-ui, sans-serif",
  color: '#e0e0e0', boxSizing: 'border-box',
};
function btn(bg, fg, sm) {
  return {
    background: bg, color: fg, border: 'none', borderRadius: 10,
    cursor: 'pointer', fontWeight: 700, fontFamily: 'monospace', letterSpacing: 1,
    padding: sm ? '9px 20px' : '13px 32px', fontSize: sm ? 13 : 15, transition: 'opacity .15s',
  };
}
const inp = {
  width: '100%', padding: '9px 11px', background: '#111120', border: '1.5px solid #2a2a3e',
  borderRadius: 8, color: '#fff', fontSize: 13, outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box',
};
const card = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px' };

// ─── Shared Components ────────────────────────────────────────────────────────
function TimerRing({ seconds, total }) {
  const r = 36, circ = 2 * Math.PI * r;
  const frac = Math.max(0, seconds / total);
  const color = frac > 0.5 ? '#f0e040' : frac > 0.25 ? '#ff9800' : '#ff3d3d';
  return (
    <svg width="88" height="88" style={{ filter: `drop-shadow(0 0 8px ${color})` }}>
      <circle cx="44" cy="44" r={r} fill="none" stroke="#1a1a2e" strokeWidth="6" />
      <circle cx="44" cy="44" r={r} fill="none" stroke={color} strokeWidth="6"
        strokeDasharray={circ} strokeDashoffset={circ * (1 - frac)} strokeLinecap="round"
        transform="rotate(-90 44 44)" style={{ transition: 'stroke-dashoffset 0.9s linear, stroke 0.3s' }} />
      <text x="44" y="50" textAnchor="middle" fill={color}
        style={{ fontSize: 22, fontFamily: 'monospace', fontWeight: 700 }}>{seconds}</text>
    </svg>
  );
}

function QRCode({ url, size = 180 }) {
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}&bgcolor=0a0a0f&color=f0e040&margin=2`;
  return <img src={src} width={size} height={size} alt="QR" style={{ borderRadius: 8, display: 'block' }} />;
}

function LeaderRow({ rank, name, score, correct, total, highlight }) {
  const icon = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : `#${rank + 1}`;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
      borderRadius: 10, marginBottom: 6,
      background: highlight ? 'rgba(240,224,64,0.1)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${highlight ? 'rgba(240,224,64,0.3)' : 'rgba(255,255,255,0.06)'}`,
    }}>
      <span style={{ fontSize: 18, minWidth: 28, textAlign: 'center' }}>{icon}</span>
      <span style={{ flex: 1, color: highlight ? '#f0e040' : '#ddd', fontFamily: 'monospace', fontWeight: highlight ? 700 : 400, fontSize: 14 }}>{name}</span>
      <span style={{ color: '#555', fontSize: 12 }}>{correct}/{total}✓</span>
      <span style={{ color: '#f0e040', fontWeight: 700, fontFamily: 'monospace', fontSize: 16, minWidth: 55, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

// ─── Landing ──────────────────────────────────────────────────────────────────
function Landing() {
  const base = window.location.href.split('?')[0];
  return (
    <div style={pg}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 56, marginBottom: 6 }}>🎙️</div>
        <div style={{ fontSize: 38, fontWeight: 900, color: '#f0e040', fontFamily: 'monospace', letterSpacing: -2, lineHeight: 1.1 }}>
          AI OR<br /><span style={{ color: '#fff' }}>REAL VOICE</span>
        </div>
        <div style={{ color: '#555', margin: '10px 0 32px', fontSize: 14 }}>
          10 rounds · listen to the voice · guess AI or Real · score points for speed
        </div>
        <a href={`${base}?mode=host`}
          style={{ ...btn('#f0e040', '#0a0a0f'), textDecoration: 'none', display: 'block', padding: '16px 0', textAlign: 'center', fontSize: 17 }}>
          📺 I'm the Host
        </a>
        <div style={{ color: '#333', fontSize: 12, marginTop: 16 }}>Players join by scanning the QR on the host screen</div>
      </div>
    </div>
  );
}

// ─── HOST FLOW ────────────────────────────────────────────────────────────────
function HostFlow() {
  const [hostPhase, setHostPhase] = useState('setup');
  const [rounds, setRounds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('aig-rounds')) || DEFAULT_ROUNDS; } catch { return DEFAULT_ROUNDS; }
  });
  const [duration] = useState(20);                     // fallback when audio has no metadata
  const [roundDuration, setRoundDuration] = useState(20);
  const [timerDone, setTimerDone] = useState(false);   // true after audio finishes playing
  const [replayUsed, setReplayUsed] = useState(false); // true after host pressed Replay once
  const [session] = useState(genId);
  const [playerUrl, setPlayerUrl] = useState('');
  const [players, setPlayers] = useState([]);
  const [answers, setAnswers] = useState([]);
  const [round, setRound] = useState(0);
  const [timer, setTimer] = useState(0);
  const [roundStart, setRoundStart] = useState(null);
  const timerRef = useRef(null);

  // Poll players + answers while game is running
  useEffect(() => {
    if (hostPhase === 'lobby' || hostPhase === 'question' || hostPhase === 'reveal') {
      const poll = async () => {
        const [ps, as] = await Promise.all([getPlayers(session), getAnswers(session)]);
        setPlayers(ps);
        setAnswers(as);
      };
      poll();
      const id = setInterval(poll, 2000);
      return () => clearInterval(id);
    }
  }, [hostPhase, session]);

  // Countdown timer — stops at 0, never auto-reveals; host controls what happens next
  useEffect(() => {
    clearInterval(timerRef.current);
    if (hostPhase === 'question' && roundStart) {
      const tick = () => {
        const elapsed = (Date.now() - roundStart) / 1000;
        const left = Math.max(0, Math.ceil(roundDuration - elapsed));
        setTimer(left);
        if (left <= 0) {
          clearInterval(timerRef.current);
          setTimerDone(true);
        }
      };
      tick();
      timerRef.current = setInterval(tick, 500);
      return () => clearInterval(timerRef.current);
    }
  }, [hostPhase, roundStart, roundDuration]);

  const doGenerate = () => {
    const cfg = { session, duration, rounds };
    const base = window.location.href.split('?')[0];
    // Short URL — config lives in Supabase, players fetch it by session ID
    const url = `${base}?s=${session}`;
    setPlayerUrl(url);
    upsertGameState(session, { phase: 'lobby', round: 0, round_start: null, config: cfg });
    setHostPhase('lobby');
  };

  const doStart = async () => {
    const now = Date.now();
    const rd0dur = getRoundDuration(rounds[0], duration);
    setRound(0); setRoundStart(now); setTimer(rd0dur); setRoundDuration(rd0dur);
    setTimerDone(false); setReplayUsed(false);
    setHostPhase('question');
    await patchGameState(session, { phase: 'question', round: 0, round_start: now });
  };

  const doReplay = () => {
    const now = Date.now();
    setReplayUsed(true);
    setTimerDone(false);
    setRoundStart(now);
    setTimer(roundDuration);
  };

  const doReveal = async () => {
    clearInterval(timerRef.current);
    setHostPhase('reveal');
    await patchGameState(session, { phase: 'reveal' });
    const as = await getAnswers(session);
    setAnswers(as);
  };

  const doNext = async () => {
    if (round + 1 >= rounds.length) {
      setHostPhase('final');
      await patchGameState(session, { phase: 'final' });
    } else {
      const next = round + 1;
      const now = Date.now();
      const nextDur = getRoundDuration(rounds[next], duration);
      setRound(next); setRoundStart(now); setTimer(nextDur); setRoundDuration(nextDur);
      setTimerDone(false); setReplayUsed(false);
      setHostPhase('question');
      await patchGameState(session, { phase: 'question', round: next, round_start: now });
    }
  };

  const doReset = () => {
    setRound(0); setRoundStart(null); setAnswers([]); setPlayers([]);
    setHostPhase('setup');
  };

  const leaderboard = calcLeaderboard(answers, rounds, round, players);
  const roundAnswers = answers.filter(a => a.round === round);

  if (hostPhase === 'setup') return (
    <HostSetup rounds={rounds} setRounds={setRounds} duration={duration} onGenerate={doGenerate} session={session} />
  );

  if (hostPhase === 'lobby') return (
    <HostLobby playerUrl={playerUrl} players={players} onStart={doStart} onBack={() => setHostPhase('setup')} />
  );

  if (hostPhase === 'question') return (
    <HostQuestion round={round} rounds={rounds} timer={timer} duration={roundDuration}
      roundStart={roundStart} timerDone={timerDone} replayUsed={replayUsed}
      answeredCount={roundAnswers.length} playerCount={players.length}
      leaderboard={leaderboard} onReplay={doReplay} onReveal={doReveal} />
  );

  if (hostPhase === 'reveal') {
    const correctIdx = rounds[round].ai;
    const correctCount = roundAnswers.filter(a => a.choice === correctIdx).length;
    return (
      <HostReveal round={round} rounds={rounds} correctIdx={correctIdx}
        correctCount={correctCount} totalAnswered={roundAnswers.length}
        leaderboard={leaderboard} onNext={doNext} />
    );
  }

  if (hostPhase === 'final') return (
    <HostFinal leaderboard={leaderboard} totalRounds={rounds.length} onReset={doReset} />
  );

  return null;
}

// ─── Host: Setup ──────────────────────────────────────────────────────────────
function AudioSlot({ rd, onChangeField, roundIdx, session }) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const ytId = parseYouTube(rd.audio);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const path = `${session}/${roundIdx}-${Date.now()}.${file.name.split('.').pop()}`;
    const publicUrl = await uploadAudio(file, path);
    setUploading(false);
    if (publicUrl) onChangeField('audio', publicUrl);
    else alert('Upload failed — check that the "game-audio" bucket exists and is public in Supabase.');
  };

  return (
    <div>
      <div style={{ color: '#555', fontSize: 10, marginBottom: 4, fontFamily: 'monospace', letterSpacing: 1 }}>
        VOICE CLIP — YouTube URL · direct audio URL · or upload
      </div>

      {/* URL row */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input value={rd.audio} onChange={e => onChangeField('audio', e.target.value)}
          placeholder="https://youtube.com/watch?v=… or https://… audio file" style={{ ...inp, flex: 1 }} />
        {hasDB && (
          <>
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              style={{ ...btn('#1a1a2e', uploading ? '#555' : '#f0e040', true), border: '1.5px solid #2a2a3e', whiteSpace: 'nowrap', padding: '8px 14px' }}>
              {uploading ? '⏳' : '📁 Upload'}
            </button>
            <input ref={fileRef} type="file" accept="audio/*" onChange={handleFile} style={{ display: 'none' }} />
          </>
        )}
      </div>

      {/* YouTube embed + crop controls */}
      {ytId && (
        <div style={{ ...card, background: '#0d0d18', marginBottom: 0 }}>
          <AudioPlayer rd={rd} preview={true} height={190} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ color: '#f0e040', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>✂️ CROP PREVIEW</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#888', fontSize: 11 }}>Start (sec)</span>
              <input type="number" min={0} step={1}
                key={`s-${rd.ytStart}`}
                defaultValue={rd.ytStart ?? 0}
                onBlur={e => onChangeField('ytStart', Math.max(0, +e.target.value || 0))}
                onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                style={{ ...inp, width: 72, textAlign: 'center' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#888', fontSize: 11 }}>End (sec)</span>
              <input type="number" min={0} step={1}
                key={`e-${rd.ytEnd}`}
                defaultValue={rd.ytEnd ?? ''}
                placeholder="end"
                onBlur={e => onChangeField('ytEnd', e.target.value === '' ? '' : Math.max(0, +e.target.value))}
                onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                style={{ ...inp, width: 72, textAlign: 'center' }} />
            </div>
            <span style={{ color: '#444', fontSize: 10 }}>Tab out / Enter to refresh embed</span>
          </div>
        </div>
      )}

      {/* Direct audio file preview — also captures duration via onLoadedMetadata */}
      {!ytId && rd.audio && (
        <audio src={rd.audio} controls style={{ width: '100%', display: 'block' }}
          onLoadedMetadata={e => {
            const dur = e.target.duration;
            if (!isNaN(dur) && isFinite(dur)) onChangeField('audioDuration', dur);
          }} />
      )}
    </div>
  );
}

function HostSetup({ rounds, setRounds, duration, onGenerate, session }) {
  // Persist rounds (including correct answers) on every change
  useEffect(() => {
    localStorage.setItem('aig-rounds', JSON.stringify(rounds));
  }, [rounds]);

  const setField = (i, field, val) =>
    setRounds(r => r.map((rd, idx) => idx === i ? { ...rd, [field]: val } : rd));

  const importRef = useRef(null);

  const setRoundCount = (n) => {
    const count = Math.max(1, Math.min(20, n));
    setRounds(r => {
      if (count > r.length)
        return [...r, ...Array.from({ length: count - r.length }, (_, i) => ({ label: `Round ${r.length + i + 1}`, audio: '', ytStart: 0, ytEnd: '', audioDuration: null, ai: 0 }))];
      return r.slice(0, count);
    });
  };

  const handleExport = () => {
    const data = JSON.stringify({ duration, rounds }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'ai-or-real-voice-game.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.rounds) { setRounds(data.rounds); }
        else alert('Invalid file — no rounds found.');
      } catch { alert('Could not read file. Make sure it is a valid game export.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div style={{ ...pg, alignItems: 'stretch', justifyContent: 'flex-start' }}>
      <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', paddingTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#f0e040', fontFamily: 'monospace', marginBottom: 4 }}>⚙️ HOST SETUP</div>
            <div style={{ color: '#555', fontSize: 12 }}>Paste audio URLs or upload clips · mark whether each voice is real or AI · click Generate</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleExport}
              style={{ ...btn('#1a1a2e', '#f0e040', true), border: '1.5px solid #2a2a3e' }}>
              ⬇ Export
            </button>
            <button onClick={() => importRef.current?.click()}
              style={{ ...btn('#1a1a2e', '#f0e040', true), border: '1.5px solid #2a2a3e' }}>
              ⬆ Import
            </button>
            <input ref={importRef} type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />
          </div>
        </div>

        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <label style={{ color: '#888', fontSize: 13, whiteSpace: 'nowrap' }}>Number of rounds</label>
          <button onClick={() => setRoundCount(rounds.length - 1)}
            style={{ ...btn('#1a1a2e', '#f0e040', true), border: '1.5px solid #2a2a3e', padding: '6px 14px', fontSize: 18 }}>−</button>
          <span style={{ color: '#f0e040', fontWeight: 700, fontFamily: 'monospace', fontSize: 18, minWidth: 28, textAlign: 'center' }}>{rounds.length}</span>
          <button onClick={() => setRoundCount(rounds.length + 1)}
            style={{ ...btn('#1a1a2e', '#f0e040', true), border: '1.5px solid #2a2a3e', padding: '6px 14px', fontSize: 18 }}>+</button>
          <span style={{ color: '#444', fontSize: 11, marginLeft: 8 }}>Timer = audio duration per round</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {rounds.map((rd, i) => (
            <div key={i} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ color: '#f0e040', fontFamily: 'monospace', fontWeight: 700, fontSize: 13, minWidth: 22 }}>{i + 1}</span>
                <input value={rd.label} onChange={e => setField(i, 'label', e.target.value)}
                  placeholder={`Round ${i + 1} label…`} style={{ ...inp, flex: 1 }} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <AudioSlot rd={rd} onChangeField={(field, val) => setField(i, field, val)} roundIdx={i} session={session} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: '#555', fontSize: 12 }}>This voice is:</span>
                {[{ lbl: '🧑 Real', idx: 0 }, { lbl: '🤖 AI', idx: 1 }].map(({ lbl, idx }) => (
                  <button key={idx} onClick={() => setField(i, 'ai', idx)} style={{
                    ...btn(rd.ai === idx ? '#f0e040' : 'transparent', rd.ai === idx ? '#0a0a0f' : '#666', true),
                    border: `1.5px solid ${rd.ai === idx ? '#f0e040' : '#2a2a3e'}`, padding: '6px 18px',
                  }}>{lbl}</button>
                ))}
                {rd.audio && (
                  <span style={{ marginLeft: 'auto', color: '#f0e040', fontFamily: 'monospace', fontSize: 12, background: 'rgba(240,224,64,0.08)', border: '1px solid rgba(240,224,64,0.2)', borderRadius: 6, padding: '4px 10px' }}>
                    ⏱ {getRoundDuration(rd, duration)}s
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <button onClick={onGenerate} style={{ ...btn('#f0e040', '#0a0a0f'), width: '100%', fontSize: 16, marginBottom: 32 }}>
          ✅ Generate QR & Go to Lobby →
        </button>
      </div>
    </div>
  );
}

// ─── Host: Lobby ──────────────────────────────────────────────────────────────
function HostLobby({ playerUrl, players, onStart, onBack }) {
  return (
    <div style={pg}>
      <div style={{ width: '100%', maxWidth: 700, display: 'grid', gridTemplateColumns: '240px 1fr', gap: 40, alignItems: 'start' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#f0e040', fontFamily: 'monospace', fontWeight: 700, fontSize: 11, marginBottom: 10, letterSpacing: 1 }}>📱 PLAYERS SCAN TO JOIN</div>
          <div style={{ background: '#0e0e1a', border: '2px solid #f0e040', borderRadius: 14, padding: 14, marginBottom: 8, display: 'inline-block' }}>
            <QRCode url={playerUrl} size={190} />
          </div>
        </div>
        <div>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#f0e040', fontFamily: 'monospace', marginBottom: 4 }}>LOBBY</div>
          <div style={{ color: '#555', fontSize: 13, marginBottom: 18 }}>
            {players.length === 0 ? 'Waiting for players to scan the QR…' : `${players.length} player${players.length !== 1 ? 's' : ''} joined`}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 28, minHeight: 44 }}>
            {players.map(p => (
              <div key={p.name} style={{ background: 'rgba(240,224,64,0.1)', border: '1px solid rgba(240,224,64,0.25)', borderRadius: 8, padding: '6px 14px', color: '#f0e040', fontFamily: 'monospace', fontSize: 14 }}>
                {p.name}
              </div>
            ))}
          </div>
          <button onClick={onStart} disabled={players.length === 0}
            style={{ ...btn('#f0e040', '#0a0a0f'), fontSize: 18, padding: '16px 44px', opacity: players.length === 0 ? 0.35 : 1 }}>
            ▶ START GAME
          </button>
          <div style={{ marginTop: 14 }}>
            <button onClick={onBack} style={{ ...btn('transparent', '#444', true), border: '1px solid #2a2a3e' }}>← Edit Setup</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Host: Question ───────────────────────────────────────────────────────────
function HostQuestion({ round, rounds, timer, duration, roundStart, timerDone, replayUsed, answeredCount, playerCount, leaderboard, onReplay, onReveal }) {
  const rd = rounds[round];
  // playing = audio running | done1 = first play finished | playing2 = replay running | done2 = replay finished
  const state = !timerDone ? (replayUsed ? 'playing2' : 'playing') : (replayUsed ? 'done2' : 'done1');

  return (
    <div style={{ ...pg, justifyContent: 'flex-start', paddingTop: 20 }}>
      <div style={{ width: '100%', maxWidth: 960 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ color: '#555', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>Round {round + 1} / {rounds.length}</div>
            <div style={{ color: '#f0e040', fontSize: 22, fontWeight: 900, fontFamily: 'monospace' }}>{rd.label}</div>
            <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>Is this voice AI or Real?</div>
          </div>
          <TimerRing seconds={timer} total={duration} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: '#555', fontSize: 11 }}>Answered</div>
            <div style={{ color: '#f0e040', fontSize: 34, fontWeight: 900, fontFamily: 'monospace' }}>{answeredCount}</div>
            <div style={{ color: '#444', fontSize: 11 }}>of {playerCount}</div>
          </div>
        </div>

        {/* Audio player — visible while playing, hidden when timer is done */}
        <div style={{ borderRadius: 12, overflow: 'hidden', border: '2px solid #1e1e30', padding: 20, marginBottom: 10, background: '#11111c', minHeight: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {(state === 'playing' || state === 'playing2')
            ? <AudioPlayer rd={rd} replayKey={roundStart} />
            : <div style={{ color: '#555', fontFamily: 'monospace', fontSize: 14 }}>
                {state === 'done1' ? '⏰ Audio finished — replay or reveal?' : '⏰ Audio finished — reveal when ready'}
              </div>
          }
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 18 }}>
          {/* Replay: only available once, only when first play is done */}
          {state === 'done1' && (
            <button onClick={onReplay} style={{ ...btn('#1a1a2e', '#f0e040', true), border: '1.5px solid #f0e040' }}>
              🔁 Replay (once)
            </button>
          )}
          {/* Reveal: always available but only prominent when audio is done */}
          <button onClick={onReveal}
            style={state === 'playing' ? btn('#1a1a2e', '#555', true) : btn('#ff6b6b', '#fff', true)}>
            ⏭ Reveal Now
          </button>
        </div>

        {leaderboard.length > 0 && (
          <div>
            <div style={{ color: '#333', fontSize: 11, marginBottom: 6, letterSpacing: 1 }}>STANDINGS SO FAR</div>
            {leaderboard.slice(0, 5).map((p, i) => (
              <LeaderRow key={p.name} rank={i} name={p.name} score={p.score} correct={p.correct} total={round} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Host: Reveal ─────────────────────────────────────────────────────────────
function HostReveal({ round, rounds, correctIdx, correctCount, totalAnswered, leaderboard, onNext }) {
  const rd = rounds[round];
  const isLast = round + 1 >= rounds.length;
  return (
    <div style={{ ...pg, justifyContent: 'flex-start', paddingTop: 20 }}>
      <div style={{ width: '100%', maxWidth: 960 }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ color: '#555', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>Reveal — {rd.label}</div>
          <div style={{ color: '#f0e040', fontSize: 24, fontWeight: 900, fontFamily: 'monospace' }}>
            {correctCount} / {totalAnswered} got it right!
          </div>
        </div>

        <div style={{ borderRadius: 12, overflow: 'hidden', border: '3px solid #f0e040', boxShadow: '0 0 30px rgba(240,224,64,0.2)', position: 'relative', padding: 20, marginBottom: 20, background: '#11111c' }}>
          <AudioPlayer rd={rd} />
          <div style={{ marginTop: 10, textAlign: 'center', background: '#f0e040', color: '#0a0a0f', fontWeight: 900, fontSize: 14, padding: '7px 0', borderRadius: 6, fontFamily: 'monospace', letterSpacing: 1 }}>
            {correctIdx === 1 ? '🤖 AI-GENERATED VOICE' : '🧑 REAL VOICE'}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ color: '#444', fontSize: 11, marginBottom: 8, letterSpacing: 1 }}>LEADERBOARD — AFTER ROUND {round + 1}</div>
          {leaderboard.map((p, i) => (
            <LeaderRow key={p.name} rank={i} name={p.name} score={p.score} correct={p.correct} total={round + 1} highlight={i === 0} />
          ))}
        </div>

        <div style={{ textAlign: 'center' }}>
          <button onClick={onNext} style={btn('#f0e040', '#0a0a0f')}>
            {isLast ? '🏆 Final Results' : `▶ Round ${round + 2}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Host: Final ──────────────────────────────────────────────────────────────
function HostFinal({ leaderboard, totalRounds, onReset }) {
  const top3 = leaderboard.slice(0, 3);
  const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
  const podiumHeights = [150, 190, 115];
  const podiumIcons = ['🥈', '🥇', '🥉'];

  return (
    <div style={pg}>
      <div style={{ width: '100%', maxWidth: 600 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 52 }}>🏆</div>
          <div style={{ color: '#f0e040', fontSize: 38, fontWeight: 900, fontFamily: 'monospace', letterSpacing: -1 }}>FINAL SCORES</div>
        </div>

        {/* Podium */}
        {top3.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 32, alignItems: 'flex-end' }}>
            {podiumOrder.map((p, i) => (
              <div key={p.name} style={{ textAlign: 'center', flex: 1 }}>
                <div style={{ fontSize: 32, marginBottom: 4 }}>{podiumIcons[i]}</div>
                <div style={{ color: '#f0e040', fontFamily: 'monospace', fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{p.name}</div>
                <div style={{ color: '#f0e040', fontFamily: 'monospace', fontWeight: 900, fontSize: 20 }}>{p.score}</div>
                <div style={{
                  marginTop: 8, borderRadius: '8px 8px 0 0',
                  height: podiumHeights[i], background: i === 1 ? 'rgba(240,224,64,0.15)' : 'rgba(255,255,255,0.05)',
                  border: `2px solid ${i === 1 ? '#f0e040' : '#2a2a3e'}`,
                  display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 8,
                }}>
                  <span style={{ color: '#444', fontSize: 11 }}>{p.correct}/{totalRounds}✓</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {leaderboard.map((p, i) => (
          <LeaderRow key={p.name} rank={i} name={p.name} score={p.score} correct={p.correct} total={totalRounds} highlight={i === 0} />
        ))}

        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <button onClick={onReset} style={{ ...btn('#1a1a2e', '#888', true), border: '1px solid #2a2a3e' }}>↺ New Game</button>
        </div>
      </div>
    </div>
  );
}

// ─── PLAYER FLOW ──────────────────────────────────────────────────────────────
function PlayerFlow({ config }) {
  const { session, duration = 20, rounds } = config;
  const [name, setName] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [gameState, setGameState] = useState(null);
  const [myAnswers, setMyAnswers] = useState({});
  const [timer, setTimer] = useState(duration);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!name) return;
    const poll = async () => { const gs = await getGameState(session); if (gs) setGameState(gs); };
    poll();
    const id = setInterval(poll, 1500);
    return () => clearInterval(id);
  }, [name, session]);

  useEffect(() => {
    clearInterval(timerRef.current);
    if (gameState?.phase === 'question' && gameState.round_start) {
      const tick = () => {
        const e = (Date.now() - gameState.round_start) / 1000;
        setTimer(Math.max(0, Math.ceil(duration - e)));
      };
      tick();
      timerRef.current = setInterval(tick, 500);
      return () => clearInterval(timerRef.current);
    }
  }, [gameState?.phase, gameState?.round_start, duration]);

  const handleJoin = async (n) => {
    setName(n);
    await joinGame(session, n);
  };

  const handleAnswer = async (choice) => {
    const gs = gameState;
    if (!gs || gs.phase !== 'question') return;
    const r = gs.round;
    if (myAnswers[r] !== undefined) return;
    const elapsed = (Date.now() - gs.round_start) / 1000;
    setMyAnswers(prev => ({ ...prev, [r]: { choice, elapsed } }));
    await submitAnswer(session, r, name, choice, elapsed);
  };

  // Name entry
  if (!name) {
    const submit = () => { const v = nameInput.trim(); if (v) handleJoin(v); };
    return (
      <div style={pg}>
        <div style={{ textAlign: 'center', maxWidth: 320, width: '100%', padding: '0 8px' }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🎙️</div>
          <div style={{ fontSize: 28, fontWeight: 900, color: '#f0e040', fontFamily: 'monospace' }}>AI OR REAL VOICE</div>
          <div style={{ color: '#555', fontSize: 14, margin: '8px 0 26px' }}>Enter your name to join</div>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="Your name…" maxLength={20} autoFocus
            style={{ ...inp, padding: '13px 15px', fontSize: 16, borderRadius: 10, border: '2px solid #2a2a3e' }} />
          <button onClick={submit} style={{ ...btn('#f0e040', '#0a0a0f'), width: '100%', marginTop: 12 }}>JOIN GAME →</button>
        </div>
      </div>
    );
  }

  // Waiting for host to start
  if (!gameState || gameState.phase === 'lobby') return (
    <div style={pg}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 52 }}>⏳</div>
        <div style={{ color: '#f0e040', fontSize: 22, fontWeight: 700, fontFamily: 'monospace', marginTop: 10 }}>You're in, {name}!</div>
        <div style={{ color: '#666', marginTop: 8, fontSize: 14 }}>Waiting for the host to start the game…</div>
      </div>
    </div>
  );

  const round = gameState.round;
  const rd = rounds[round];
  const myAns = myAnswers[round];

  // Question
  if (gameState.phase === 'question') return (
    <div style={pg}>
      <div style={{ width: '100%', maxWidth: 440 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ color: '#555', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>Round {round + 1}/{rounds.length}</div>
            <div style={{ color: '#f0e040', fontWeight: 700, fontSize: 18, fontFamily: 'monospace' }}>{rd?.label}</div>
            <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>Is this voice AI or Real?</div>
          </div>
          <TimerRing seconds={timer} total={duration} />
        </div>

        {myAns !== undefined ? (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ fontSize: 54 }}>✅</div>
            <div style={{ color: '#f0e040', fontSize: 20, fontWeight: 700, fontFamily: 'monospace', marginTop: 10 }}>Locked in!</div>
            <div style={{ color: '#555', marginTop: 8, fontSize: 14 }}>
              You chose <span style={{ color: '#f0e040' }}>{myAns.choice === 1 ? '🤖 AI' : '🧑 Real'}</span> — waiting for the host to reveal…
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 12 }}>
            {[{ lbl: '🧑 Real', icon: '🧑', idx: 0 }, { lbl: '🤖 AI', icon: '🤖', idx: 1 }].map(({ lbl, idx }) => (
              <button key={idx} onClick={() => handleAnswer(idx)} style={{
                flex: 1, background: 'none', border: '2px solid #2a2a3e', borderRadius: 14,
                cursor: 'pointer', padding: '28px 12px', color: '#f0e040', fontFamily: 'monospace',
                fontWeight: 900, fontSize: 20,
              }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#f0e040'}
                onMouseLeave={e => e.currentTarget.style.borderColor = '#2a2a3e'}
              >
                {lbl}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // Reveal — show personal result
  if (gameState.phase === 'reveal') {
    const correctIdx = rd?.ai ?? 0;
    const gotIt = myAns?.choice === correctIdx;
    const { score, correct } = calcMyScore(myAnswers, rounds);
    return (
      <div style={pg}>
        <div style={{ textAlign: 'center', maxWidth: 360, width: '100%', padding: '0 20px' }}>
          <div style={{ fontSize: 60 }}>{myAns === undefined ? '⏰' : gotIt ? '🎯' : '😬'}</div>
          <div style={{ color: myAns === undefined ? '#ff9800' : gotIt ? '#f0e040' : '#ff6b6b', fontSize: 26, fontWeight: 900, fontFamily: 'monospace', marginTop: 8 }}>
            {myAns === undefined ? "TIME'S UP!" : gotIt ? 'CORRECT!' : 'WRONG!'}
          </div>
          <div style={{ color: '#666', fontSize: 13, marginTop: 6 }}>
            That voice was <span style={{ color: '#f0e040', fontWeight: 700 }}>{correctIdx === 1 ? '🤖 AI-generated' : '🧑 Real'}</span>
          </div>
          <div style={{ ...card, margin: '20px 0', padding: '18px 24px' }}>
            <div style={{ color: '#555', fontSize: 12 }}>YOUR SCORE</div>
            <div style={{ color: '#f0e040', fontSize: 44, fontWeight: 900, fontFamily: 'monospace' }}>{score}</div>
            <div style={{ color: '#666', fontSize: 13 }}>{correct} correct after {round + 1} round{round > 0 ? 's' : ''}</div>
          </div>
          <div style={{ color: '#444', fontSize: 13 }}>Waiting for host to continue…</div>
        </div>
      </div>
    );
  }

  // Final
  if (gameState.phase === 'final') {
    const { score, correct } = calcMyScore(myAnswers, rounds);
    const pct = Math.round((correct / rounds.length) * 100);
    const medal = pct >= 80 ? '🏆' : pct >= 60 ? '🥇' : pct >= 40 ? '🥈' : '🥉';
    return (
      <div style={pg}>
        <div style={{ textAlign: 'center', maxWidth: 340, width: '100%', padding: '0 16px' }}>
          <div style={{ fontSize: 64 }}>{medal}</div>
          <div style={{ color: '#f0e040', fontSize: 30, fontWeight: 900, fontFamily: 'monospace', marginTop: 8 }}>GAME OVER</div>
          <div style={{ color: '#888', fontSize: 14, marginTop: 4 }}>{name}</div>
          <div style={{ ...card, margin: '22px 0', padding: '20px 24px' }}>
            <div style={{ color: '#555', fontSize: 12 }}>FINAL SCORE</div>
            <div style={{ color: '#f0e040', fontSize: 50, fontWeight: 900, fontFamily: 'monospace' }}>{score}</div>
            <div style={{ color: '#888', fontSize: 14, marginTop: 4 }}>{correct}/{rounds.length} correct ({pct}%)</div>
          </div>
          <div style={{ color: '#555', fontSize: 13 }}>Check the host screen for the winner announcement! 🏆</div>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const sessionId = params.get('s');

  if (mode === 'host') return <HostFlow />;
  if (sessionId)      return <PlayerBootstrap sessionId={sessionId} />;
  return <Landing />;
}

// Fetches game config from Supabase then hands off to PlayerFlow
function PlayerBootstrap({ sessionId }) {
  const [config, setConfig] = useState(null);
  const [error, setError]   = useState(false);

  useEffect(() => {
    getGameState(sessionId).then(gs => {
      if (gs?.config) setConfig({ ...gs.config, session: sessionId });
      else setError(true);
    });
  }, [sessionId]);

  if (error) return (
    <div style={{ ...pg, textAlign: 'center' }}>
      <div style={{ fontSize: 48 }}>⚠️</div>
      <div style={{ color: '#ff6b6b', fontFamily: 'monospace', fontSize: 18, marginTop: 12 }}>Game not found</div>
      <div style={{ color: '#555', fontSize: 13, marginTop: 8 }}>Ask the host to regenerate the QR code.</div>
    </div>
  );

  if (!config) return (
    <div style={{ ...pg, textAlign: 'center' }}>
      <div style={{ color: '#555', fontFamily: 'monospace', fontSize: 14 }}>Joining game…</div>
    </div>
  );

  return <PlayerFlow config={config} />;
}
