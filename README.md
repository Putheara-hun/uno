# RaDrop

A color-matching card game for 2–8 players in the browser. Play with friends on the same network, fill empty seats with bots, or both.

No dependencies: Node.js is all you need.

## Run it

**Windows:** double-click `start.cmd`. It starts the game server and opens <http://localhost:3000>. Keep that window open while you play.

**Any OS:**

```sh
npm start          # or: node server.js
```

Then open <http://localhost:3000>, pick a name and **Create a room**. Share the 4-letter code or the invite link. The server prints your LAN address so people on the same Wi-Fi can join. To change the port, set `PORT` (for example `set PORT=3001` on Windows, then `npm start`).

## Play online (free hosting on Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Putheara-hun/uno)

1. Click the button above and sign in to Render with your GitHub account. It's free and needs no card.
2. Render reads `render.yaml` and proposes a free web service called **radrop**. Click **Apply** / **Deploy**.
3. After a minute or two you get an address like `https://radrop.onrender.com`. Share it: anyone can open it from any phone or computer, create a room, and invite friends with the room code.

Every time the GitHub repo is updated, Render redeploys automatically.

Good to know about the free plan:
- If nobody has used the game for about 15 minutes, Render puts it to sleep. The next visitor waits 30–60 seconds while it wakes up, and then it's fast again.
- Rooms live in the server's memory, so a sleep or redeploy ends any games in progress. Just create a new room.

> Don't open `public/index.html` directly, or through an editor preview such as Live Server. The game needs `server.js` running and must be loaded from it. If the page can't reach the server, it says so.

## How to play

- Match the top card's **color** or its **number/symbol**. Wilds go on anything and you pick the next color.
- **Action cards combine too.** Several of the same symbol (Skips, Reverses or +2s, any colors), or any mix of Skip, Reverse and +2 in one color, can go down together. Each kind works: Reverses flip play (once), Skips jump the next player (once), and every +2 counts against the player after that (two +2s = +4). You pick the color. When a +2 is coming at you, only +2s can be combined. Tapping a card offers both **Drop the set** and **Play just this one**.
- **Same numbers go down together.** If you hold several cards with the same number, you can drop them all at once, whatever their colors, as long as one of them matches the pile. Then you choose which of those colors carries on. Tap one of the numbers and all your matching cards get selected. Tap any of them to leave it out, then press **Drop**.
- Can't or don't want to play? **Draw** one card. If it fits you may play it right away (its matching numbers can go with it), otherwise your turn ends.
- **Skip** jumps the next player and **Reverse** flips direction (with two players it acts as a Skip). **+2** and **Wild +4** make the next player draw and lose their turn.
- About to go down to one card? Press **Last card!** before or right after you play. If anyone hits **Catch!** first, you draw 2.
- **The first player to get rid of every card wins.** There are no points; press **Play again** for the next game.

Table rules (host, in the lobby):

| Option     | Choices         | Notes |
|------------|-----------------|-------|
| Stacking   | on (default) / off | Answer a +2 with a +2 of any color (or a +4) to pass the growing penalty on, or bounce it back to its sender with a Reverse of the same color. A +4 only takes a +4. |
| Turn timer | off, 30 s (default), 60 s | A countdown shows the seconds left (red for the last 5). At zero, autopilot plays your turn: it drops the best card it can, or draws. |

Keyboard: `D` draw · `P` pass · `L` last card · `Esc` cancel a selection · `Enter` chat · `1`–`4` pick a color.

## How it behaves

- **Reconnecting:** a page reload or a dropped connection puts you back in your seat (the session lives in that tab).
- **Away players:** if someone disconnects mid-game, autopilot plays their turns until they return. If nobody human is connected, the table pauses.
- **Leaving:** a bot finishes your hand for the current round. The host role passes to another connected player.
- **Late joiners** watch the current game and are dealt into the next one.
- Rooms are kept in memory and forgotten after 30 idle minutes, or when the server restarts.

## Project layout

```
game.js           rules engine (pure, no I/O) + bot strategy
server.js         HTTP static server, minimal WebSocket server, rooms, bots, autopilot
public/           browser client (index.html, style.css, app.js)
public/img/       card artwork, 52 faces + 2 wilds + back (SVG)
tools/make-cards.js   draws the card artwork; run `npm run cards` after changing it
test/             node:test suites — engine rules and server integration
```

## Tests

```sh
npm test
```

The integration tests use the built-in `WebSocket` client, so they need Node 22+. The server itself runs on Node 18+.
