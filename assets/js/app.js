// app.js — "100 Cards" multiplayer game.
// Firestore realtime rooms. Config comes from ./firebase-config.js.
// Flow: Home -> Lobby -> Target -> Table -> Result. See game-build-plan.md.

import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  arrayUnion, arrayRemove, serverTimestamp, runTransaction,
} from 'firebase/firestore';
import { firebaseConfig } from './firebase-config.js';
import {
  CARD_BY_ID, deckFor, shuffleDeck, deal, trickWinner, scoreOf, computeResults,
  seriesDelta, seriesWinnerId, bn,
} from './cards.js';

// ---------- setup ----------
const CONFIGURED = !!(
  firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('TODO') &&
  firebaseConfig.projectId && !String(firebaseConfig.projectId).startsWith('TODO')
);

const $ = (id) => document.getElementById(id);
let db = null;
let roomCode = null;
let myId = null;
let myName = '';
let isHost = false;
let room = null;          // latest room snapshot
let unsub = null;
let selectedCard = null;
let resolving = false;
let playing = false;      // a play write is in flight
let toastTimer = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = true;
  $('screen-' + name).hidden = false;
  window.scrollTo(0, 0);
}

function initFirebase() {
  if (db) return db;
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  db = getFirestore(app);
  return db;
}

const roomRef = () => doc(db, 'rooms', roomCode);

function saveSession() {
  sessionStorage.setItem('c100', JSON.stringify({ code: roomCode, id: myId, name: myName }));
}
function clearSession() { sessionStorage.removeItem('c100'); }

function newPlayerId() { return 'p_' + Math.random().toString(36).slice(2, 10); }

function genCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O, to avoid confusion
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

// ---------- home: create / join ----------
async function createRoom() {
  const name = $('nameInput').value.trim();
  if (!name) { $('homeError').textContent = 'আপনার নাম লিখুন।'; return; }
  if (!CONFIGURED) { toast('Firebase কনফিগ এখনো বসানো হয়নি।'); return; }
  $('homeError').textContent = '';
  myName = name;
  myId = newPlayerId();
  isHost = true;
  initFirebase();
  localStorage.setItem('c100-name', name);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    const ref = doc(db, 'rooms', code);
    if ((await getDoc(ref)).exists()) continue;
    roomCode = code;
    await setDoc(ref, {
      status: 'lobby',
      players: { [myId]: { id: myId, name, isHost: true, target: null, won: [] } },
      order: [myId],
      hands: {},
      currentTrick: [],
      leader: null,
      turn: null,
      round: 1,
      roundsTotal: 0,
      winnerId: null,
      matchNo: 1,
      totals: {},
      seriesTarget: 1000,
      seriesWinnerId: null,
      chat: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    saveSession();
    attachListener();
    return;
  }
  toast('রুম তৈরি হয়নি, আবার চেষ্টা করুন।');
}

async function joinRoom() {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) { $('homeError').textContent = 'আপনার নাম লিখুন।'; return; }
  if (!code) { $('homeError').textContent = 'রুম কোড লিখুন।'; return; }
  if (!CONFIGURED) { toast('Firebase কনফিগ এখনো বসানো হয়নি।'); return; }
  $('homeError').textContent = '';
  myName = name;
  myId = newPlayerId();
  isHost = false;
  initFirebase();
  localStorage.setItem('c100-name', name);

  const ref = doc(db, 'rooms', code);
  const snap = await getDoc(ref);
  if (!snap.exists()) { $('homeError').textContent = 'এই কোডের কোনো রুম পাওয়া যায়নি।'; return; }
  const r = snap.data();
  if (r.status !== 'lobby') { $('homeError').textContent = 'এই রুমের খেলা ইতিমধ্যে শুরু হয়ে গেছে।'; return; }
  if (r.order.length >= 4) { $('homeError').textContent = 'রুম ভর্তি (৪ জন হয়ে গেছে)।'; return; }
  const taken = r.order.some((pid) => r.players[pid].name.toLowerCase() === name.toLowerCase());
  if (taken) { $('homeError').textContent = 'এই নামে একজন ইতিমধ্যে রুমে আছেন।'; return; }

  roomCode = code;
  await updateDoc(ref, {
    ['players.' + myId]: { id: myId, name, isHost: false, target: null, won: [] },
    order: arrayUnion(myId),
    updatedAt: serverTimestamp(),
  });
  saveSession();
  attachListener();
}

