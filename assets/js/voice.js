// voice.js — voice-message recording for Boyz Chat (MediaRecorder).
// No Firebase dependency here, so the recording helpers can be unit-tested
// in Node with a stubbed MediaRecorder if needed.

/** True when this browser can record audio (MediaRecorder + mic access). */
export function voiceSupported() {
  return typeof MediaRecorder !== 'undefined' &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function pickMimeType() {
  const cands = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    '',
  ];
  for (const t of cands) {
    try {
      if (!t || MediaRecorder.isTypeSupported(t)) return t;
    } catch { /* ignore */ }
  }
  return '';
}

let rec = null; // { mr, chunks, stream, startedAt, mime }

/** Start recording. Resolves when the recorder is running; rejects on mic denial. */
export async function startVoiceRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMimeType();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.start(250);
  rec = { mr, chunks, stream, startedAt: Date.now(), mime: mr.mimeType || mime };
  return rec;
}

export function isRecording() { return !!rec; }

/** Stop recording. Resolves to { blob, durSec } or null when nothing was recorded. */
export function stopVoiceRecording() {
  return new Promise((resolve) => {
    if (!rec) { resolve(null); return; }
    const r = rec;
    rec = null;
    const done = (ok) => {
      r.stream.getTracks().forEach((t) => t.stop());
      if (!ok || !r.chunks.length) { resolve(null); return; }
      const blob = new Blob(r.chunks, { type: r.mime || 'audio/webm' });
      resolve({ blob, durSec: Math.max(1, Math.round((Date.now() - r.startedAt) / 1000)) });
    };
    r.mr.onstop = () => done(true);
    r.mr.onerror = () => done(false);
    try { r.mr.stop(); } catch { done(false); }
  });
}
