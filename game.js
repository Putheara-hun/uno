'use strict';

/**
 * RaDrop — pure game engine (no networking).
 * Color/number matching "shedding" rules with Skip, Reverse, +2, Wild and Wild +4.
 * The first player to empty their hand wins (no points).
 * House rule — dropping several cards at once (at least one must match the pile; the player picks
 * which of the dropped colors continues):
 *   - number cards with the same number, whatever their colors;
 *   - Skips and Reverses that share a symbol (any colors) or share a color (a Skip + Reverse pair).
 *     They act once: a Reverse flips play, then a Skip jumps the next player.
 * Stacking (option): a +2 may be answered with a +2 of any color or a +4, passing the growing
 * penalty on; or bounced back to its sender with a Reverse of the current color. A +4 only takes a +4.
 */

const COLORS = ['ruby', 'amber', 'jade', 'violet'];
const HAND_SIZE = 7;
const DECK_SIZE = 108;

class GameError extends Error {}

function buildDeck() {
  const deck = [];
  let id = 0;
  for (const color of COLORS) {
    deck.push({ id: id++, color, value: '0' });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, color, value: String(n) });
      deck.push({ id: id++, color, value: String(n) });
    }
    for (const value of ['skip', 'reverse', 'draw2']) {
      deck.push({ id: id++, color, value });
      deck.push({ id: id++, color, value });
    }
  }
  for (let k = 0; k < 4; k++) {
    deck.push({ id: id++, color: 'wild', value: 'wild' });
    deck.push({ id: id++, color: 'wild', value: 'wild4' });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const isNumber = card => /^[0-9]$/.test(card.value);
const isAction = card => card.value === 'skip' || card.value === 'reverse';

/** Whether these cards may go down together in one play. */
function canCombine(cards) {
  if (cards.length <= 1) return true;
  const first = cards[0];
  if (cards.every(c => isNumber(c) && c.value === first.value)) return true;
  if (!cards.every(isAction)) return false;
  return cards.every(c => c.value === first.value) || cards.every(c => c.color === first.color);
}

/** The biggest set this card could go down with. */
function comboFor(card, hand) {
  if (isNumber(card)) return hand.filter(c => isNumber(c) && c.value === card.value);
  if (!isAction(card)) return [card];
  const bySymbol = hand.filter(c => c.value === card.value);
  const byColor = hand.filter(c => isAction(c) && c.color === card.color);
  return byColor.length > bySymbol.length ? byColor : bySymbol;
}

/** Every distinct maximal combo in a hand (same number; same action symbol; same-color Skip/Reverse). */
function comboGroups(hand) {
  const groups = new Map();
  const add = (key, c) => groups.set(key, [...(groups.get(key) || []), c]);
  for (const c of hand) {
    if (isNumber(c)) add(`n${c.value}`, c);
    if (isAction(c)) {
      add(`s${c.value}`, c);
      add(`c${c.color}`, c);
    }
  }
  return [...groups.values()];
}

class Game {
  /**
   * @param {string[]} playerIds seating order
   * @param {{stacking?: boolean}} options
   */
  constructor(playerIds, options = {}) {
    if (playerIds.length < 2) throw new GameError('Need at least 2 players.');
    this.options = { stacking: !!options.stacking };
    this.players = playerIds.map(id => ({ id, hand: [], saidLast: false, vulnerable: false }));
    this.deck = shuffle(buildDeck());
    this.discard = [];
    this.direction = 1;
    this.turn = Math.floor(Math.random() * this.players.length);
    this.turnId = 0;
    this.pendingDraw = 0;
    this.pendingKind = null; // 'draw2' | 'wild4' while a stacked penalty is waiting
    this.drawnCardId = null;
    this.over = false;
    this.winner = null;

    for (let i = 0; i < HAND_SIZE; i++) {
      for (const p of this.players) p.hand.push(this.deck.pop());
    }
    // The starting card is always a number card.
    let first = this.deck.pop();
    while (!isNumber(first)) {
      this.deck.unshift(first);
      first = this.deck.pop();
    }
    this.discard.push(first);
    this.currentColor = first.color;
  }

  get top() {
    return this.discard[this.discard.length - 1];
  }

  get current() {
    return this.players[this.turn];
  }

  player(id) {
    return this.players.find(p => p.id === id) || null;
  }

  nextIndex(steps = 1) {
    const n = this.players.length;
    return (((this.turn + this.direction * steps) % n) + n) % n;
  }

  canPlay(card) {
    const top = this.top;
    if (this.pendingDraw > 0) {
      if (this.pendingKind === 'wild4') return card.value === 'wild4';
      // A +2 can be answered with a +2 of any color or a +4 (passing it on),
      // or bounced back to its sender with a Reverse of the current color.
      return card.value === 'draw2' || card.value === 'wild4' || (card.value === 'reverse' && card.color === this.currentColor);
    }
    return card.color === 'wild' || card.color === this.currentColor || card.value === top.value;
  }

  playableIds(playerId) {
    if (this.over) return [];
    const p = this.current;
    if (p.id !== playerId) return [];
    if (this.drawnCardId !== null) {
      const c = p.hand.find(x => x.id === this.drawnCardId);
      return c && this.canPlay(c) ? [c.id] : [];
    }
    return p.hand.filter(c => this.canPlay(c)).map(c => c.id);
  }

  reshuffle() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    this.deck = shuffle(this.discard);
    this.discard = [top];
  }

  drawCards(p, count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) this.reshuffle();
      if (this.deck.length === 0) break;
      drawn.push(this.deck.pop());
    }
    if (drawn.length) {
      p.hand.push(...drawn);
      p.saidLast = false;
      p.vulnerable = false;
    }
    return drawn;
  }

  endTurn(steps) {
    this.turn = this.nextIndex(steps);
    this.drawnCardId = null;
    this.turnId++;
  }

  /** A forgotten "last card" call can only be punished until the next player acts. */
  clearOthersVulnerable(actorId) {
    for (const p of this.players) if (p.id !== actorId) p.vulnerable = false;
  }

  assertTurn(playerId) {
    if (this.over) throw new GameError('The round is over.');
    if (this.current.id !== playerId) throw new GameError("It's not your turn.");
    return this.current;
  }

  /**
   * Play one card, or a combo (see canCombine): same numbers, or Skips/Reverses sharing a symbol or color.
   * @param {number|number[]} cardIds
   * @param {string} [chosenColor] required for a wild; for a multi-drop, which of the dropped colors continues
   */
  play(playerId, cardIds, chosenColor) {
    const p = this.assertTurn(playerId);
    const ids = [...new Set((Array.isArray(cardIds) ? cardIds : [cardIds]).map(Number))];
    if (!ids.length) throw new GameError('Pick a card to play.');
    const cards = ids.map(id => p.hand.find(c => c.id === id));
    if (cards.some(c => !c)) throw new GameError("You don't have that card.");
    if (this.drawnCardId !== null && !ids.includes(this.drawnCardId)) {
      throw new GameError('You can only play the card you just drew.');
    }
    if (cards.length > 1) {
      if (this.pendingDraw > 0) throw new GameError('Answer a +2 with a single card.');
      if (!canCombine(cards)) {
        throw new GameError('Only same numbers, or Skips and Reverses that share a symbol or a color, can go down together.');
      }
    }
    const lead = cards.find(c => this.canPlay(c));
    if (!lead) {
      throw new GameError(this.pendingDraw > 0 ? `Stack a draw card or take ${this.pendingDraw}.` : "That card doesn't match.");
    }

    let color;
    if (cards.length === 1 && lead.color === 'wild') {
      if (!COLORS.includes(chosenColor)) throw new GameError('Choose a color.');
      color = chosenColor;
    } else if (cards.length === 1) {
      color = lead.color;
    } else {
      color = cards.some(c => c.color === chosenColor) ? chosenColor : lead.color;
    }
    // The card whose color carries on ends up on top of the pile.
    const card = cards.length === 1 || lead.color === color ? lead : cards.find(c => c.color === color);
    const ordered = [...cards.filter(c => c !== card), card];

    p.hand = p.hand.filter(c => !ids.includes(c.id));
    this.discard.push(...ordered);
    this.currentColor = color;
    this.clearOthersVulnerable(p.id);
    const events = [{ type: 'play', playerId: p.id, card, cards: ordered, color }];

    if (p.hand.length === 1) p.vulnerable = !p.saidLast;
    else p.saidLast = false;

    if (p.hand.length === 0) {
      // A finishing draw card (or a finishing bounce) still hits its target.
      let victim = null;
      let amount = 0;
      if (card.value === 'draw2' || card.value === 'wild4') {
        victim = this.players[this.nextIndex(1)];
        amount = this.pendingDraw + (card.value === 'draw2' ? 2 : 4);
      } else if (card.value === 'reverse' && this.pendingDraw > 0) {
        this.direction *= -1;
        victim = this.players[this.nextIndex(1)];
        amount = this.pendingDraw;
      }
      if (victim) {
        const drawn = this.drawCards(victim, amount);
        events.push({ type: 'draw', playerId: victim.id, count: drawn.length, forced: true });
      }
      this.pendingDraw = 0;
      this.pendingKind = null;
      this.drawnCardId = null;
      this.over = true;
      this.winner = p.id;
      p.vulnerable = false;
      events.push({ type: 'win', playerId: p.id });
      return events;
    }

    if (cards.length > 1 && cards.every(isAction)) {
      // A Skip/Reverse combo acts once: a Reverse flips play, then a Skip jumps the next player.
      if (cards.some(c => c.value === 'reverse')) {
        this.direction *= -1;
        events.push({ type: 'reverse', direction: this.direction });
      }
      if (cards.some(c => c.value === 'skip') || this.players.length === 2) {
        events.push({ type: 'skip', playerId: this.players[this.nextIndex(1)].id });
        this.endTurn(2);
      } else {
        this.endTurn(1);
      }
      return events;
    }

    switch (card.value) {
      case 'skip': {
        events.push({ type: 'skip', playerId: this.players[this.nextIndex(1)].id });
        this.endTurn(2);
        break;
      }
      case 'reverse': {
        this.direction *= -1;
        events.push({ type: 'reverse', direction: this.direction });
        if (this.pendingDraw > 0) {
          // Bounced: the waiting penalty goes back the way it came.
          this.endTurn(1);
          events.push({ type: 'bounce', playerId: this.current.id, by: p.id, amount: this.pendingDraw });
        } else if (this.players.length === 2) {
          events.push({ type: 'skip', playerId: this.players[this.nextIndex(1)].id });
          this.endTurn(2);
        } else {
          this.endTurn(1);
        }
        break;
      }
      case 'draw2':
      case 'wild4': {
        const amount = card.value === 'draw2' ? 2 : 4;
        if (this.options.stacking) {
          this.pendingDraw += amount;
          this.pendingKind = card.value;
          this.endTurn(1);
          events.push({ type: 'stack', playerId: this.current.id, amount: this.pendingDraw });
        } else {
          const victim = this.players[this.nextIndex(1)];
          const drawn = this.drawCards(victim, amount);
          events.push({ type: 'draw', playerId: victim.id, count: drawn.length, forced: true });
          events.push({ type: 'skip', playerId: victim.id });
          this.endTurn(2);
        }
        break;
      }
      default:
        this.endTurn(1);
    }
    return events;
  }

  draw(playerId) {
    const p = this.assertTurn(playerId);
    this.clearOthersVulnerable(p.id);
    if (this.pendingDraw > 0) {
      const amount = this.pendingDraw;
      this.pendingDraw = 0;
      this.pendingKind = null;
      const drawn = this.drawCards(p, amount);
      this.endTurn(1);
      return [{ type: 'draw', playerId: p.id, count: drawn.length, forced: true }];
    }
    if (this.drawnCardId !== null) throw new GameError('You already drew this turn.');
    const drawn = this.drawCards(p, 1);
    const events = [{ type: 'draw', playerId: p.id, count: drawn.length }];
    if (drawn.length && this.canPlay(drawn[0])) {
      this.drawnCardId = drawn[0].id; // may play it now, or pass
    } else {
      this.endTurn(1);
    }
    return events;
  }

  pass(playerId) {
    this.assertTurn(playerId);
    if (this.drawnCardId === null) throw new GameError('Draw a card first.');
    this.clearOthersVulnerable(playerId);
    this.endTurn(1);
    return [{ type: 'pass', playerId }];
  }

  /** "Last card!" can be called holding one card, or on your turn when this play could leave you with one. */
  canCallLast(playerId) {
    if (this.over) return false;
    const p = this.player(playerId);
    if (!p || p.saidLast) return false;
    if (p.hand.length === 1) return true;
    if (this.current.id !== playerId) return false;
    if (p.hand.length === 2) return true;
    if (this.pendingDraw > 0) return false; // answering a +2 is one card at a time
    const playable = new Set(this.playableIds(playerId));
    return comboGroups(p.hand).some(g => g.length === p.hand.length - 1 && g.some(c => playable.has(c.id)));
  }

  callLast(playerId) {
    if (this.over) throw new GameError('The round is over.');
    const p = this.player(playerId);
    if (!p) throw new GameError("You're not in this round.");
    if (p.saidLast) return [];
    if (!this.canCallLast(playerId)) throw new GameError('Call it when you are down to your last card.');
    p.saidLast = true;
    p.vulnerable = false;
    return [{ type: 'last', playerId }];
  }

  catchPlayer(catcherId, targetId) {
    if (this.over) throw new GameError('The round is over.');
    if (!this.player(catcherId)) throw new GameError("You're not in this round.");
    if (catcherId === targetId) throw new GameError("You can't catch yourself.");
    const t = this.player(targetId);
    if (!t || !t.vulnerable) throw new GameError('Too late!');
    t.vulnerable = false;
    const drawn = this.drawCards(t, 2);
    return [{ type: 'caught', playerId: targetId, by: catcherId, count: drawn.length }];
  }

  cardCount() {
    return this.deck.length + this.discard.length + this.players.reduce((s, p) => s + p.hand.length, 0);
  }
}

