'use strict';

/**
 * RaDrop — multiplayer server.
 * Zero dependencies: serves ./public and speaks a minimal WebSocket protocol on /ws.
 *
 *   node server.js            (PORT env var optional, default 3000)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Game, GameError, botMove } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const PROTOCOL = 2; // 2: multi-card plays (cardIds), no points
const SPEED = Math.max(1, Number(process.env.RADROP_SPEED) || 1); // >1 speeds up bots (used by tests)
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 8;
const MAX_MESSAGE = 4096;
const TURN_TIMERS = [0, 30, 60]; // seconds, 0 = off
const AWAY_DELAY = 2500; // a disconnected player's turn is auto-drawn after this
const HOST_GRACE = 8000; // a disconnected host keeps the role this long (page reloads)
const FEED_LIMIT = 100;

// Limits for running on the open internet.
const EMPTY_ROOM_MS = 10 * 60 * 1000; // a room nobody is connected to is dropped after this…
const EMPTY_LOBBY_MS = 3 * 60 * 1000; // …or sooner if no game was ever dealt in it
const MAX_ROOMS = 500;
const MAX_SOCKETS = 2000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 100; // messages per connection per window; real play sends a handful
const BOT_NAMES = ['Pixel', 'Nova', 'Biscuit', 'Ziggy', 'Juniper', 'Echo', 'Waffles', 'Mochi', 'Pebble', 'Sprocket'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const COLOR_NAME = { ruby: 'Ruby', amber: 'Amber', jade: 'Jade', violet: 'Violet' };
const VALUE_NAME = { skip: 'Skip', reverse: 'Reverse', draw2: '+2', wild: 'Wild', wild4: 'Wild +4' };

const cardText = card =>
  card.color === 'wild' ? VALUE_NAME[card.value] : `${COLOR_NAME[card.color]} ${VALUE_NAME[card.value] || card.value}`;

/* ------------------------------------------------------------------ */
/* Minimal WebSocket (RFC 6455) — text frames, ping/pong, close.       */
/* ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.open = true;
    this.closed = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', chunk => this.onData(chunk));
    socket.on('end', () => this.finish());
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  onData(chunk) {
    this.alive = true;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open && this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009);
        length = Number(big);
        offset = 10;
      }
      if (!masked) return this.close(1002); // clients must mask
      if (length > MAX_MESSAGE) return this.close(1009);
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const start = offset + 4;
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) payload[i] = this.buffer[start + i] ^ mask[i & 3];
      this.buffer = this.buffer.subarray(start + length);
      this.onFrame(fin, opcode, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8:
        return this.close(1000);
      case 0x9:
        return this.sendFrame(0xa, payload);
      case 0xa:
        return undefined;
      case 0x1:
      case 0x2:
        if (this.fragments.length) return this.close(1002);
        this.fragmentOpcode = opcode;
        break;
      case 0x0:
        if (!this.fragments.length) return this.close(1002);
        break;
      default:
        return this.close(1002);
    }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE) return this.close(1009);
    if (!fin) return undefined;
    const data = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    if (this.fragmentOpcode === 0x1) this.emit('message', data.toString('utf8'));
    return undefined;
  }

  sendFrame(opcode, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.sendFrame(0x8, body);
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.finish();
  }

  terminate() {
    this.open = false;
    this.socket.destroy();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }
}

function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join(
      '\r\n'
    )
  );
  const ws = new WebSocketConnection(socket);
  if (head && head.length) ws.onData(head);
  return ws;
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const newId = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(18).toString('base64url');

function cleanText(raw, max) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

class Room {
  constructor() {
    this.code = makeCode();
    this.members = []; // seating order
    this.hostId = null;
    this.options = { stacking: true, turnTimer: 30 };
    this.phase = 'lobby'; // lobby | playing | gameOver (first to empty their hand wins; no points)
    this.game = null;
    this.round = 0;
    this.result = null;
    this.feed = [];
    this.feedSeq = 0;
    this.timer = null; // next automatic move (bot / away / out of time)
    this.hostTimer = null;
    this.catchTimers = [];
    this.catchKeys = new Set();
    this.turnDeadline = null;
    this.deadlineTurn = -1;
    this.lastActive = Date.now();
    rooms.set(this.code, this);
  }

  /* ---- membership ---- */

  member(id) {
    return this.members.find(m => m.id === id) || null;
  }

  name(id) {
    const m = this.member(id);
    return m ? m.name : 'Someone';
  }

  seatedCount() {
    return this.members.filter(m => !m.left).length;
  }

  uniqueName(name) {
    const taken = new Set(this.members.filter(m => !m.left).map(m => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  addHuman(rawName) {
    if (this.seatedCount() >= MAX_PLAYERS) throw new GameError('This room is full.');
    const m = {
      id: newId(),
      token: newToken(),
      name: this.uniqueName(cleanText(rawName, 16) || 'Player'),
      bot: false,
      left: false,
      sockets: new Set(),
      chatTimes: [],
    };
    this.members.push(m);
    if (!this.member(this.hostId)) this.hostId = m.id;
    const note = this.phase === 'playing' ? ' — dealt in next round' : '';
    this.post('system', `${m.name} joined${note}`);
    return m;
  }

  addBot() {
    if (this.seatedCount() >= MAX_PLAYERS) throw new GameError('This room is full.');
    const used = new Set(this.members.map(m => m.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || this.uniqueName('Bot');
    const m = { id: newId(), token: null, name, bot: true, left: false, sockets: new Set(), chatTimes: [] };
    this.members.push(m);
    this.post('system', `${m.name} (bot) joined`);
    return m;
  }

  attach(m, ws) {
    m.sockets.add(ws);
    this.lastActive = Date.now();
    if (this.phase === 'playing') this.schedule();
  }

  detach(m, ws) {
    if (!m || !m.sockets.delete(ws) || m.sockets.size) return;
    this.lastActive = Date.now();
    if (m.id === this.hostId) {
      clearTimeout(this.hostTimer);
      this.hostTimer = setTimeout(() => {
        this.hostTimer = null;
        if (this.ensureHost()) this.broadcast();
      }, HOST_GRACE / SPEED);
      this.hostTimer.unref();
    }
    if (this.phase === 'playing') this.schedule();
    this.broadcast();
  }

  leave(m) {
    for (const ws of m.sockets) ws.send(JSON.stringify({ t: 'left' }));
    m.sockets.clear();
    m.token = null;
    const inActiveRound = this.phase === 'playing' && !!this.game && !!this.game.player(m.id);
    if (this.phase === 'lobby') {
      this.members.splice(this.members.indexOf(m), 1);
    } else {
      m.left = true;
      if (inActiveRound) m.bot = true; // a bot finishes their hand
    }
    this.post('system', inActiveRound ? `${m.name} left — a bot plays their hand` : `${m.name} left`);
    if (!this.members.some(x => !x.bot && !x.left)) {
      this.destroy();
      return;
    }
    if (m.id === this.hostId) this.ensureHost();
    if (this.phase === 'playing') this.schedule();
    this.broadcast();
  }

  /** Make sure a present human holds the host role. Returns true if it changed. */
  ensureHost() {
    const host = this.member(this.hostId);
    if (host && !host.left && !host.bot && host.sockets.size) return false;
    const humans = this.members.filter(x => !x.bot && !x.left);
    const next = humans.find(x => x.sockets.size) || (host && !host.left && !host.bot ? null : humans[0]);
    if (!next || next.id === this.hostId) return false;
    this.hostId = next.id;
    this.post('system', `${next.name} is now the host`);
    return true;
  }

  hostPresent() {
    const host = this.member(this.hostId);
    return !!host && !host.left && host.sockets.size > 0;
  }

  purgeLeft() {
    this.members = this.members.filter(m => !m.left);
  }

  destroy() {
    this.clearTimers();
    clearTimeout(this.hostTimer);
    rooms.delete(this.code);
  }

  /* ---- feed ---- */

  post(kind, text, extra = {}) {
    this.feed.push({ id: ++this.feedSeq, kind, text, ...extra });
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
  }

  chat(m, raw) {
    const text = cleanText(raw, 200);
    if (!text) return;
    const now = Date.now();
    m.chatTimes = m.chatTimes.filter(t => now - t < 5000);
    if (m.chatTimes.length >= 5) throw new GameError('Slow down a little.');
    m.chatTimes.push(now);
    this.post('chat', text, { from: m.id, name: m.name });
    this.broadcast();
  }

  describe(e) {
    const n = this.name(e.playerId);
    switch (e.type) {
      case 'play':
        if (e.cards && e.cards.length > 1) {
          return `${n} dropped ${e.cards.length} × ${e.card.value} (${e.cards.map(c => COLOR_NAME[c.color]).join(', ')}) → ${COLOR_NAME[e.color]}`;
        }
        return `${n} played ${cardText(e.card)}${e.card.color === 'wild' ? ` → ${COLOR_NAME[e.color]}` : ''}`;
      case 'draw':
        return e.forced ? `${n} draws ${e.count}` : `${n} drew a card`;
      case 'skip':
        return `${n} is skipped`;
      case 'reverse':
        return 'Direction reversed';
      case 'stack':
        return `${n} must stack or draw ${e.amount}`;
      case 'bounce':
        return `${this.name(e.by)} bounced the +${e.amount} back to ${n} with a Reverse`;
      case 'pass':
        return `${n} passed`;
      case 'last':
        return `${n}: “Last card!”`;
      case 'caught':
        return `${this.name(e.by)} caught ${n} without a call (+${e.count})`;
      case 'win':
        return `${n} played their last card and wins!`;
      default:
        return null;
    }
  }

  /* ---- rounds ---- */

  startRound() {
    this.purgeLeft();
    if (this.members.length < 2) throw new GameError('You need at least 2 players.');
    this.clearTimers();
    this.game = new Game(
      this.members.map(m => m.id),
      { stacking: this.options.stacking }
    );
    this.round++;
    this.phase = 'playing';
    this.result = null;
    this.catchKeys = new Set();
    this.deadlineTurn = -1;
    this.post('system', `Round ${this.round} — ${this.name(this.game.current.id)} goes first`);
    this.applyEvents([]);
  }

  /** First to empty their hand wins — no points. Everyone's leftover cards are shown. */
  finishRound() {
    const g = this.game;
    this.clearTimers();
    const hands = g.players.map(p => ({ id: p.id, cards: p.hand.slice() }));
    this.phase = 'gameOver';
    this.result = { winner: g.winner, hands, round: this.round };
  }

  backToLobby() {
    this.clearTimers();
    this.purgeLeft();
    this.game = null;
    this.result = null;
    this.round = 0;
    this.phase = 'lobby';
    this.post('system', 'Back in the lobby');
  }

  clearTimers() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.catchTimers) clearTimeout(t);
    this.catchTimers = [];
    this.turnDeadline = null;
  }

  /* ---- actions ---- */

  handle(m, msg) {
    this.lastActive = Date.now();
    const isHost = m.id === this.hostId;
    const requireHost = () => {
      if (!isHost) throw new GameError('Only the host can do that.');
    };
    const requireLobby = () => {
      if (this.phase !== 'lobby') throw new GameError('That can only be changed in the lobby.');
    };

    switch (msg.t) {
      case 'chat':
        return this.chat(m, msg.text);

      case 'addBot':
        requireHost();
        requireLobby();
        this.addBot();
        return this.broadcast();

      case 'removeBot': {
        requireHost();
        requireLobby();
        const bot = this.member(msg.id);
        if (!bot || !bot.bot) throw new GameError('That player is not a bot.');
        this.members.splice(this.members.indexOf(bot), 1);
        this.post('system', `${bot.name} (bot) left`);
        return this.broadcast();
      }

      case 'settings': {
        requireHost();
        requireLobby();
        if (typeof msg.stacking === 'boolean') this.options.stacking = msg.stacking;
        if (TURN_TIMERS.includes(Number(msg.turnTimer))) this.options.turnTimer = Number(msg.turnTimer);
        return this.broadcast();
      }

      case 'start':
        requireHost();
        requireLobby();
        return this.startRound();

      case 'next': // play again with the same table
        if (this.phase !== 'gameOver') throw new GameError('Finish this game first.');
        if (!isHost && this.hostPresent()) throw new GameError('Waiting for the host.');
        return this.startRound();

      case 'lobby':
        if (this.phase !== 'gameOver') throw new GameError('Finish this game first.');
        if (!isHost && this.hostPresent()) throw new GameError('Waiting for the host.');
        this.backToLobby();
        return this.broadcast();

      case 'play':
      case 'draw':
      case 'pass':
      case 'last':
      case 'catch':
        return this.gameAction(m, msg);

      default:
        throw new GameError('Unknown action.');
    }
  }

  gameAction(m, msg) {
    const g = this.game;
    if (this.phase !== 'playing' || !g) throw new GameError('No round in progress.');
    if (m.left || !g.player(m.id)) throw new GameError("You'll be dealt in next round.");
    let events;
    switch (msg.t) {
      case 'play':
        {
          const ids = Array.isArray(msg.cardIds) ? msg.cardIds.slice(0, 12) : [msg.cardId];
          events = g.play(m.id, ids.map(Number), msg.color);
        }
        break;
      case 'draw':
        events = g.draw(m.id);
        break;
      case 'pass':
        events = g.pass(m.id);
        break;
      case 'last':
        events = g.callLast(m.id);
        break;
      case 'catch':
        events = g.catchPlayer(m.id, String(msg.target));
        break;
      default:
        events = [];
    }
    this.applyEvents(events);
  }

  applyEvents(events) {
    for (const e of events) {
      const text = this.describe(e);
      if (text) this.post('event', text, { type: e.type });
    }
    if (this.phase === 'playing' && this.game.over) {
      this.finishRound();
    } else if (this.phase === 'playing') {
      this.planCatches();
      this.schedule();
    }
    this.broadcast(events);
  }

  /** Queue the next automatic move: a bot's turn, an absent player, or an expired turn timer. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const g = this.game;
    if (this.phase !== 'playing' || !g || g.over) return;

    if (g.turnId !== this.deadlineTurn) {
      this.deadlineTurn = g.turnId;
      this.turnDeadline = this.options.turnTimer ? Date.now() + this.options.turnTimer * 1000 : null;
    }

    // Nobody is watching: pause instead of letting bots play on.
    if (!this.members.some(m => !m.bot && m.sockets.size)) return;

    const cur = this.member(g.current.id);
    let delay;
    let mode;
    if (cur.bot) {
      mode = 'bot';
      delay = (650 + Math.random() * 650 + (g.drawnCardId !== null ? 250 : 0)) / SPEED;
    } else if (!cur.sockets.size) {
      mode = 'away';
      delay = AWAY_DELAY / SPEED;
    } else if (this.turnDeadline) {
      mode = 'timeout';
      delay = Math.max(0, this.turnDeadline - Date.now());
    } else {
      return;
    }

    const turnId = g.turnId;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.game !== g || g.over || g.turnId !== turnId || g.current.id !== cur.id) return;
      this.autoMove(cur, mode);
    }, delay);
  }

  autoMove(m, mode) {
    const g = this.game;
    const events = [];
    try {
      // Bots, absent players and expired turns are all played by the bot logic. (Just drawing for
      // an absent player let them hoard the whole deck until nobody could move.)
      if (mode === 'timeout' && this.timedOutTurn !== g.turnId) {
        this.timedOutTurn = g.turnId; // a draw-then-play counts as one timeout
        this.post('system', `${m.name} ran out of time — autopilot played for them`);
      }
      if (mode === 'bot') {
        const careless = g.players.find(p => p.vulnerable && p.id !== m.id);
        if (careless && Math.random() < 0.6) events.push(...g.catchPlayer(m.id, careless.id));
      }
      const move = botMove(g, m.id);
      if (move.action === 'play') {
        if (move.callLast) events.push(...g.callLast(m.id));
        events.push(...g.play(m.id, move.cardIds, move.color));
      } else if (move.action === 'draw') {
        events.push(...g.draw(m.id));
      } else {
        events.push(...g.pass(m.id));
      }
    } catch (err) {
      console.error(`[${this.code}] automatic move failed:`, err);
      try {
        if (g.current.id === m.id) events.push(...(g.drawnCardId !== null ? g.pass(m.id) : g.draw(m.id)));
      } catch (err2) {
        console.error(`[${this.code}] fallback move failed:`, err2);
      }
    }
    this.applyEvents(events);
  }

  /** Bots that aren't on turn may notice a forgotten last-card call. */
  planCatches() {
    const g = this.game;
    for (const p of g.players) {
      if (!p.vulnerable) continue;
      const key = `${g.turnId}:${p.id}`;
      if (this.catchKeys.has(key)) continue;
      this.catchKeys.add(key);
      const hunters = this.members.filter(b => b.bot && b.id !== p.id && b.id !== g.current.id && g.player(b.id));
      for (const b of hunters) {
        if (Math.random() > 0.35) continue;
        const t = setTimeout(() => {
          if (this.game !== g || g.over || !g.player(p.id).vulnerable) return;
          try {
            this.applyEvents(g.catchPlayer(b.id, p.id));
          } catch {
            /* the window closed */
          }
        }, (1200 + Math.random() * 1800) / SPEED);
        this.catchTimers.push(t);
      }
    }
  }

  /* ---- views ---- */

  view(forId) {
    const g = this.game;
    const players = this.members.map(m => {
      const gp = g ? g.player(m.id) : null;
      return {
        id: m.id,
        name: m.name,
        bot: m.bot,
        left: m.left,
        connected: m.bot || m.sockets.size > 0,
        inRound: !!gp,
        count: gp ? gp.hand.length : 0,
        saidLast: !!gp && gp.saidLast,
        vulnerable: !!gp && gp.vulnerable && !g.over,
      };
    });
    const state = {
      code: this.code,
      you: forId,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      options: this.options,
      maxPlayers: MAX_PLAYERS,
      players,
      feed: this.feed.slice(-60),
      result: this.result,
      game: null,
    };
    if (g) {
      const gp = g.player(forId);
      const myTurn = !g.over && g.current.id === forId;
      state.game = {
        top: g.top,
        color: g.currentColor,
        direction: g.direction,
        turn: g.over ? null : g.current.id,
        turnId: g.turnId,
        pendingDraw: g.pendingDraw,
        pendingKind: g.pendingKind,
        deck: g.deck.length,
        order: g.players.map(p => p.id),
        hand: gp ? gp.hand : null,
        playable: g.playableIds(forId),
        drawnCardId: myTurn ? g.drawnCardId : null,
        canDraw: myTurn && (g.drawnCardId === null || g.pendingDraw > 0),
        canPass: myTurn && g.drawnCardId !== null && g.pendingDraw === 0,
        canCallLast: g.canCallLast(forId),
        turnEndsIn: this.turnDeadline && !g.over ? Math.max(0, this.turnDeadline - Date.now()) : null,
        turnSeconds: this.options.turnTimer,
      };
    }
    return state;
  }

  broadcast(events = []) {
    for (const m of this.members) {
      if (!m.sockets.size) continue;
      const data = JSON.stringify({ t: 'state', state: this.view(m.id), events });
      for (const ws of m.sockets) ws.send(data);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

const sockets = new Set();

/** Drop rooms that nobody is connected to any more. */
function sweepRooms(now = Date.now()) {
  for (const r of rooms.values()) {
    if (r.members.some(m => m.sockets.size)) continue;
    if (now - r.lastActive > (r.round === 0 ? EMPTY_LOBBY_MS : EMPTY_ROOM_MS)) r.destroy();
  }
}

function handleConnection(ws) {
  if (sockets.size >= MAX_SOCKETS) {
    ws.close(1013); // try again later
    return;
  }
  sockets.add(ws);
  let room = null;
  let me = null;
  let windowStart = Date.now();
  let messages = 0;
  const reply = obj => ws.send(JSON.stringify(obj));
  // Lets the page know it reached the real game server, and which protocol it speaks.
  // Bump PROTOCOL whenever the client and server must change together.
  reply({ t: 'hello', app: 'chroma', version: PROTOCOL });

  const attach = (r, m) => {
    room = r;
    me = m;
    r.attach(m, ws);
    reply({ t: 'joined', code: r.code, id: m.id, token: m.token });
    r.broadcast();
  };

  ws.on('message', text => {
    const now = Date.now();
    if (now - windowStart > RATE_WINDOW_MS) {
      windowStart = now;
      messages = 0;
    }
    if (++messages > RATE_MAX) {
      ws.close(1008); // flooding
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    try {
      switch (msg.t) {
        case 'create':
        case 'join':
        case 'resume': {
          if (room) {
            const old = room;
            const oldMe = me;
            old.detach(oldMe, ws);
            // Hopping away from a lobby you're alone in: don't leave the empty room behind.
            const humans = old.members.filter(x => !x.bot && !x.left);
            if (old.phase === 'lobby' && humans.length === 1 && humans[0] === oldMe && !oldMe.sockets.size) old.leave(oldMe);
          }
          room = me = null;
          const code = String(msg.code || '').trim().toUpperCase();
          if (msg.t === 'create') {
            if (rooms.size >= MAX_ROOMS) sweepRooms();
            if (rooms.size >= MAX_ROOMS) throw new GameError('The server is full right now — please try again in a few minutes.');
            const r = new Room();
            attach(r, r.addHuman(msg.name));
          } else if (msg.t === 'join') {
            const r = rooms.get(code);
            if (!r) throw new GameError(`There's no room with the code ${code || '—'}.`);
            attach(r, r.addHuman(msg.name));
          } else {
            const r = rooms.get(code);
            const m = r && typeof msg.token === 'string' ? r.members.find(x => x.token && x.token === msg.token) : null;
            if (!m) reply({ t: 'error', code: 'gone', message: 'That room has closed.' });
            else attach(r, m);
          }
          return;
        }

        case 'leave': {
          if (room && !me.left && room.members.includes(me)) {
            const r = room;
            const m = me;
            room = me = null;
            r.leave(m);
          } else {
            room = me = null;
            reply({ t: 'left' });
          }
          return;
        }

        default:
          if (!room || me.left || !room.members.includes(me) || !rooms.has(room.code)) {
            room = me = null;
            throw new GameError('Join a room first.');
          }
          room.handle(me, msg);
      }
    } catch (err) {
      if (err instanceof GameError) {
        reply({ t: 'error', message: err.message });
      } else {
        console.error(err);
        reply({ t: 'error', message: 'Something went wrong on the server.' });
      }
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    if (room) room.detach(me, ws);
    room = me = null;
  });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: sockets.size }));
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const headers = {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (file.endsWith('.html')) {
      headers['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    /* fall through */
  }
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const ws = acceptWebSocket(req, socket, head);
  if (ws) handleConnection(ws);
});

// Drop dead connections.
setInterval(() => {
  for (const ws of sockets) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();

// Forget rooms nobody is connected to.
setInterval(() => sweepRooms(), 30_000).unref();

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  require('child_process').exec(cmd, () => {});
}

if (require.main === module) {
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} is already in use — RaDrop may already be running.`);
      console.error(`Open http://localhost:${PORT} in your browser, or pick another port:  set PORT=3001 && node server.js\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\nRaDrop is running — open ${url} in your browser.`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`  friends on your Wi-Fi can use: http://${net.address}:${PORT}`);
      }
    }
    console.log('Keep this window open while you play. Press Ctrl+C to stop.\n');
    if (process.env.RADROP_OPEN) openBrowser(url);
  });
}

module.exports = { server, rooms };