// ---------- realtime listener ----------
function attachListener() {
  if (unsub) unsub();
  unsub = onSnapshot(roomRef(), (snap) => {
    if (!snap.exists()) { toast('রুমটি আর নেই।'); leaveToHome(); return; }
    room = snap.data();
    if (!room.players[myId]) { toast('আপনি আর এই রুমে নেই।'); leaveToHome(); return; }
    isHost = !!room.players[myId].isHost;
    render();
    // Host flips target -> playing once every target is in.
    if (room.status === 'target' && isHost &&
        room.order.every((pid) => room.players[pid].target != null)) {
      updateDoc(roomRef(), {
        status: 'playing', turn: room.leader, updatedAt: serverTimestamp(),
      }).catch(() => {});
    }
    // A complete trick must be resolved; the transaction guard makes
    // simultaneous attempts from several clients safe (losers no-op).
    if (room.status === 'playing' && room.currentTrick &&
        room.currentTrick.length >= room.order.length) {
      resolveTrick();
    }
  }, (err) => {
    console.error('room listener error', err);
    toast('সংযোগে সমস্যা হয়েছে।');
  });
}

function leaveToHome() {
  if (unsub) { unsub(); unsub = null; }
  clearSession();
  room = null; roomCode = null; myId = null; isHost = false; selectedCard = null;
  showScreen('home');
}

// ---------- lobby / start ----------
async function startGame() {
  if (!room || !isHost) return;
  const n = room.order.length;
  if (n < 3 || n > 4) { toast('৩–৪ জন হলে খেলা শুরু করা যাবে।'); return; }
  const deck = shuffleDeck(deckFor(n));
  const hands = deal(deck, room.order);
  const leader = room.order.find((pid) => hands[pid].includes('c01'));
  await updateDoc(roomRef(), {
    status: 'target',
    hands,
    leader,
    round: 1,
    roundsTotal: hands[room.order[0]].length,
    currentTrick: [],
    turn: null,
    updatedAt: serverTimestamp(),
  });
  toast('কার্ড বন্টন হয়ে গেছে — এবার টার্গেট লিখুন।');
}

// ---------- target ----------
async function submitTarget() {
  const v = parseInt($('targetInput').value, 10);
  if (Number.isNaN(v) || v < 20 || v > 160) {
    $('targetError').textContent = 'টার্গেট ২০ থেকে ১৬০-এর মধ্যে লিখুন।';
    return;
  }
  $('targetError').textContent = '';
  await updateDoc(roomRef(), {
    ['players.' + myId + '.target']: v,
    updatedAt: serverTimestamp(),
  });
  toast('টার্গেট জমা হয়েছে: ' + bn(v));
}

// ---------- playing ----------
function nextPlayerId(afterId) {
  const i = room.order.indexOf(afterId);
  return room.order[(i + 1) % room.order.length];
}

/** The opening play of the game: round 1 with an empty trick.
 *  It must be the Driver card (c01) — no other card may open the game. */
function isOpeningPlay() {
  return room && room.status === 'playing' && room.round === 1 &&
    (!room.currentTrick || room.currentTrick.length === 0);
}

