'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError, botMove, buildDeck, COLORS, DECK_SIZE } = require('../game');

function applyMove(game, id, move) {
  if (move.action === 'play') {
    if (move.callLast) game.callLast(id);
    return game.play(id, move.cardIds, move.color);
  }
  if (move.action === 'draw') return game.draw(id);
  return game.pass(id);
}

function simulate(players, options, maxSteps = 5000) {
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  const game = new Game(ids, options);
  let steps = 0;
  while (!game.over && steps < maxSteps) {
    const id = game.current.id;
    applyMove(game, id, botMove(game, id));
    assert.equal(game.cardCount(), DECK_SIZE, 'cards must be conserved');
    assert.ok(COLORS.includes(game.currentColor), 'current color must be a real color');
    steps++;
  }
  return { game, steps };
}

test('deck has the right composition', () => {
  const deck = buildDeck();
  assert.equal(deck.length, DECK_SIZE);
  assert.equal(new Set(deck.map(c => c.id)).size, DECK_SIZE);
  assert.equal(deck.filter(c => c.color === 'wild').length, 8);
  for (const color of COLORS) assert.equal(deck.filter(c => c.color === color).length, 25);
});


test('deal: 7 cards each, number card on top', () => {
  for (let i = 0; i < 50; i++) {
    const g = new Game(['a', 'b', 'c']);
    for (const p of g.players) assert.equal(p.hand.length, 7);
    assert.match(g.top.value, /^[0-9]$/);
    assert.equal(g.cardCount(), DECK_SIZE);
  }
});

test('bot-only games finish and conserve cards (no stacking)', () => {
  for (let n = 2; n <= 8; n++) {
    for (let i = 0; i < 60; i++) {
      const { game } = simulate(n, {});
      assert.ok(game.over, `game with ${n} players should finish`);
      assert.equal(game.player(game.winner).hand.length, 0);
    }
  }
});

test('bot-only games finish and conserve cards (stacking)', () => {
  for (let n = 2; n <= 8; n++) {
    for (let i = 0; i < 60; i++) {
      const { game } = simulate(n, { stacking: true });
      assert.ok(game.over, `game with ${n} players should finish`);
      assert.equal(game.pendingDraw, 0);
    }
  }
});

test('turn and match errors', () => {
  const g = new Game(['a', 'b']);
  const other = g.players.find(p => p.id !== g.current.id);
  assert.throws(() => g.draw(other.id), GameError);
  assert.throws(() => g.pass(g.current.id), GameError);
  assert.throws(() => g.play(g.current.id, 9999), GameError);
});

test('forgotten last card can be caught until the next player acts', () => {
  const g = new Game(['a', 'b', 'c']);
  g.turn = 0;
  const a = g.players[0];
  const top = g.top;
  a.hand = [
    { id: 1001, color: top.color, value: top.value === '5' ? '6' : '5' },
    { id: 1002, color: 'ruby', value: '3' },
  ];
  g.play('a', 1001);
  assert.equal(a.vulnerable, true);
  const evts = g.catchPlayer('c', 'a');
  assert.equal(evts[0].type, 'caught');
  assert.equal(a.hand.length, 3);
  assert.throws(() => g.catchPlayer('c', 'a'), GameError);
});

test('calling last card before playing protects you', () => {
  const g = new Game(['a', 'b']);
  g.turn = 0;
  const a = g.players[0];
  a.hand = [
    { id: 1001, color: 'wild', value: 'wild' },
    { id: 1002, color: 'ruby', value: '3' },
  ];
  g.callLast('a');
  g.play('a', 1001, 'jade');
  assert.equal(a.vulnerable, false);
  assert.equal(g.currentColor, 'jade');
  assert.throws(() => g.catchPlayer('b', 'a'), GameError);
});

test('vulnerability ends when the next player acts', () => {
  const g = new Game(['a', 'b']);
  g.turn = 0;
  const a = g.players[0];
  a.hand = [
    { id: 1001, color: 'wild', value: 'wild' },
    { id: 1002, color: 'ruby', value: '3' },
  ];
  g.play('a', 1001, 'jade');
  assert.equal(a.vulnerable, true);
  g.draw('b');
  assert.equal(a.vulnerable, false);
});

test('stacking passes the penalty along and the taker draws it all', () => {
  const g = new Game(['a', 'b', 'c'], { stacking: true });
  g.turn = 0;
  g.direction = 1;
  g.currentColor = 'ruby';
  g.players[0].hand.push({ id: 2001, color: 'ruby', value: 'draw2' });
  g.players[1].hand.push({ id: 2002, color: 'jade', value: 'draw2' });
  g.play('a', 2001);
  assert.equal(g.pendingDraw, 2);
  assert.equal(g.current.id, 'b');
  g.play('b', 2002);
  assert.equal(g.pendingDraw, 4);
  assert.equal(g.current.id, 'c');
  const before = g.players[2].hand.length;
  g.draw('c');
  assert.equal(g.players[2].hand.length, before + 4);
  assert.equal(g.pendingDraw, 0);
  assert.equal(g.current.id, 'a');
});

