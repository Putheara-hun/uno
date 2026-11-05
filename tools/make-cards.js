'use strict';

/**
 * Generates RaDrop's card art as SVG images in public/img.
 *   node tools/make-cards.js        (or: npm run cards)
 *
 * Each card is printed stock: a white border, a faceted gem panel in the card's color,
 * a bevelled white diamond with the symbol, corner indices with a shape glyph (for
 * color-blind players), paper grain and a gloss. 54 faces + 1 back.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'img');
const W = 250;
const H = 350;
const R = 21; // corner radius (matches the CSS card radius: 8.5% of the width)
const IN = 13; // white border width
const CX = W / 2;
const CY = H / 2;
const FONT = "'Arial Black','Segoe UI Black','Segoe UI',Arial,Helvetica,sans-serif";

const PALETTE = {
  ruby: { hi: '#ff7d8f', base: '#e0304d', lo: '#931232', deep: '#540a1c' },
  amber: { hi: '#ffd57a', base: '#f2951b', lo: '#ad5607', deep: '#5e2c03' },
  jade: { hi: '#62e6b4', base: '#11a877', lo: '#06654b', deep: '#023527' },
  violet: { hi: '#bea2ff', base: '#7d4cf2', lo: '#4721aa', deep: '#230d63' },
  wild: { hi: '#4b4479', base: '#26213f', lo: '#120f20', deep: '#06050c' },
};
const GEMS = ['ruby', 'amber', 'jade', 'violet'];

const f = n => Number(n.toFixed(2));

/* ---------- shared pieces ---------- */

function defs(pal, seed) {
  return `<defs>
  <clipPath id="card"><rect width="${W}" height="${H}" rx="${R}"/></clipPath>
  <linearGradient id="stock" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#f6f2ea"/><stop offset="1" stop-color="#e2dbcc"/>
  </linearGradient>
  <linearGradient id="panel" x1=".1" y1="0" x2=".9" y2="1">
    <stop offset="0" stop-color="${pal.hi}"/><stop offset=".48" stop-color="${pal.base}"/><stop offset="1" stop-color="${pal.lo}"/>
  </linearGradient>
  <radialGradient id="glow" cx=".28" cy=".12" r=".85">
    <stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="vignette" cx=".5" cy=".5" r=".7">
    <stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/>
  </radialGradient>
  <linearGradient id="gloss" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="pearl" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#f7f4ee"/><stop offset="1" stop-color="#dcd5c6"/>
  </linearGradient>
  <filter id="paper" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" seed="${seed}" stitchTiles="stitch"/>
    <feColorMatrix values="0 0 0 0 .42  0 0 0 0 .37  0 0 0 0 .3  0 0 0 .16 0"/>
  </filter>
  <filter id="bevel" x="-25%" y="-25%" width="150%" height="150%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur"/>
    <feSpecularLighting in="blur" surfaceScale="5" specularConstant="1" specularExponent="24" lighting-color="#ffffff" result="spec">
      <feDistantLight azimuth="235" elevation="42"/>
    </feSpecularLighting>
    <feComposite in="spec" in2="SourceAlpha" operator="in" result="specIn"/>
    <feComposite in="SourceGraphic" in2="specIn" operator="arithmetic" k1="0" k2="1" k3=".55" k4="0" result="lit"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="sblur"/>
    <feOffset in="sblur" dx="3" dy="6" result="soff"/>
    <feFlood flood-color="#000" flood-opacity=".38"/>
    <feComposite in2="soff" operator="in" result="shadow"/>
    <feMerge><feMergeNode in="shadow"/><feMergeNode in="lit"/></feMerge>
  </filter>
  <filter id="lift" x="-25%" y="-25%" width="150%" height="150%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="1.6" result="b"/>
    <feOffset in="b" dx="2" dy="3" result="o"/>
    <feFlood flood-color="#000" flood-opacity=".35"/>
    <feComposite in2="o" operator="in" result="s"/>
    <feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>`;
}

