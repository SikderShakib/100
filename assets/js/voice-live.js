// voice-live.js — Boyz Chat LIVE voice (WebRTC mesh, no recording, no storage).
// Voice goes phone-to-phone. Signalling travels inside the room doc
// (room.voiceSignals array) so no new Firestore rules / subcollection needed.
// Non-trickle ICE: one offer + one answer per pair, SDP carries all candidates.
// Mic is OFF by default. Muting only disables the local track (no renegotiation).
// Remote mute is local-only: it mutes that peer's <audio> on YOUR phone.

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
const SIGNAL_MAX_AGE_MS = 120000;
const SIGNAL_KEEP = 60;

function newSignalId() {
  return 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function waitForIceComplete(pc, timeoutMs = 3000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(done, timeoutMs);
  });
}

export const voiceLive = {
  myId: null,
  getPeerIds: null, // () => string[]
  sendSignal: null, // async (signal) => void
  onMicState: null, // (micOn: boolean) => void — app writes room.voiceMic
  onSpeaking: null, // (peerId, speaking: boolean) => void
  onStatus: null, // (msg) => void

  _pcs: new Map(), // peerId -> RTCPeerConnection
  _localStream: null,
  _micOn: false,
  _processed: new Set(),
  _audioEls: new Map(), // peerId -> <audio>
  _audioCtx: null,
  _analysers: new Map(), // peerId ('me' for local) -> { analyser, data }
  _speaking: new Set(),
  _mutedPeers: new Set(),
  _speakingTimer: null,
  _container: null,

  init(opts) {
    this.myId = opts.myId;
    this.getPeerIds = opts.getPeerIds;
    this.sendSignal = opts.sendSignal;
    this.onMicState = opts.onMicState || (() => {});
    this.onSpeaking = opts.onSpeaking || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this._container = opts.audioContainer || document.body;
    this._startSpeakingLoop();
  },

  isMicOn() { return this._micOn; },
  isPeerMuted(peerId) { return this._mutedPeers.has(peerId); },

  setPeerMuted(peerId, muted) {
    if (muted) this._mutedPeers.add(peerId);
    else this._mutedPeers.delete(peerId);
    const el = this._audioEls.get(peerId);
    if (el) el.muted = !!muted;
    return muted;
  },

  _ensureAudioCtx() {
    if (!this._audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this._audioCtx = new AC();
    }
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(() => {});
    }
    return this._audioCtx;
  },

  _watchStream(peerId, stream) {
    try {
      const ctx = this._ensureAudioCtx();
      if (!ctx) return;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this._analysers.set(peerId, { analyser, data: new Uint8Array(analyser.fftSize) });
    } catch (e) { /* speaking dot is best-effort */ }
  },

  _startSpeakingLoop() {
    if (this._speakingTimer) return;
    this._speakingTimer = setInterval(() => {
      for (const [peerId, { analyser, data }] of this._analysers) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
        const avg = sum / data.length;
        // Silence ~1-3, normal speech ~10-30.
        const speaking = avg > 8;
        const was = this._speaking.has(peerId);
        if (speaking && !was) {
          this._speaking.add(peerId);
          this.onSpeaking(peerId, true);
        } else if (!speaking && was) {
          this._speaking.delete(peerId);
          this.onSpeaking(peerId, false);
        }
      }
    }, 150);
  },

  _ensurePC(peerId) {
    let pc = this._pcs.get(peerId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: STUN });
    this._pcs.set(peerId, pc);
    pc.ontrack = (ev) => {
      const stream = ev.streams && ev.streams[0];
      if (!stream) return;
      let el = this._audioEls.get(peerId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.playsInline = true;
        el.muted = this._mutedPeers.has(peerId);
        this._audioEls.set(peerId, el);
        this._container.appendChild(el);
      }
      el.srcObject = stream;
      el.play().catch(() => {});
      this._watchStream(peerId, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.onStatus('voice-connect-failed:' + peerId);
      }
    };
    pc.onnegotiationneeded = () => {
      // Remote added a track (they turned mic on) — renegotiate if stable.
      if (pc.signalingState === 'stable' && this._micOn) {
        this.createOffer(peerId).catch(() => {});
      }
    };
    return pc;
  },

  _addLocalTracks(pc) {
    if (!this._localStream) return false;
    let added = false;
    for (const track of this._localStream.getAudioTracks()) {
      const already = pc.getSenders().some((s) => s.track === track);
      if (!already) { pc.addTrack(track, this._localStream); added = true; }
    }
    return added;
  },

  async createOffer(peerId) {
    if (!this.myId || peerId === this.myId) return;
    const pc = this._ensurePC(peerId);
    if (pc.signalingState !== 'stable') return;
    this._addLocalTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceComplete(pc);
    if (!pc.localDescription) return;
    await this.sendSignal({
      id: newSignalId(), from: this.myId, to: peerId,
      type: 'offer', sdp: pc.localDescription.sdp, ts: Date.now(),
    });
  },

  async _handleOffer(signal) {
    const pc = this._ensurePC(signal.from);
    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    this._addLocalTracks(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceComplete(pc);
    if (!pc.localDescription) return;
    await this.sendSignal({
      id: newSignalId(), from: this.myId, to: signal.from,
      type: 'answer', sdp: pc.localDescription.sdp, ts: Date.now(),
    });
  },

  async _handleAnswer(signal) {
    const pc = this._pcs.get(signal.from);
    if (!pc) return;
    if (pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
  },

  handleSignals(signals) {
    if (!Array.isArray(signals) || !this.myId) return;
    const now = Date.now();
    for (const sig of signals) {
      if (!sig || !sig.id || !sig.from || !sig.to || !sig.type) continue;
      if (this._processed.has(sig.id)) continue;
      this._processed.add(sig.id);
      if (this._processed.size > 1000) this._processed.clear();
      if (sig.from === this.myId) continue;
      if (sig.to !== this.myId) continue;
      if (sig.ts && now - sig.ts > SIGNAL_MAX_AGE_MS) continue; // stale offer
      if (sig.type === 'offer') this._handleOffer(sig).catch((e) => console.error('voice offer failed', e));
      else if (sig.type === 'answer') this._handleAnswer(sig).catch((e) => console.error('voice answer failed', e));
    }
  },

  async offerToPeers(peerIds) {
    const ids = (peerIds || []).filter((id) => id && id !== this.myId);
    for (const id of ids) {
      try { await this.createOffer(id); } catch (e) { console.error('voice offer failed', e); }
    }
  },

  async toggleMic() {
    if (!window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('mic-not-supported');
    }
    // First ever ON: ask for the mic.
    if (!this._localStream) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this._localStream = stream;
      this._watchStream('me', stream);
      this._micOn = true;
      this.onMicState(true);
      // Offer to everyone (also (re)adds tracks to existing PCs).
      await this.offerToPeers(this.getPeerIds ? this.getPeerIds() : []);
      return true;
    }
    const track = this._localStream.getAudioTracks()[0];
    if (this._micOn) {
      if (track) track.enabled = false;
      this._micOn = false;
      this.onMicState(false);
      return false;
    }
    if (track) track.enabled = true;
    this._micOn = true;
    this.onMicState(true);
    // Existing PCs may lack our track (we joined muted) — add + renegotiate.
    for (const [, pc] of this._pcs) this._addLocalTracks(pc);
    await this.offerToPeers(this.getPeerIds ? this.getPeerIds() : []);
    return true;
  },

  cleanup() {
    for (const [, pc] of this._pcs) {
      try { pc.close(); } catch (e) {}
    }
    this._pcs.clear();
    if (this._localStream) {
      for (const t of this._localStream.getTracks()) { try { t.stop(); } catch (e) {} }
      this._localStream = null;
    }
    for (const [, el] of this._audioEls) el.remove();
    this._audioEls.clear();
    this._analysers.clear();
    this._speaking.clear();
    this._processed.clear();
    this._micOn = false;
    if (this._speakingTimer) { clearInterval(this._speakingTimer); this._speakingTimer = null; }
  },
};

export { SIGNAL_KEEP };