/* ---- stacking: any-color +2, and the same-color Reverse bounce ---- */

function stackGame(ids, hands) {
  const g = new Game(ids, { stacking: true });
  g.turn = 0;
  g.direction = 1;
  g.discard.push({ id: 800, color: 'amber', value: '5' });
  g.currentColor = 'amber';
  g.players.forEach((p, i) => (p.hand = hands[i].concat([{ id: 700 + i, color: 'jade', value: '1' }, { id: 710 + i, color: 'jade', value: '8' }])));
  return g;
}

test('a +2 of a different color stacks on a +2 and the penalty moves on', () => {
  const g = stackGame(['a', 'b', 'c'], [[{ id: 1, color: 'amber', value: 'draw2' }], [{ id: 2, color: 'violet', value: 'draw2' }], []]);
  g.play('a', 1);
  assert.equal(g.current.id, 'b');
  assert.deepEqual(g.playableIds('b'), [2], 'violet +2 answers an amber +2');
  g.play('b', 2);
  assert.equal(g.current.id, 'c');
  assert.equal(g.pendingDraw, 4);
  const before = g.player('c').hand.length;
  g.draw('c');
  assert.equal(g.player('c').hand.length, before + 4);
});

test('a same-color Reverse bounces a +2 back to whoever played it', () => {
  const g = stackGame(
    ['a', 'b', 'c'],
    [[{ id: 1, color: 'amber', value: 'draw2' }], [{ id: 2, color: 'amber', value: 'reverse' }, { id: 3, color: 'jade', value: 'reverse' }], []]
  );
  g.play('a', 1);
  assert.deepEqual(g.playableIds('b').sort(), [2], 'only the amber Reverse can answer');
  assert.throws(() => g.play('b', 3), GameError, 'a jade Reverse cannot bounce an amber +2');
  const events = g.play('b', 2);
  assert.ok(events.some(e => e.type === 'bounce' && e.playerId === 'a' && e.amount === 2));
  assert.equal(g.current.id, 'a', 'back to the sender');
  assert.equal(g.pendingDraw, 2);
  assert.equal(g.direction, -1);
  const before = g.player('a').hand.length;
  g.draw('a');
  assert.equal(g.player('a').hand.length, before + 2);
  assert.equal(g.current.id, 'c', 'play carries on in the new direction');
});

test('a bounced +2 can be stacked again and keeps travelling the new way', () => {
  const g = stackGame(
    ['a', 'b', 'c'],
    [[{ id: 1, color: 'amber', value: 'draw2' }, { id: 4, color: 'ruby', value: 'draw2' }], [{ id: 2, color: 'amber', value: 'reverse' }], []]
  );
  g.play('a', 1);
  g.play('b', 2);
  g.play('a', 4);
  assert.equal(g.pendingDraw, 4);
  assert.equal(g.current.id, 'c');
});

test('the bounce works in a two-player game', () => {
  const g = stackGame(['a', 'b'], [[{ id: 1, color: 'amber', value: 'draw2' }], [{ id: 2, color: 'amber', value: 'reverse' }]]);
  g.play('a', 1);
  g.play('b', 2);
  assert.equal(g.current.id, 'a');
  assert.equal(g.pendingDraw, 2);
});

test('a +4 cannot be bounced or answered with a +2', () => {
  const g = stackGame(
    ['a', 'b', 'c'],
    [[{ id: 1, color: 'wild', value: 'wild4' }], [{ id: 2, color: 'jade', value: 'reverse' }, { id: 3, color: 'jade', value: 'draw2' }], []]
  );
  g.play('a', 1, 'jade');
  assert.deepEqual(g.playableIds('b'), []);
});

test('finishing with a bounce Reverse still hands the penalty back', () => {
  const g = stackGame(['a', 'b', 'c'], [[{ id: 1, color: 'amber', value: 'draw2' }], [], []]);
  g.players[1].hand = [{ id: 2, color: 'amber', value: 'reverse' }];
  g.play('a', 1);
  const before = g.player('a').hand.length;
  g.play('b', 2);
  assert.ok(g.over);
  assert.equal(g.winner, 'b');
  assert.equal(g.player('a').hand.length, before + 2);
});

test('reverse acts as skip with two players', () => {
  const g = new Game(['a', 'b']);
  g.turn = 0;
  g.currentColor = 'amber';
  g.players[0].hand.push({ id: 3001, color: 'amber', value: 'reverse' });
  g.play('a', 3001);
  assert.equal(g.current.id, 'a');
});

/* ---- same-number multi-drop ---- */

function setup(hand, top = { id: 900, color: 'ruby', value: '7' }) {
  const g = new Game(['a', 'b', 'c']);
  g.turn = 0;
  g.direction = 1;
  g.discard.push(top);
  g.currentColor = top.color;
  g.players[0].hand = hand;
  return g;
}

