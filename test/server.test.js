'use strict';

// Integration tests: real HTTP + WebSocket clients against the server. Needs Node 22+ (global WebSocket).
process.env.RADROP_SPEED = '40';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { server, rooms } = require('../server');

let port;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => {
  for (const r of rooms.values()) r.destroy();
  server.close();
});

class Client {
  constructor() {
    this.state = null;
    this.errors = [];
    this.waiters = [];
    this.autoplay = false;
  }

  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.onmessage = e => this.onMessage(JSON.parse(e.data));
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    return this;
  }

  onMessage(msg) {
    if (msg.t === 'hello') this.hello = msg;
    if (msg.t === 'state') this.state = msg.state;
    if (msg.t === 'joined') this.joined = msg;
    if (msg.t === 'error') this.errors.push(msg.message);
    this.waiters = this.waiters.filter(w => {
      if (!w.pred(msg, this.state)) return true;
      w.resolve(msg);
      return false;
    });
    if (this.autoplay && msg.t === 'state') this.play();
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(pred, ms = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; last phase: ${this.state && this.state.phase}`)), ms);
      this.waiters.push({
        pred,
        resolve: m => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  waitState(pred, ms) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return this.waitFor((m, s) => m.t === 'state' && pred(s), ms).then(() => this.state);
  }

  /** Simple autopilot: call last card, play the first legal card, else pass/draw. */
  play() {
    const s = this.state;
    const g = s.game;
    if (s.phase !== 'playing' || !g || g.turn !== s.you) return;
    if (g.canCallLast && g.hand.length === 2) return this.send({ t: 'last' });
    if (g.playable.length) {
      const card = g.hand.find(c => c.id === g.playable[0]);
      if (card.color === 'wild') return this.send({ t: 'play', cardIds: [card.id], color: 'jade' });
      // Drop every card with the same number together, like a player would.
      const same = /^[0-9]$/.test(card.value) ? g.hand.filter(c => c.value === card.value) : [card];
      if (same.length > 1) this.multiDrops = (this.multiDrops || 0) + 1;
      return this.send({ t: 'play', cardIds: same.map(c => c.id), color: same[same.length - 1].color });
    }
    if (g.canPass) return this.send({ t: 'pass' });
    if (g.canDraw) return this.send({ t: 'draw' });
    return undefined;
  }

  close() {
    const closed = new Promise(resolve => {
      this.ws.onclose = resolve;
    });
    this.ws.close();
    return closed;
  }
}

async function host(name = 'Alice') {
  const c = await new Client().open();
  c.send({ t: 'create', name });
  await c.waitState(s => s.phase === 'lobby');
  return c;
}

test('serves the client and refuses paths outside public/', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>RaDrop<\/title>/);
  const css = await fetch(`http://127.0.0.1:${port}/style.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  for (const sneaky of ['/..%2fserver.js', '/%2e%2e/game.js', '/..%5cserver.js']) {
    const r = await fetch(`http://127.0.0.1:${port}${sneaky}`);
    assert.notEqual(r.status, 200, sneaky);
    assert.doesNotMatch(await r.text(), /require\(/, sneaky);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status, 405);
});