async function playCard(cardId) {
  if (!room || room.status !== 'playing' || room.turn !== myId || playing) return;
  if (!(room.hands[myId] || []).includes(cardId)) return;
  if (isOpeningPlay() && cardId !== 'c01') {
    toast('খেলা ড্রাইভার কার্ড দিয়েই শুরু করতে হবে।');
    return;
  }
  playing = true;
  try {
    await updateDoc(roomRef(), {
      ['hands.' + myId]: arrayRemove(cardId),
      currentTrick: arrayUnion({ playerId: myId, cardId }),
      turn: nextPlayerId(myId),
      updatedAt: serverTimestamp(),
    });
    selectedCard = null;
  } catch (e) {
    console.error('play failed', e);
    toast('কার্ড খেলা যায়নি, আবার চেষ্টা করুন।');
  }
  playing = false;
}

/** Resolve a completed trick inside a transaction (safe against races). */
async function resolveTrick() {
  if (resolving) return;
  resolving = true;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef());
      if (!snap.exists()) return;
      const r = snap.data();
      if (r.status !== 'playing') return;
      const n = r.order.length;
      if (!r.currentTrick || r.currentTrick.length < n) return;

      const winnerId = trickWinner(r.currentTrick);
      const wonIds = r.currentTrick.map((p) => p.cardId);
      const updates = {};
      updates['players.' + winnerId + '.won'] = arrayUnion(...wonIds);

      if (r.round >= r.roundsTotal) {
        // Last trick: finish the game and compute the winner.
        const finalPlayers = r.order.map((pid) => ({
          id: pid,
          target: r.players[pid].target,
          won: pid === winnerId
            ? [...(r.players[pid].won || []), ...wonIds]
            : [...(r.players[pid].won || [])],
        }));
        const { winnerId: finalWinner } = computeResults(finalPlayers);
        // Series totals: met target -> +match score, missed -> -target.
        const totals = { ...(r.totals || {}) };
        const matchScores = {};
        for (const fp of finalPlayers) {
          const sc = scoreOf(fp.won || []);
          matchScores[fp.id] = sc;
          totals[fp.id] = (totals[fp.id] ?? 0) + seriesDelta(fp.target, sc);
        }
        const seriesWinner = seriesWinnerId(totals, r.seriesTarget ?? 1000, matchScores);
        updates.status = 'done';
        updates.currentTrick = [];
        updates.turn = null;
        updates.winnerId = finalWinner;
        updates.totals = totals;
        updates.seriesWinnerId = seriesWinner;
      } else {
        updates.currentTrick = [];
        updates.leader = winnerId;
        updates.turn = winnerId;
        updates.round = r.round + 1;
      }
      updates.updatedAt = serverTimestamp();
      tx.update(roomRef(), updates);
    });
  } catch (e) {
    console.error('resolve failed', e);
  }
  resolving = false;
}

// ---------- Boyz Chat: text messages ----------
const CHAT_KEEP = 20;
const CHAT_MAX_LEN = 200;

function chatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return bn(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
}

async function sendTextMessage() {
  if (!room || !roomCode) return;
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (text.length > CHAT_MAX_LEN) { toast('মেসেজ ২০০ অক্ষরের মধ্যে লিখুন।'); return; }
  input.value = '';
  const msg = { id: 'm_' + Math.random().toString(36).slice(2, 10), playerId: myId, name: myName, text, createdAt: Date.now() };
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef());
      if (!snap.exists()) return;
      const chat = [...(snap.data().chat || []), msg].slice(-CHAT_KEEP);
      tx.update(roomRef(), { chat, updatedAt: serverTimestamp() });
    });
  } catch (e) {
    console.error('chat send failed', e);
    toast('মেসেজ পাঠানো যায়নি, আবার চেষ্টা করুন।');
  }
}