/** Simple but decent bot: dumps high cards, saves wilds, attacks when the next player is close to winning. */
function botMove(game, playerId) {
  const me = game.player(playerId);
  const ids = new Set(game.playableIds(playerId));
  const options = me.hand.filter(c => ids.has(c.id));

  if (!options.length) {
    if (game.drawnCardId !== null && game.pendingDraw === 0) return { action: 'pass' };
    return { action: 'draw' };
  }

  const counts = {};
  for (const c of me.hand) if (c.color !== 'wild') counts[c.color] = (counts[c.color] || 0) + 1;
  const next = game.players[game.nextIndex(1)];
  const danger = next.hand.length <= 2;

  // Everything that can go down with this card (nothing extra while answering a +2).
  const groupOf = c => (game.pendingDraw > 0 ? [c] : comboFor(c, me.hand));

  let best = null;
  let bestScore = -Infinity;
  for (const c of options) {
    let s;
    if (c.color === 'wild') {
      s = c.value === 'wild4' ? (danger ? 50 : -40) : danger ? 5 : -25;
    } else {
      s = (counts[c.color] || 0) * 4;
      if (c.value === 'draw2') s += danger ? 45 : 10;
      else if (isAction(c)) s += (danger ? 35 : 6) + (groupOf(c).length - 1) * 6;
      else s += Number(c.value) * 0.6 + (groupOf(c).length - 1) * 7; // dumping a whole set is great
    }
    s += Math.random() * 3;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  // Drop the whole set the best card can go down with.
  const dropped = groupOf(best);
  const move = { action: 'play', cardIds: [best.id, ...dropped.filter(c => c.id !== best.id).map(c => c.id)] };
  const remaining = me.hand.filter(c => !move.cardIds.includes(c.id));
  const left = {};
  for (const c of remaining) if (c.color !== 'wild') left[c.color] = (left[c.color] || 0) + 1;
  const favourite = choices => {
    const start = choices[Math.floor(Math.random() * choices.length)];
    return choices.reduce((a, b) => ((left[b] || 0) > (left[a] || 0) ? b : a), start);
  };
  if (best.color === 'wild') move.color = favourite(COLORS);
  else if (move.cardIds.length > 1) move.color = favourite([...new Set(dropped.map(c => c.color))]);

  // Bots usually remember to call their last card — but not always.
  if (remaining.length === 1 && !me.saidLast && Math.random() < 0.8) move.callLast = true;
  return move;
}

module.exports = { Game, GameError, botMove, buildDeck, canCombine, comboFor, isNumber, COLORS, DECK_SIZE };
