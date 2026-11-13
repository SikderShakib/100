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