function renderChat() {
  const list = $('chatList');
  if (!list) return;
  const msgs = (room.chat || []).slice(-CHAT_KEEP);
  list.innerHTML = '';
  if (!msgs.length) {
    const d = document.createElement('div');
    d.className = 'chat-empty';
    d.textContent = 'এখনো কোনো মেসেজ নেই — প্রথম মেসেজটি পাঠান!';
    list.appendChild(d);
    return;
  }
  for (const m of msgs) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (m.playerId === myId ? ' mine' : '');
    const nm = document.createElement('div');
    nm.className = 'chat-name';
    nm.textContent = (m.name || '?') + (m.playerId === myId ? ' (আপনি)' : '');
    const tm = document.createElement('span');
    tm.className = 'chat-time';
    tm.textContent = chatTime(m.createdAt);
    nm.appendChild(tm);
    const tx = document.createElement('div');
    tx.className = 'chat-text';
    tx.textContent = m.text || '';
    item.appendChild(nm);
    item.appendChild(tx);
    list.appendChild(item);
  }
}

// ---------- play again ----------
async function playAgain() {
  if (!room || !isHost) return;
  const resetPlayers = {};
  for (const pid of room.order) {
    resetPlayers[pid] = { ...room.players[pid], target: null, won: [] };
  }
  // Series over -> fresh series (totals back to 0, match 1).
  // Otherwise -> next match, totals carry over.
  const seriesOver = !!room.seriesWinnerId;
  const totals = {};
  for (const pid of room.order) totals[pid] = seriesOver ? 0 : ((room.totals || {})[pid] ?? 0);
  await updateDoc(roomRef(), {
    status: 'lobby',
    players: resetPlayers,
    hands: {},
    currentTrick: [],
    leader: null,
    turn: null,
    round: 1,
    roundsTotal: 0,
    winnerId: null,
    matchNo: seriesOver ? 1 : (room.matchNo || 1) + 1,
    totals,
    seriesWinnerId: null,
    updatedAt: serverTimestamp(),
  });
  toast(seriesOver ? 'নতুন সিরিজ শুরু হচ্ছে।' : 'পরের ম্যাচের জন্য লবিতে ফিরে গেলেন।');
}

// ---------- rendering ----------
function playerName(pid) { return room.players[pid] ? room.players[pid].name : '?'; }

function render() {
  if (!room) return;
  if (room.status === 'lobby') { showScreen('lobby'); renderLobby(); }
  else if (room.status === 'target') { showScreen('target'); renderTarget(); }
  else if (room.status === 'playing') { showScreen('table'); renderTable(); }
  else if (room.status === 'done') { showScreen('result'); renderResult(); }
}

