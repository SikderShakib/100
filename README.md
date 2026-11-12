# 100 Cards — অনলাইন কার্ড গেম

Mobile-first multiplayer card game (3–4 players), built locally Nov 12, 2026.
Rules: `../custom-cards/game-rules.md`. Build plan: `../custom-cards/game-build-plan.md`.

## Files
- `index.html` — all 5 screens (Home / Lobby / Target / Table / Result), Bengali UI.
- `assets/css/style.css` — mobile-first, green felt table, hand fan at the bottom.
- `assets/js/cards.js` — fixed card table (top = 5×n, bottom = n, egg 0/0) + pure game logic
  (incl. series scoring: `seriesDelta`, `seriesWinnerId`).
- `assets/js/app.js` — Firestore rooms, dealing, tricks, scoring, series totals, Boyz Chat.
- `manifest.json` + `sw.js` + `icons/` — PWA install (Add to Home Screen). **Bump the
  `sw.js` cache name on every deploy that changes a served file**, or phones stay
  stuck on the old code.
- `assets/js/firebase-config.js` — real config, project "100 Cards" (cards-729e0).
- `assets/cards/` — the 21 finished card PNGs (same v3 files as in Canva).

## Still to do — Firebase setup (parent agent's step, NOT done here)
1. Firebase console (sikder.touhidshakib21@gmail.com) → create a NEW project for the game.
2. Build → Firestore Database → create database (production mode, region free tier).
3. Project settings → Your apps → Web app → copy the config object.
4. Paste the values into `assets/js/firebase-config.js` (same keys, replace the TODOs).
5. Firestore Rules — paste this (friends game; anyone with a room code can play):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /rooms/{code} {
         allow read, write: if true;
       }
     }
   }
   ```
   Publish the rules.
6. **Boyz Chat (text messages) needs NO extra setup:** messages live in the room
   document itself (`rooms/{CODE}.chat`, last 20 kept) — covered by the rooms
   rules above. No Cloud Storage — the project stays on the free Spark plan.
7. Deploy: push this folder to a new GitHub repo (e.g. `SikderShakib/100Cards`) and enable
   GitHub Pages. The app must be served over HTTP(S) — opening `index.html` from
   `file://` will NOT work (ES modules + import map need a server).

## Data model (Firestore)
- `rooms/{CODE}` — `{ status, players: {id: {id, name, isHost, target, won: []}},
  order: [ids], hands: {id: [cardIds]}, currentTrick: [{playerId, cardId}],
  leader, turn, round, roundsTotal, winnerId,
  matchNo, totals: {id: number}, seriesTarget: 1000, seriesWinnerId,
  chat: [{id, playerId, name, text, createdAt}] }`
- Card ids: `c01` (driver) … `c20`, `c21` (egg). Top/bottom values from `cards.js`.

## How a game flows
1. One player creates a room (4-letter code), others join with the code + name.
2. Host starts when 3–4 players are in. Host's browser shuffles and deals
   (4 players: 20 cards, 5 each; 3 players: 21 cards incl. egg, 7 each).
3. Each player sees their own hand and inputs a target (20–160).
4. Driver card holder leads first. Biggest TOP number wins the trick;
   winner leads the next round. Score = sum of BOTTOM numbers of won cards.
5. Score >= own target counts as meeting target. Winner = highest score among
   those who met their target, or highest score overall if nobody did.
   Result screen shows the winner's name + score at the top.
6. Series: after a match, totals update (met target -> +match score, missed ->
   -target); first to a running total of 1000 wins the series, then a new
   series starts. "পরের ম্যাচ খেলুন" starts the next match in the same room.
7. Boyz Chat: during play, any player can send a text message from the table
   screen (max 200 characters); it appears for everyone in the room live
   (last 20 kept). No extra Firebase setup.
8. Invite link: the lobby has a "লিংক কপি করুন" button — the link opens the game
   with the room code pre-filled (`?room=CODE`). PWA: the game is installable
   (manifest.json + sw.js + icons) — Chrome → Add to Home Screen; the service
   worker caches the shell, but the game itself still needs internet to play.

## Known limits (v1)
- No login/accounts — anyone with the room code can join.
- If the host's browser closes mid-game, dealing/trick resolution stalls
  (the player who completes a trick resolves it via a transaction; if that
  browser is gone, the trick waits until it returns).
- No bots, no money/betting; Play again = new deal in the same room.
- Text chat: messages live in the room document (last 20 kept). The rooms rules
  are open (no login), so anyone with a room code could post a message.
- `cards.js` has no browser/Firebase dependencies and is unit-testable in Node.
