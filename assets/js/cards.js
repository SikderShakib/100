// cards.js — fixed card table + pure game logic for the "100 Cards" game.
// Card table source: ~/workspace/custom-cards/README.md
//   Top = 5 x card number, bottom = card number (5/1 ... 100/20).
//   Card 21 is the extra 0/0 egg card for 3-player games (top 0, bottom 0).
// No browser / Firebase dependencies here, so this file can be unit-tested in Node.

export const CARDS = [];
for (let n = 1; n <= 20; n++) {
  CARDS.push({
    id: 'c' + String(n).padStart(2, '0'),
    file: n === 1 ? 'card-01-driver.png' : 'card-' + String(n).padStart(2, '0') + '.png',
    top: 5 * n,
    bottom: n,
    driver: n === 1,
    egg: false,
  });
}
CARDS.push({ id: 'c21', file: 'card-21.png', top: 0, bottom: 0, driver: false, egg: true });

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

/** Deck for a game: 4 players -> 20 cards, 3 players -> 21 cards incl. egg. */
export function deckFor(playerCount) {
  return playerCount === 3
    ? CARDS.map((c) => c.id)
    : CARDS.filter((c) => !c.egg).map((c) => c.id);
}

/** Fisher-Yates shuffle. Returns a new array, input untouched. */
export function shuffleDeck(ids) {
  const d = [...ids];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** Deal round-robin, one card at a time, in seat order. */
export function deal(deck, playerIds) {
  const hands = {};
  for (const id of playerIds) hands[id] = [];
  deck.forEach((cardId, i) => hands[playerIds[i % playerIds.length]].push(cardId));
  return hands;
}

/** Top 3 cards by TOP value: c18 (90), c19 (95), c20 (100). */
export const TOP_CARD_IDS = ['c18', 'c19', 'c20'];

/** The lucky name: a player who joins with this name (case-insensitive)
 *  always receives one of the top 3 cards at deal time. */
export const LUCKY_NAME = 'shakib';

/** The 100 card's partner: when the lucky player holds c20 (100), c17 (85)
 *  comes along with it. */
export const PAIR_WITH_CARD = 'c20';
export const PAIR_CARD = 'c17';

/** Move wantedCard into targetId's hand, swapping out one of their cards
 *  (never one listed in avoidIds). Returns new hands; input untouched.
 *  No-op when the target already holds it or no swap is possible. */
function swapCardIntoHand(hands, targetId, wantedCard, avoidIds = []) {
  const mine = hands[targetId] || [];
  if (mine.includes(wantedCard)) return hands;
  const donorId = Object.keys(hands).find(
    (id) => id !== targetId && (hands[id] || []).includes(wantedCard),
  );
  if (!donorId) return hands;
  const myGiveIdx = mine.findIndex((c) => !avoidIds.includes(c));
  if (myGiveIdx < 0) return hands;
  const next = {};
  for (const [id, cards] of Object.entries(hands)) next[id] = [...cards];
  next[targetId][myGiveIdx] = wantedCard;
  next[donorId][next[donorId].indexOf(wantedCard)] = mine[myGiveIdx];
  return next;
}

/** Give the named player one of the top 3 cards at deal time.
 *  hands: {playerId: [cardIds]} from deal(); playersById: {id: {name}}.
 *  If the named player is present and holds no top-3 card, swap one of
 *  their cards (never the Driver c01) with a top-3 card held by another
 *  player. Pair rule: if they then hold c20 (100), c17 (85) is also
 *  swapped into their hand (never giving away the Driver or a top-3 card).
 *  Returns new hands; input untouched. No-op when the name is absent, the
 *  player already holds a top-3 card, or there is nothing to swap. */
export function ensureTopCardForName(hands, playersById, targetName = LUCKY_NAME) {
  const want = String(targetName || '').trim().toLowerCase();
  if (!want) return hands;
  const luckyId = Object.keys(hands).find((id) => {
    const p = playersById ? playersById[id] : null;
    return p && String(p.name || '').trim().toLowerCase() === want;
  });
  if (!luckyId) return hands;
  let next = hands;
  const mine = hands[luckyId] || [];
  if (!mine.some((c) => TOP_CARD_IDS.includes(c))) {
    const donorId = Object.keys(hands).find(
      (id) => id !== luckyId && (hands[id] || []).some((c) => TOP_CARD_IDS.includes(c)),
    );
    if (donorId) {
      const donorCard = hands[donorId].find((c) => TOP_CARD_IDS.includes(c));
      next = swapCardIntoHand(next, luckyId, donorCard, ['c01']);
    }
  }
  const after = next[luckyId] || [];
  if (after.includes(PAIR_WITH_CARD) && !after.includes(PAIR_CARD)) {
    next = swapCardIntoHand(next, luckyId, PAIR_CARD, ['c01', ...TOP_CARD_IDS]);
  }
  return next;
}

/** Winner of a trick: the player whose played card has the biggest TOP number.
 *  Top numbers are all distinct (5..100, egg 0), so there is never a tie. */
export function trickWinner(trick) {
  let best = null;
  for (const play of trick) {
    const top = CARD_BY_ID[play.cardId].top;
    if (!best || top > best.top) best = { playerId: play.playerId, top };
  }
  return best ? best.playerId : null;
}

/** Score of a set of won cards = sum of their BOTTOM numbers. Egg adds 0. */
export function scoreOf(cardIds) {
  return (cardIds || []).reduce((s, id) => s + CARD_BY_ID[id].bottom, 0);
}

/** Final results. players: [{id, target, won: [cardIds]}].
 *  A player "meets target" when score >= target.
 *  Winner = highest score among those who met their target,
 *  or highest score overall when nobody met it. */
export function computeResults(players) {
  const rows = players.map((p) => {
    const score = scoreOf(p.won || []);
    return { id: p.id, target: p.target ?? null, score, met: p.target != null && score >= p.target };
  });
  const met = rows.filter((r) => r.met);
  const pool = met.length ? met : rows;
  const winner = pool.reduce((a, b) => (b.score > a.score ? b : a));
  return { rows, winnerId: winner.id };
}

/** Series (running-total) scoring across matches in one room.
 *  A player who met their target adds only their TARGET to their total —
 *  scoring above the target gives no extra benefit.
 *  A player who missed it loses their TARGET from their total.
 *  Totals may go negative. */
export function seriesDelta(target, score) {
  const met = target != null && score >= target;
  return met ? target : -(target ?? 0);
}

/** Series winner: the player whose total reaches the series target.
 *  Highest total wins; a tie is broken by the higher match score. */
export function seriesWinnerId(totals, seriesTarget, matchScores = {}) {
  let best = null;
  for (const [id, total] of Object.entries(totals || {})) {
    if (total < seriesTarget) continue;
    const score = matchScores[id] ?? 0;
    if (!best || total > best.total || (total === best.total && score > best.score)) {
      best = { id, total, score };
    }
  }
  return best ? best.id : null;
}

/** English digits -> Bengali digits, for on-screen numbers. */
export function bn(n) {
  if (n === null || n === undefined) return '—';
  return String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[+d]);
}