function renderLobby() {
  $('roomCodeBig').textContent = roomCode;
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (const pid of room.order) {
    const p = room.players[pid];
    const li = document.createElement('li');
    li.innerHTML = '';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name + (pid === myId ? ' (আপনি)' : '');
    li.appendChild(nameSpan);
    if (p.isHost) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'হোস্ট';
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
  const n = room.order.length;
  $('lobbyNote').textContent = n < 3
    ? `আরও ${bn(3 - n)} জন দরকার — মোট ${bn(n)} জন আছেন।`
    : `${bn(n)} জন তৈরি — খেলা শুরু করা যাবে।`;
  const startBtn = $('btnStart');
  startBtn.disabled = !(isHost && n >= 3 && n <= 4);
  startBtn.textContent = isHost ? 'খেলা শুরু করুন' : 'হোস্ট খেলা শুরু করবেন…';
}

function renderFan(container, cardIds, opts = {}) {
  container.innerHTML = '';
  const sorted = [...cardIds].sort((a, b) => CARD_BY_ID[b].top - CARD_BY_ID[a].top);
  const n = sorted.length;
  sorted.forEach((cid, i) => {
    const angle = n > 1 ? (i - (n - 1) / 2) * 11 : 0;
    const el = document.createElement('div');
    const isDisabled = opts.disabled && opts.disabled.includes(cid);
    el.className = 'card' + (opts.playable ? ' playable' : '') + (opts.selected === cid ? ' selected' : '') + (isDisabled ? ' disabled' : '');
    el.style.setProperty('--r', angle + 'deg');
    const img = document.createElement('img');
    img.src = 'assets/cards/' + CARD_BY_ID[cid].file;
    img.alt = CARD_BY_ID[cid].top + '/' + CARD_BY_ID[cid].bottom;
    el.appendChild(img);
    if (opts.onSelect) el.addEventListener('click', () => {
      if (isDisabled) { toast('খেলা ড্রাইভার কার্ড দিয়েই শুরু করতে হবে।'); return; }
      opts.onSelect(cid);
    });
    container.appendChild(el);
  });
}

function renderTarget() {
  const myHand = room.hands[myId] || [];
  renderFan($('targetHand'), myHand, {});
  const me = room.players[myId];
  const input = $('targetInput');
  const btn = $('btnTarget');
  if (me.target != null) {
    input.disabled = true;
    btn.disabled = true;
    btn.textContent = 'টার্গেট জমা হয়েছে: ' + bn(me.target);
  } else {
    input.disabled = false;
    btn.disabled = false;
    btn.textContent = 'টার্গেট জমা দিন';
  }
  const ul = $('targetStatus');
  ul.innerHTML = '';
  for (const pid of room.order) {
    const p = room.players[pid];
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name + (pid === myId ? ' (আপনি)' : '');
    const st = document.createElement('span');
    st.className = 'tick';
    st.textContent = p.target != null ? 'টার্গেট ✓' : 'অপেক্ষা…';
    li.appendChild(nameSpan);
    li.appendChild(st);
    ul.appendChild(li);
  }
}

function renderTable() {
  // Top bar: name + target + live score + tricks won.
  const bar = $('topBar');
  bar.innerHTML = '';
  for (const pid of room.order) {
    const p = room.players[pid];
    const tricks = Math.floor((p.won || []).length / room.order.length);
    const chip = document.createElement('div');
    chip.className = 'chip' + (pid === myId ? ' me' : '');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = p.name + (pid === myId ? ' (আপনি)' : '');
    const sc = document.createElement('div');
    sc.className = 'sc';
    sc.innerHTML = '';
    sc.appendChild(document.createTextNode('লক্ষ্য ' + bn(p.target) + ' • '));
    const b = document.createElement('b');
    b.textContent = 'স্কোর ' + bn(scoreOf(p.won || []));
    sc.appendChild(b);
    sc.appendChild(document.createTextNode(' • দান ' + bn(tricks)));
    const seriesTotal = (room.totals || {})[pid] ?? 0;
    sc.appendChild(document.createTextNode(' • সিরিজ ' + bn(seriesTotal)));
    chip.appendChild(nm);
    chip.appendChild(sc);
    bar.appendChild(chip);
  }

  const banner = $('turnBanner');
  const opening = isOpeningPlay();
  if (room.turn === myId) {
    banner.textContent = opening
      ? 'আপনার পালা — ড্রাইভার কার্ড দিয়েই খেলা শুরু করুন'
      : 'আপনার পালা — একটি কার্ড খেলুন';
    banner.classList.add('my-turn');
  } else {
    banner.textContent = opening
      ? playerName(room.turn) + ' ড্রাইভার কার্ড দিয়ে খেলা শুরু করবেন'
      : playerName(room.turn) + '-এর পালা';
    banner.classList.remove('my-turn');
  }
  $('turnSub').textContent =
    'লিডার: ' + playerName(room.leader) +
    ' • রাউন্ড ' + bn(room.round) + '/' + bn(room.roundsTotal) +
    ' • ম্যাচ ' + bn(room.matchNo || 1) +
    ' • সিরিজ টার্গেট ' + bn(room.seriesTarget ?? 1000);

  // Centre: played cards of this trick + empty slots for those yet to play.
  const area = $('trickArea');
  area.innerHTML = '';
  const playedIds = new Set((room.currentTrick || []).map((p) => p.playerId));
  if (!room.currentTrick || room.currentTrick.length === 0) {
    const d = document.createElement('div');
    d.className = 'trick-empty';
    d.textContent = 'এখনো কেউ কার্ড খেলেনি।';
    area.appendChild(d);
  }
  for (const play of room.currentTrick || []) {
    const slot = document.createElement('div');
    slot.className = 'trick-slot';
    const img = document.createElement('img');
    img.src = 'assets/cards/' + CARD_BY_ID[play.cardId].file;
    img.alt = CARD_BY_ID[play.cardId].top + '/' + CARD_BY_ID[play.cardId].bottom;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = playerName(play.playerId);
    slot.appendChild(img);
    slot.appendChild(who);
    area.appendChild(slot);
  }
  for (const pid of room.order) {
    if (playedIds.has(pid)) continue;
    const slot = document.createElement('div');
    slot.className = 'trick-slot empty';
    slot.textContent = playerName(pid);
    area.appendChild(slot);
  }

  // My hand.
  const myHand = room.hands[myId] || [];
  renderFan($('myHand'), myHand, {
    playable: room.turn === myId,
    disabled: isOpeningPlay() ? myHand.filter((c) => c !== 'c01') : [],
    selected: selectedCard,
    onSelect: (cid) => {
      if (room.turn !== myId) { toast('এখন আপনার পালা নয়।'); return; }
      if (selectedCard === cid) { playCard(cid); return; }
      selectedCard = cid;
      renderTable();
    },
  });
  const playBtn = $('btnPlay');
  playBtn.disabled = !(room.turn === myId && selectedCard && myHand.includes(selectedCard));
  playBtn.textContent = selectedCard ? 'এই কার্ডটি খেলুন' : 'একটি কার্ড বাছুন';

  renderChat();
}

function renderResult() {
  const rows = room.order.map((pid) => {
    const p = room.players[pid];
    const score = scoreOf(p.won || []);
    return { id: pid, name: p.name, target: p.target, score, met: p.target != null && score >= p.target };
  });
  const winner = room.winnerId ? room.players[room.winnerId] : null;
  const winnerScore = winner ? scoreOf(winner.won || []) : 0;
  $('winnerName').textContent = winner ? winner.name : '—';
  $('winnerScore').textContent = winner
    ? 'স্কোর ' + bn(winnerScore) + ' (টার্গেট ' + bn(winner.target) + ')'
    : '—';
  const body = $('resultBody');
  body.innerHTML = '';
  rows.sort((a, b) => b.score - a.score);
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.id === room.winnerId) tr.className = 'winner-row';
    const tdName = document.createElement('td'); tdName.textContent = r.name;
    const tdTarget = document.createElement('td'); tdTarget.textContent = bn(r.target);
    const tdScore = document.createElement('td'); tdScore.textContent = bn(r.score);
    const tdMet = document.createElement('td'); tdMet.textContent = r.met ? '✅ শো' : '—';
    tr.append(tdName, tdTarget, tdScore, tdMet);
    body.appendChild(tr);
  }
  // Series box: running totals + series winner (if the series is over).
  const seriesOver = !!room.seriesWinnerId;
  const totals = room.totals || {};
  $('seriesBox').hidden = false;
  $('seriesMatchNo').textContent = '— ম্যাচ ' + bn(room.matchNo || 1);
  const swLine = $('seriesWinnerLine');
  if (seriesOver && room.seriesWinnerId) {
    swLine.hidden = false;
    swLine.textContent = '🏆 সিরিজ জিতেছেন ' + playerName(room.seriesWinnerId) +
      ' — মোট স্কোর ' + bn(totals[room.seriesWinnerId] ?? 0);
  } else {
    swLine.hidden = true;
    swLine.textContent = '';
  }
  const sBody = $('seriesBody');
  sBody.innerHTML = '';
  const sRows = room.order.map((pid) => {
    const p = room.players[pid];
    const score = scoreOf(p.won || []);
    return { id: pid, name: p.name, score, target: p.target, met: p.target != null && score >= p.target, total: totals[pid] ?? 0 };
  });
  sRows.sort((a, b) => b.total - a.total);
  for (const r of sRows) {
    const tr = document.createElement('tr');
    if (r.id === room.seriesWinnerId) tr.className = 'winner-row';
    const tdName = document.createElement('td'); tdName.textContent = r.name;
    const tdScore = document.createElement('td'); tdScore.textContent = bn(r.score);
    const tdTarget = document.createElement('td'); tdTarget.textContent = bn(r.target) + (r.met ? ' ✓' : ' ✗');
    const tdTotal = document.createElement('td'); tdTotal.textContent = bn(r.total);
    tr.append(tdName, tdScore, tdTarget, tdTotal);
    sBody.appendChild(tr);
  }
  const again = $('btnAgain');
  if (isHost) {
    again.disabled = false;
    again.textContent = seriesOver ? 'নতুন সিরিজ শুরু করুন' : 'পরের ম্যাচ খেলুন (একই রুমে)';
  } else {
    again.disabled = true;
    again.textContent = seriesOver ? 'হোস্ট নতুন সিরিজ শুরু করবেন…' : 'হোস্ট পরের ম্যাচ শুরু করবেন…';
  }
}