/** The panel is cut like a gemstone: eight facets radiating from the center. */
function facets() {
  const a = IN;
  const b = W - IN;
  const c = H - IN;
  const pts = [
    [a, a],
    [CX, a],
    [b, a],
    [b, CY],
    [b, c],
    [CX, c],
    [a, c],
    [a, CY],
  ];
  const shades = ['#fff', '#000', '#fff', '#000', '#000', '#fff', '#000', '#fff'];
  const alpha = [0.1, 0.05, 0.06, 0.1, 0.12, 0.04, 0.08, 0.12];
  return pts
    .map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      return `<path d="M${CX} ${CY}L${p[0]} ${p[1]}L${q[0]} ${q[1]}Z" fill="${shades[i]}" fill-opacity="${alpha[i]}"/>`;
    })
    .join('');
}

function diamond(size, attrs) {
  const s = size;
  return `<rect x="${f(CX - s / 2)}" y="${f(CY - s / 2)}" width="${s}" height="${s}" rx="${f(s * 0.15)}" transform="rotate(45 ${CX} ${CY})" ${attrs}/>`;
}

/** Four-color gem used on wilds and the back. */
function gem(size, cx = CX, cy = CY) {
  const h = size / 2;
  const quads = [
    [-h, -h],
    [0, -h],
    [0, 0],
    [-h, 0],
  ];
  const tiles = quads
    .map(
      ([x, y], i) => `<rect x="${f(cx + x)}" y="${f(cy + y)}" width="${f(h)}" height="${f(h)}" fill="${PALETTE[GEMS[i]].base}"/>
      <path d="M${f(cx + x)} ${f(cy + y)}h${f(h)}l${f(-h)} ${f(h)}Z" fill="#fff" fill-opacity=".22"/>`
    )
    .join('');
  return `<g transform="rotate(45 ${cx} ${cy})" filter="url(#bevel)">
    <rect x="${f(cx - h - 7)}" y="${f(cy - h - 7)}" width="${f(size + 14)}" height="${f(size + 14)}" rx="${f(size * 0.16)}" fill="url(#pearl)"/>
    <g>${tiles}</g>
    <path d="M${f(cx)} ${f(cy - h)}V${f(cy + h)}M${f(cx - h)} ${f(cy)}H${f(cx + h)}" stroke="#fff" stroke-width="4"/>
    <rect x="${f(cx - h)}" y="${f(cy - h)}" width="${f(size)}" height="${f(size)}" fill="none" stroke="#fff" stroke-width="3"/>
  </g>`;
}

function miniGem(x, y, s) {
  const h = s / 2;
  return `<g transform="rotate(45 ${x} ${y})">
    <rect x="${f(x - h - 2)}" y="${f(y - h - 2)}" width="${f(s + 4)}" height="${f(s + 4)}" rx="2" fill="#fff"/>
    ${GEMS.map((g, i) => {
      const dx = i === 1 || i === 2 ? 0 : -h;
      const dy = i >= 2 ? 0 : -h;
      return `<rect x="${f(x + dx)}" y="${f(y + dy)}" width="${f(h)}" height="${f(h)}" fill="${PALETTE[g].base}"/>`;
    }).join('')}
  </g>`;
}

/** Shape glyph per color, so colors never rely on hue alone. */
function glyph(color, x, y, s, fill, stroke) {
  const a = `fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"`;
  switch (color) {
    case 'ruby':
      return `<path d="M${x} ${f(y - s * 0.6)}L${f(x + s * 0.6)} ${f(y + s * 0.45)}H${f(x - s * 0.6)}Z" ${a}/>`;
    case 'amber':
      return `<circle cx="${x}" cy="${y}" r="${f(s * 0.5)}" ${a}/>`;
    case 'jade':
      return `<rect x="${f(x - s * 0.45)}" y="${f(y - s * 0.45)}" width="${f(s * 0.9)}" height="${f(s * 0.9)}" ${a}/>`;
    case 'violet':
      return `<path d="M${x} ${f(y - s * 0.62)}L${f(x + s * 0.5)} ${y}L${x} ${f(y + s * 0.62)}L${f(x - s * 0.5)} ${y}Z" ${a}/>`;
    default:
      return '';
  }
}

/* ---------- symbols ---------- */

