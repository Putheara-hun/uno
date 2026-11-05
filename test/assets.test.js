'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildDeck } = require('../game');

const IMG = path.join(__dirname, '..', 'public', 'img');
const artFile = c => (c.color === 'wild' ? `${c.value}.svg` : `${c.color}-${c.value}.svg`);

test('every card in the deck, and the card back, has artwork', () => {
  const names = new Set(buildDeck().map(artFile));
  names.add('back.svg');
  assert.equal(names.size, 55);
  for (const name of names) {
    const file = path.join(IMG, name);
    assert.ok(fs.existsSync(file), `missing ${name} — run "npm run cards"`);
    const svg = fs.readFileSync(file, 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 250 350"/, name);
    assert.doesNotMatch(svg, /NaN|undefined/, `${name} has a broken value`);
  }
});