// ---------- wire up ----------
$('btnCreate').addEventListener('click', () => { createRoom().catch((e) => { console.error(e); toast('রুম তৈরি হয়নি।'); }); });
$('btnJoin').addEventListener('click', () => { joinRoom().catch((e) => { console.error(e); toast('যোগ দেওয়া যায়নি।'); }); });
function inviteUrl() {
  return location.origin + location.pathname + '?room=' + roomCode;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove(); return ok;
    } catch { return false; }
  }
}

$('btnCopyCode').addEventListener('click', async () => {
  if (await copyText(roomCode)) toast('কোড কপি হয়েছে: ' + roomCode);
  else toast('কোড: ' + roomCode);
});
$('btnCopyLink').addEventListener('click', async () => {
  const url = inviteUrl();
  if (await copyText(url)) toast('লিংক কপি হয়েছে — বন্ধুদের পাঠান।');
  else toast('লিংক: ' + url);
});
$('btnStart').addEventListener('click', () => { startGame().catch((e) => { console.error(e); toast('খেলা শুরু হয়নি।'); }); });
$('btnLeaveLobby').addEventListener('click', leaveToHome);
$('btnTarget').addEventListener('click', () => { submitTarget().catch((e) => { console.error(e); toast('টার্গেট জমা হয়নি।'); }); });
$('btnPlay').addEventListener('click', () => { if (selectedCard) playCard(selectedCard); });
$('btnSend').addEventListener('click', () => { sendTextMessage().catch((e) => { console.error(e); toast('মেসেজ পাঠানো যায়নি।'); }); });
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendTextMessage(); } });
$('btnAgain').addEventListener('click', () => { playAgain().catch((e) => { console.error(e); toast('আবার খেলা শুরু হয়নি।'); }); });
$('btnNewRoom').addEventListener('click', leaveToHome);

// ---------- boot ----------
if (!CONFIGURED) {
  $('cfgWarn').hidden = false;
}
const savedName = localStorage.getItem('c100-name');
if (savedName) $('nameInput').value = savedName;

// Invite link: ?room=ABCD pre-fills the join code.
const inviteCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '');
if (inviteCode.length === 4) {
  $('codeInput').value = inviteCode;
  const hint = $('inviteHint');
  hint.textContent = 'রুম ' + inviteCode + '-এ আমন্ত্রণ পেয়েছেন — নাম লিখে "রুমে যোগ দিন" চাপুন।';
  hint.hidden = false;
}

// PWA: register the service worker (installable like OTW).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

const saved = JSON.parse(sessionStorage.getItem('c100') || 'null');
if (saved && saved.code && saved.id && CONFIGURED) {
  roomCode = saved.code;
  myId = saved.id;
  myName = saved.name || '';
  initFirebase();
  attachListener(); // isHost is re-derived from the room doc on each snapshot
}