test('lobby: bots, settings, permissions and bad codes', async () => {
  const a = await host();
  assert.equal(a.hello && a.hello.app, 'chroma', 'server greets each connection');
  const clientProtocol = Number(/const PROTOCOL = (\d+)/.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8'))[1]);
  assert.equal(a.hello.version, clientProtocol, 'client and server agree on the protocol version');
  assert.equal(a.state.hostId, a.state.you);
  a.send({ t: 'addBot' });
  await a.waitState(s => s.players.length === 2 && s.players[1].bot);

  const b = await new Client().open();
  b.send({ t: 'join', code: 'ZZZZ', name: 'Bob' });
  await b.waitFor(m => m.t === 'error');
  assert.match(b.errors[0], /no room/i);

  b.send({ t: 'join', code: a.state.code.toLowerCase(), name: 'alice' });
  await b.waitState(s => s.phase === 'lobby');
  assert.equal(b.state.players.find(p => p.id === b.state.you).name, 'alice 2', 'duplicate names get a suffix');

  b.send({ t: 'start' });
  await b.waitFor(m => m.t === 'error');
  assert.match(b.errors.at(-1), /host/i);

  a.send({ t: 'settings', stacking: true, turnTimer: 30 });
  await b.waitState(s => s.options.stacking && s.options.turnTimer === 30);
  assert.equal(b.state.options.target, undefined, 'there is no score target any more');
  a.send({ t: 'settings', turnTimer: 12345 });
  await a.waitState(s => s.options.turnTimer === 30);

  const botId = a.state.players.find(p => p.bot).id;
  a.send({ t: 'removeBot', id: botId });
  await b.waitState(s => !s.players.some(p => p.bot));

  b.send({ t: 'leave' });
  await b.waitFor(m => m.t === 'left');
  await a.waitState(s => s.players.length === 1);
  await Promise.all([a.close(), b.close()]);
});

test('a full single round against two bots, with a spectator who reconnects and leaves', async () => {
  const a = await host();
  a.send({ t: 'addBot' });
  a.send({ t: 'addBot' });
  await a.waitState(s => s.players.length === 3);
  a.send({ t: 'settings', stacking: true, turnTimer: 0 });
  await a.waitState(s => s.options.stacking);

  a.autoplay = true;
  a.send({ t: 'start' });
  await a.waitState(s => s.phase === 'playing');
  assert.equal(a.state.game.hand.length, 7);
  assert.equal(a.state.game.order.length, 3);

  // Someone joins mid-round: they watch and wait for the next deal.
  const b = await new Client().open();
  b.send({ t: 'join', code: a.state.code, name: 'Bob' });
  await b.waitState(s => s.phase === 'playing');
  assert.equal(b.state.game.hand, null);
  assert.equal(b.state.players.find(p => p.id === b.state.you).inRound, false);
  b.send({ t: 'draw' });
  await b.waitFor(m => m.t === 'error');

  // Reconnect with the session token.
  const { code, token } = b.joined;
  await b.close();
  const b2 = await new Client().open();
  b2.send({ t: 'resume', code, token });
  await b2.waitState(s => s.code === code);
  assert.equal(b2.state.you, b.state.you);

  const bad = await new Client().open();
  bad.send({ t: 'resume', code, token: 'nope' });
  const gone = await bad.waitFor(m => m.t === 'error');
  assert.equal(gone.code, 'gone');
  await bad.close();

  // First to empty their hand wins outright — no points anywhere.
  const end = await a.waitState(s => s.phase === 'gameOver', 60000);
  const r = end.result;
  assert.equal(r.hands.length, 3);
  assert.equal(r.hands.find(h => h.id === r.winner).cards.length, 0);
  assert.equal(r.points, undefined);
  assert.ok(end.players.every(p => p.score === undefined));
  assert.ok(!a.errors.some(e => /went wrong|same number|match/.test(e)), `no rejected plays: ${a.errors.join('; ')}`);
  const room = rooms.get(end.code);
  assert.ok(room.feed.some(f => /wins!/.test(f.text)));

  // The spectator is dealt in when the host plays again.
  a.autoplay = false;
  a.send({ t: 'next' });
  const again = await b2.waitState(s => s.phase === 'playing' && s.round === 2);
  assert.equal(again.game.hand.length, 7);
  assert.equal(again.game.order.length, 4);

  // Spectator leaves mid-game: a bot finishes their hand; back in the lobby they are gone.
  b2.send({ t: 'leave' });
  await b2.waitFor(m => m.t === 'left');
  a.autoplay = true;
  a.play();
  await a.waitState(s => s.phase === 'gameOver', 60000);
  a.autoplay = false;
  a.send({ t: 'lobby' });
  const lobby = await a.waitState(s => s.phase === 'lobby');
  assert.equal(lobby.players.length, 3);
  await Promise.all([a.close(), b2.close()]);
});

test('two humans: an absent player is played by autopilot, and the host role moves on', async () => {
  const a = await host();
  const b = await new Client().open();
  b.send({ t: 'join', code: a.state.code, name: 'Bob' });
  await b.waitState(s => s.players.length === 2);
  a.send({ t: 'start' });
  await b.waitState(s => s.phase === 'playing');

  // Bob drops out; Alice keeps playing and Bob's turns are taken automatically.
  const bobId = b.state.you;
  await b.close();
  await a.waitState(s => !s.players.find(p => p.id === bobId).connected);
  a.autoplay = true;
  a.play();
  const end = await a.waitState(s => s.phase === 'gameOver', 60000);
  assert.ok(end.result);

  // Alice drops; Bob comes back and is promoted to host.
  const { code, token } = b.joined;
  const b2 = await new Client().open();
  b2.send({ t: 'resume', code, token });
  await b2.waitState(s => s.you === bobId);
  await a.close();
  await b2.waitState(s => s.hostId === bobId, 3000);
  b2.send({ t: 'lobby' });
  await b2.waitState(s => s.phase === 'lobby');
  await b2.close();
});

test('the turn timer lets autopilot move for an idle player', async () => {
  const a = await host();
  a.send({ t: 'addBot' });
  await a.waitState(s => s.players.length === 2);
  const room = rooms.get(a.state.code);
  a.send({ t: 'start' });
  await a.waitState(s => s.phase === 'playing');
  // Force a tiny timer directly on the room (the UI only offers 30/60s).
  room.options.turnTimer = 0.05;
  room.deadlineTurn = -1;
  room.schedule();
  // Bots can chain several turns (skips, reverses), so wait for the timeout itself rather than a turn count.
  const timedOut = () => room.feed.some(f => /ran out of time/.test(f.text));
  try {
    await a.waitState(s => s.phase !== 'playing' || timedOut(), 10000);
    assert.ok(timedOut() || a.state.phase !== 'playing');
  } finally {
    await a.close();
  }
});

/* ---- limits for the open internet ---- */

test('a connection that floods the server is cut off', async () => {
  const c = await new Client().open();
  const closed = new Promise(resolve => {
    c.ws.onclose = e => resolve(e.code);
  });
  for (let i = 0; i < 150; i++) c.send({ t: 'chat', text: `spam ${i}` });
  assert.equal(await closed, 1008);
});

test('hopping to a new room does not leave your empty lobby behind', async () => {
  const c = await host();
  const first = c.state.code;
  c.send({ t: 'create', name: 'Alice' });
  await c.waitState(s => s.code !== first);
  assert.equal(rooms.has(first), false);
  assert.equal(rooms.has(c.state.code), true);
  await c.close();
});

test('pages are served with a content security policy', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
});