function skipIcon(x, y, s, fill, outline, wide) {
  const ring = `<circle cx="${x}" cy="${y}" r="${f(s * 0.58)}" fill="none"/>`;
  const bar = `<path d="M${f(x - s * 0.41)} ${f(y + s * 0.41)}L${f(x + s * 0.41)} ${f(y - s * 0.41)}"/>`;
  return `<g stroke-linecap="round">
    <g stroke="${outline}" stroke-width="${f(s * wide * 1.6)}">${ring}${bar}</g>
    <g stroke="${fill}" stroke-width="${f(s * wide)}">${ring}${bar}</g>
  </g>`;
}

function reverseIcon(x, y, s, fill, outline, wide) {
  const k = v => f(v * s);
  const d =
    `M${f(x - k(0.62))} ${f(y - k(0.2))}H${f(x + k(0.42))}M${f(x + k(0.12))} ${f(y - k(0.5))}L${f(x + k(0.44))} ${f(y - k(0.2))}L${f(x + k(0.12))} ${f(y + k(0.1))}` +
    `M${f(x + k(0.62))} ${f(y + k(0.24))}H${f(x - k(0.42))}M${f(x - k(0.12))} ${f(y - k(0.06))}L${f(x - k(0.44))} ${f(y + k(0.24))}L${f(x - k(0.12))} ${f(y + k(0.54))}`;
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${d}" stroke="${outline}" stroke-width="${f(s * wide * 1.6)}"/>
    <path d="${d}" stroke="${fill}" stroke-width="${f(s * wide)}"/>
  </g>`;
}

function bigText(text, size, fill, outline, y = CY) {
  return `<text x="${CX}" y="${y}" dy=".36em" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="${size}"
    fill="${fill}" stroke="${outline}" stroke-width="${f(size * 0.075)}" stroke-linejoin="round" paint-order="stroke" letter-spacing="-2">${text}</text>`;
}

function centerSymbol(color, value, pal) {
  if (/^[0-9]$/.test(value)) {
    const under = value === '6' || value === '9' ? `<rect x="${CX - 26}" y="${CY + 58}" width="52" height="9" rx="4.5" fill="${pal.base}" stroke="${pal.deep}" stroke-width="5" paint-order="stroke"/>` : '';
    return `<g filter="url(#lift)">${bigText(value, 128, pal.base, pal.deep, CY - 4)}${under}</g>`;
  }
  if (value === 'draw2') return `<g filter="url(#lift)">${bigText('+2', 96, pal.base, pal.deep)}</g>`;
  if (value === 'skip') return `<g filter="url(#lift)">${skipIcon(CX, CY, 92, pal.base, pal.deep, 0.2)}</g>`;
  if (value === 'reverse') return `<g filter="url(#lift)">${reverseIcon(CX, CY, 100, pal.base, pal.deep, 0.17)}</g>`;
  return '';
}

function cornerIndex(color, value, pal) {
  const white = '#fff';
  let mark;
  if (/^[0-9]$/.test(value) || value === 'draw2' || value === 'wild4') {
    const t = value === 'draw2' ? '+2' : value === 'wild4' ? '+4' : value;
    const size = t.length > 1 ? 30 : 40;
    mark = `<text x="0" y="0" dy=".36em" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="${size}" fill="${white}"
      stroke="${pal.deep}" stroke-width="6" stroke-linejoin="round" paint-order="stroke" letter-spacing="-1">${t}</text>`;
  } else if (value === 'skip') {
    mark = skipIcon(0, 0, 28, white, pal.deep, 0.22);
  } else if (value === 'reverse') {
    mark = reverseIcon(0, 0, 32, white, pal.deep, 0.19);
  } else {
    mark = miniGem(0, 0, 18);
  }
  const g = color === 'wild' ? (value === 'wild4' ? `<g transform="translate(0 34)">${miniGem(0, 0, 12)}</g>` : '') : glyph(color, 0, 33, 13, white, pal.deep);
  const one = `<g transform="translate(37 44)">${mark}${g}</g>`;
  return `${one}<g transform="rotate(180 ${CX} ${CY})">${one}</g>`;
}

/* ---------- cards ---------- */

function frame(pal, seed, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
${defs(pal, seed)}
<g clip-path="url(#card)">
  <rect width="${W}" height="${H}" fill="url(#stock)"/>
  <rect x="${IN}" y="${IN}" width="${W - 2 * IN}" height="${H - 2 * IN}" rx="13" fill="url(#panel)"/>
  <g clip-path="url(#card)">${facets()}</g>
  <rect x="${IN}" y="${IN}" width="${W - 2 * IN}" height="${H - 2 * IN}" rx="13" fill="url(#vignette)"/>
  <rect x="${IN}" y="${IN}" width="${W - 2 * IN}" height="${H - 2 * IN}" rx="13" fill="url(#glow)"/>
  <rect x="${IN + 1.5}" y="${IN + 1.5}" width="${W - 2 * IN - 3}" height="${H - 2 * IN - 3}" rx="12" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2"/>
  <rect x="${IN}" y="${IN}" width="${W - 2 * IN}" height="${H - 2 * IN}" rx="13" fill="none" stroke="${pal.deep}" stroke-opacity=".55" stroke-width="1.5"/>
  ${inner}
  <rect width="${W}" height="${H}" filter="url(#paper)"/>
  <path d="M0 0H${W * 0.62}L0 ${H * 0.5}Z" fill="url(#gloss)" opacity=".5"/>
</g>
<rect x=".75" y=".75" width="${W - 1.5}" height="${H - 1.5}" rx="${R - 0.75}" fill="none" stroke="#3a2f1c" stroke-opacity=".35" stroke-width="1.5"/>
</svg>
`;
}

