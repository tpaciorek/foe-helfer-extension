// Ruin & recreate on its own: lay out one variant, then let the LNS work on it
// for a fixed time and print what it took off.
//
//   node tools/lns.js reports/pacior.json --ms=20000
//   node tools/lns.js reports/pacior.json --live       # also a stand-in live city
//
// Reports carry no coordinates, so --live fakes the player's city: a layout from
// a weaker variant is fed back as "the city as it stands" and goes through the
// same steps the worker runs on a real one (prune + relocate, then the LNS).
const { optimizer, loadCity, resolveCity } = require('./city');
const { performance } = require('perf_hooks');

const args = process.argv.slice(2);
const ms = +((args.find(a => a.startsWith('--ms=')) || '--ms=20000').split('=')[1]);
const seed = +((args.find(a => a.startsWith('--seed=')) || '--seed=1').split('=')[1]);
const live = args.includes('--live');
const files = args.filter(a => a.endsWith('.json'));
if (!files.length) files.push('reports/pacior.json');

const Opt = optimizer();

const CORNERS = [
    ['gora-lewo', {}],
    ['gora-prawo', { mirrorX: true }],
    ['dol-lewo', { mirrorY: true }],
    ['dol-prawo', { mirrorX: true, mirrorY: true }],
    ['srodek', { trunkAt: 'center', centerStart: true }]
];

function line(tag, s) {
    return '  ' + tag.padEnd(28) + String(s.roads).padStart(4) + ' drog | kwadrat '
        + String(s.square).padStart(2) + ' | rozproszone ' + String(s.freeOutside).padStart(3)
        + ' | brak ' + (s.missing + s.unconnected);
}

for (const f of files) {
    const city = loadCity(resolveCity(f));
    console.log('\n=== ' + city.name + ' ===');

    // the best seed-0 district corner, the way the base phase finds it
    let best = null;
    for (const [tag, place] of CORNERS) {
        const o = new Opt(city.mapData, city.buildingsData, Object.assign({
            strategy: 'district', sortMode: 'height', seed: 0, packMode: 'maxrects', wideColumns: false
        }, place));
        const r = o.run();
        if (!r.success) continue;
        const s = r.stats;
        const ok = s.missing + s.unconnected === 0;
        if (ok && (!best || s.roads < best.r.stats.roads)) best = { o, r, tag };
    }
    if (!best) { console.log('  zaden rog nie dal kompletnego ukladu'); continue; }

    console.log(line('przed (' + best.tag + ')', best.r.stats));
    const t = performance.now();
    const res = best.o.ruinAndRecreate(ms, seed);
    const after = best.o.measure(0);
    console.log(line('po LNS ' + Math.round((performance.now() - t) / 1000) + ' s', after.stats)
        + ' | ' + res.tries + ' latek, ' + res.kept + ' przyjetych');

    if (!live) continue;

    // stand-in live city: the bands layout, a plausible hand-built city
    const src = new Opt(city.mapData, city.buildingsData, { strategy: 'bands', sortMode: 'height', seed: 0, packMode: 'maxrects', wideColumns: false });
    const sr = src.run();
    if (!sr.success || sr.stats.missing + sr.stats.unconnected) { console.log('  brak kompletnego ukladu zastepczego'); continue; }
    const pos = new Map();
    const roads = [];
    for (const it of sr.layout) {
        if (it.type === 'street') roads.push({ x: it.x, y: it.y, width: it.width, height: it.height });
        else pos.set(it.id, it);
    }
    const asBuilt = city.buildingsData.map(b => pos.has(b.id) ? Object.assign({}, b, { x: pos.get(b.id).x, y: pos.get(b.id).y }) : b);

    const lv = new Opt(city.mapData, asBuilt, { strategy: 'district' });
    if (!lv.placeCurrentCity(roads)) { console.log('  nie da sie odbudowac miasta zastepczego'); continue; }
    console.log(line('"zywe" miasto (bands)', lv.measure(0).stats));
    lv.pruneRoadsSmart();
    lv.relocateForRoads(3);
    console.log(line('  + przyciecie i relokacja', lv.measure(0).stats));
    const t2 = performance.now();
    const res2 = lv.ruinAndRecreate(ms, seed);
    const s2 = lv.measure(0).stats;
    console.log(line('  + LNS ' + Math.round((performance.now() - t2) / 1000) + ' s', s2)
        + ' | ' + res2.tries + ' latek, ' + res2.kept + ' przyjetych, przesunietych ' + s2.moved + '/' + s2.knownHomes);
}
