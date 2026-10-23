// Rebuild a Save-input dump from an HTML export, for a city whose input was
// never saved. The export's "current city" map lists every building with its
// size, road need and position, every road tile, and every free tile by
// coordinate - which is the whole worker input.
//
//   node tools/from-html.js ~/Downloads/city-builder-X.html inputs/x.json
const fs = require('fs');
const [html, out] = process.argv.slice(2);
const s = fs.readFileSync(html, 'utf8');

// the first map titled as the current city; the export repeats it per variant
const head = ['<h2>Obecne miasto</h2>', '<h2>Current city</h2>', '<h2>Aktuelle Stadt</h2>']
    .map(h => s.indexOf(h)).filter(i => i >= 0);
if (!head.length) throw new Error('no current-city map in ' + html);
const at = Math.min(...head);
const svg = s.slice(at, s.indexOf('</svg>', at));

const titles = (svg.match(/<title>[^<]*<\/title>/g) || []).map(t => t.replace(/<\/?title>/g, ''));
const buildingsData = [], roadTiles = [];
const tiles = new Set();
let id = 1;
for (const t of titles) {
    const p = t.split('  ·  ');
    if (p.length === 1 && /^-?\d+,-?\d+$/.test(t)) { tiles.add(t); continue; }
    if (p.length !== 5) continue;
    const [name, size, type, road, pos] = p;
    const [w, h] = size.split('×').map(Number);
    const [x, y] = pos.split(',').map(Number);
    // hubs stand on their own areas outside the city grid, the worker skips them
    if (/^hub_|^off_grid$/.test(type)) continue;
    for (let a = x; a < x + w; a++) for (let c = y; c < y + h; c++) tiles.add(a + ',' + c);
    if (type === 'street') { roadTiles.push({ x: x, y: y, width: w, height: h }); continue; }
    const street_level = road === 'no road' ? 0 : (/two|2/.test(road) ? 2 : 1);
    buildingsData.push({ id: id, cityentity_id: 'e' + id, name: name, type: type, width: w, height: h, street_level: street_level, x: x, y: y });
    id++;
}
const mapData = [...tiles].map(k => { const [x, y] = k.split(',').map(Number); return { x: x, y: y, width: 1, length: 1 }; });
const roadsBefore = roadTiles.reduce((n, r) => n + r.width * r.height, 0);
const city = (s.match(/<title>FoE Helper - City Builder - ([^<]*)<\/title>/) || [])[1] || html;
fs.writeFileSync(out, JSON.stringify({
    city: city + ' (z eksportu HTML)', note: 'rebuilt by tools/from-html.js from ' + require('path').basename(html),
    mapData: mapData, buildingsData: buildingsData, roadTiles: roadTiles, roadsBefore: roadsBefore
}));
const levels = {};
for (const b of buildingsData) levels[b.street_level] = (levels[b.street_level] || 0) + 1;
console.log(city + ': ' + tiles.size + ' map tiles, ' + buildingsData.length + ' buildings ' + JSON.stringify(levels) + ', ' + roadsBefore + ' road tiles');