function face(color, value, seed) {
  const pal = PALETTE[color];
  let inner;
  if (color === 'wild') {
    inner = gem(118) + (value === 'wild4' ? `<g filter="url(#lift)">${bigText('+4', 92, '#fff', '#0b0916')}</g>` : '') + cornerIndex(color, value, pal);
  } else {
    inner = `<g filter="url(#bevel)">${diamond(146, 'fill="url(#pearl)"')}</g>` + centerSymbol(color, value, pal) + cornerIndex(color, value, pal);
  }
  return frame(pal, seed, inner);
}

function back(seed) {
  const pal = { hi: '#4f4790', base: '#29234f', lo: '#15122b', deep: '#0b0918' };
  const inner = `
  <defs><pattern id="lattice" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <path d="M0 0H20M0 0V20" stroke="#fff" stroke-opacity=".09" stroke-width="2"/>
  </pattern></defs>
  <rect x="${IN}" y="${IN}" width="${W - 2 * IN}" height="${H - 2 * IN}" rx="13" fill="url(#lattice)"/>
  <rect x="${IN + 12}" y="${IN + 12}" width="${W - 2 * IN - 24}" height="${H - 2 * IN - 24}" rx="9" fill="none" stroke="#fff" stroke-opacity=".32" stroke-width="2"/>
  <rect x="${IN + 17}" y="${IN + 17}" width="${W - 2 * IN - 34}" height="${H - 2 * IN - 34}" rx="7" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="1.5"/>
  ${gem(84)}
  <text x="${CX}" y="${H - 64}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="24" letter-spacing="7" fill="#fff" fill-opacity=".9">RADROP</text>
  <text x="${CX}" y="${H - 64}" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="24" letter-spacing="7" fill="#fff" fill-opacity=".9" transform="rotate(180 ${CX} ${CY})">RADROP</text>`;
  return frame(pal, seed, inner);
}

/* ---------- write ---------- */

fs.mkdirSync(OUT, { recursive: true });
let seed = 3;
let count = 0;
const write = (name, svg) => {
  fs.writeFileSync(path.join(OUT, name), svg);
  count++;
};
for (const color of GEMS) {
  for (const value of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2']) {
    write(`${color}-${value}.svg`, face(color, value, seed++));
  }
}
write('wild.svg', face('wild', 'wild', seed++));
write('wild4.svg', face('wild', 'wild4', seed++));
write('back.svg', back(seed++));
console.log(`wrote ${count} card images to ${path.relative(process.cwd(), OUT) || OUT}`);