function rawConnect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      sock.off('data', onData);
      resolve({ sock, key, head: buf.subarray(0, i).toString(), rest: buf.subarray(i + 4) });
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

function frame(opcode, payload, { fin = true, mask = true } = {}) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | len]);
  else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const key = crypto.randomBytes(4);
  const body = Buffer.from(payload.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([header, key, body]);
}

function readFrames(sock, initial, until) {
  return new Promise((resolve, reject) => {
    let buf = initial;
    const frames = [];
    const timer = setTimeout(() => reject(new Error('no frames')), 3000);
    const parse = () => {
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + len) return;
        frames.push({ opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len) });
        buf = buf.subarray(off + len);
      }
    };
    const check = () => {
      parse();
      if (until(frames)) {
        clearTimeout(timer);
        sock.off('data', onData);
        resolve(frames);
      }
    };
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      check();
    };
    sock.on('data', onData);
    sock.on('close', () => {
      clearTimeout(timer);
      parse();
      resolve(frames);
    });
    check();
  });
}

test('websocket: handshake, fragmented message, ping', async () => {
  const { sock, key, head, rest } = await rawConnect();
  assert.match(head, /^HTTP\/1\.1 101/);
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  assert.ok(head.includes(`Sec-WebSocket-Accept: ${accept}`));

  const msg = Buffer.from(JSON.stringify({ t: 'create', name: 'Raw' }));
  sock.write(frame(0x1, msg.subarray(0, 5), { fin: false }));
  sock.write(frame(0x9, Buffer.from('hi'))); // control frame between fragments
  sock.write(frame(0x0, msg.subarray(5)));
  const frames = await readFrames(sock, rest, fs => fs.some(f => f.opcode === 0x1 && /"joined"/.test(f.payload)) && fs.some(f => f.opcode === 0xa));
  assert.equal(frames.find(f => f.opcode === 0xa).payload.toString(), 'hi');
  sock.write(frame(0x8, Buffer.from([0x03, 0xe8])));
  await new Promise(resolve => sock.on('close', resolve));
});

test('websocket: unmasked and oversized frames are rejected', async () => {
  const one = await rawConnect();
  one.sock.write(frame(0x1, Buffer.from('{"t":"chat"}'), { mask: false }));
  const f1 = await readFrames(one.sock, one.rest, fs => fs.some(f => f.opcode === 0x8));
  assert.equal(f1.find(f => f.opcode === 0x8).payload.readUInt16BE(0), 1002);
  one.sock.destroy();

  const two = await rawConnect();
  two.sock.write(frame(0x1, Buffer.alloc(10000, 0x20)));
  const f2 = await readFrames(two.sock, two.rest, fs => fs.some(f => f.opcode === 0x8));
  assert.equal(f2.find(f => f.opcode === 0x8).payload.readUInt16BE(0), 1009);
  two.sock.destroy();
});