test('same numbers of different colors drop together, and the chosen color carries on', () => {
  const g = setup([
    { id: 1, color: 'ruby', value: '2' },
    { id: 2, color: 'jade', value: '2' },
    { id: 3, color: 'amber', value: '2' },
    { id: 4, color: 'violet', value: '2' },
    { id: 5, color: 'violet', value: '9' },
  ]);
  const before = g.cardCount();
  const events = g.play('a', [1, 2, 3, 4], 'jade');
  assert.equal(g.players[0].hand.length, 1);
  assert.equal(g.currentColor, 'jade');
  assert.equal(g.top.id, 2, 'the chosen color ends up on top');
  assert.deepEqual(events[0].cards.map(c => c.id).slice(-1), [2]);
  assert.equal(events[0].cards.length, 4);
  assert.equal(g.current.id, 'b', 'turn moves on once');
  assert.equal(g.cardCount(), before);
});

test('a multi-drop needs one card that matches, and only matching numbers', () => {
  const g = setup([
    { id: 1, color: 'jade', value: '2' },
    { id: 2, color: 'amber', value: '2' },
    { id: 3, color: 'ruby', value: '3' },
    { id: 4, color: 'ruby', value: 'skip' },
    { id: 5, color: 'ruby', value: 'skip' },
  ]);
  assert.throws(() => g.play('a', [1, 2]), /match/, 'neither 2 matches a ruby 7');
  assert.throws(() => g.play('a', [1, 3]), /same number/);
  assert.throws(() => g.play('a', [4, 5]), /same number/, 'action cards cannot be combined');
  assert.equal(g.players[0].hand.length, 5);
});

test('a multi-drop with a color that was not dropped falls back to the matching card', () => {
  const g = setup([
    { id: 1, color: 'ruby', value: '4' },
    { id: 2, color: 'jade', value: '4' },
    { id: 3, color: 'jade', value: '8' },
  ]);
  g.play('a', [1, 2], 'violet');
  assert.equal(g.currentColor, 'ruby');
  assert.equal(g.top.id, 1);
});

test('dropping every card at once wins', () => {
  const g = setup([
    { id: 1, color: 'ruby', value: '5' },
    { id: 2, color: 'amber', value: '5' },
    { id: 3, color: 'violet', value: '5' },
  ]);
  const events = g.play('a', [1, 2, 3], 'amber');
  assert.ok(g.over);
  assert.equal(g.winner, 'a');
  assert.ok(events.some(e => e.type === 'win'));
});

test('last card can be called when a multi-drop would leave one card', () => {
  const g = setup([
    { id: 1, color: 'ruby', value: '6' },
    { id: 2, color: 'jade', value: '6' },
    { id: 3, color: 'amber', value: '6' },
    { id: 4, color: 'violet', value: '1' },
  ]);
  assert.equal(g.canCallLast('a'), true);
  g.callLast('a');
  g.play('a', [1, 2, 3], 'jade');
  assert.equal(g.players[0].vulnerable, false);

  const h = setup([
    { id: 1, color: 'ruby', value: '6' },
    { id: 2, color: 'jade', value: '6' },
    { id: 3, color: 'amber', value: '1' },
    { id: 4, color: 'violet', value: '1' },
  ]);
  assert.equal(h.canCallLast('a'), false, 'no single play leaves one card');
  assert.throws(() => h.callLast('a'), GameError);
});

test('after drawing, the drawn card may take its same numbers along', () => {
  const g = setup([
    { id: 1, color: 'jade', value: '3' },
    { id: 2, color: 'amber', value: '9' },
  ]);
  g.deck.push({ id: 3, color: 'ruby', value: '3' });
  g.draw('a');
  assert.equal(g.drawnCardId, 3);
  assert.throws(() => g.play('a', [1]), /just drew/);
  g.play('a', [3, 1], 'jade');
  assert.equal(g.currentColor, 'jade');
  assert.equal(g.players[0].hand.length, 1);
});

test('bots drop all their cards of a number together', () => {
  const g = setup([
    { id: 1, color: 'ruby', value: '7' },
    { id: 2, color: 'jade', value: '7' },
    { id: 3, color: 'violet', value: '7' },
    { id: 4, color: 'jade', value: '1' },
  ]);
  const move = botMove(g, 'a');
  assert.equal(move.action, 'play');
  assert.deepEqual(move.cardIds.slice().sort(), [1, 2, 3]);
  assert.equal(move.color, 'jade', 'keeps the color it still holds');
});

test('drawn playable card: only that card may be played, or pass', () => {
  const g = new Game(['a', 'b']);
  g.turn = 0;
  g.currentColor = 'violet';
  g.players[0].hand = [{ id: 4001, color: 'ruby', value: '1' }, { id: 4002, color: 'ruby', value: '2' }];
  g.deck.push({ id: 4003, color: 'violet', value: '8' });
  g.draw('a');
  assert.equal(g.drawnCardId, 4003);
  assert.deepEqual(g.playableIds('a'), [4003]);
  assert.throws(() => g.draw('a'), GameError);
  g.pass('a');
  assert.equal(g.current.id, 'b');
});
