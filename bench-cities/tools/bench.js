// Variant sweep for one city: strategy x sort x pack x town hall position.
//
//   node tools/bench.js reports/xsenka.json
//   node tools/bench.js reports/xsenka.json --seeds=0,1,13 --district
//
// Judge a heuristic on several cities, never one - changes that helped a single
// city and lost on the rest have been reverted more than once.
const { optimizer, loadCity, resolveCity } = require('./city');
const { performance } = require('perf_hooks');

const args = process.argv.slice(2);
const file = resolveCity(args.find(a => a.endsWith('.json')) || 'reports/pacior.json');
const seeds = (args.find(a => a.startsWith('--seeds=')) || '--seeds=0').split('=')[1].split(',').map(Number);
const districtOnly = args.includes('--district');

const STRATEGIES = districtOnly ? ['district'] : ['district', 'bands', 'bands-vertical', 'organic'];
const SORTS = ['height', 'area', 'width'];
const PACKS = args.includes('--packs') ? ['maxrects', 'fast', 'shelf', 'careful'] : ['maxrects'];
const PLACES = [
    ['gora-lewo  ', {}],
    ['gora-prawo ', { mirrorX: true }],
    ['dol-lewo   ', { mirrorY: true }],
    ['dol-prawo  ', { mirrorX: true, mirrorY: true }],
    ['srodek     ', { trunkAt: 'center', centerStart: true }]
];

const Opt = optimizer();
const city = loadCity(file);
console.log(city.name + '  |  ' + city.buildingsData.length + ' budynkow'
    + (city.roadsBefore ? ', drogi gracza: ' + city.roadsBefore : '')
    + (city.hasBaseline ? '' : '  (bez wspolrzednych - brak linii bazowej)'));
console.log('\nratusz       strategia       sort    pack      seed  brak  drogi  kwadrat  rozproszone   ms');

const rows = [];
for (const [tag, place] of PLACES) {
    for (const strategy of STRATEGIES) {
        for (const sortMode of SORTS) {
            for (const packMode of PACKS) {
                for (const seed of seeds) {
                    const t = performance.now();
                    let r;
                    try {
                        r = new Opt(city.mapData, city.buildingsData, Object.assign({
                            strategy, sortMode, seed, packMode, wideColumns: false
                        }, place)).run();
                    } catch (e) { r = { error: e.message }; }
                    const ms = Math.round(performance.now() - t);
                    if (!r || !r.success) {
                        console.log(tag + '  ' + strategy.padEnd(16) + sortMode.padEnd(8) + packMode.padEnd(10)
                            + String(seed).padEnd(6) + 'BLAD ' + ((r && r.error) || '?'));
                        continue;
                    }
                    const s = r.stats;
                    const miss = s.missing + s.unconnected;
                    rows.push({ tag, strategy, sortMode, packMode, seed, miss, roads: s.roads, sq: s.square, out: s.freeOutside });
                    console.log(tag + '  ' + strategy.padEnd(16) + sortMode.padEnd(8) + packMode.padEnd(10)
                        + String(seed).padEnd(6) + String(miss).padStart(4) + String(s.roads).padStart(7)
                        + String(s.square).padStart(9) + String(s.freeOutside).padStart(13) + String(ms).padStart(5));
                }
            }
        }
    }
}

const ok = rows.filter(r => r.miss === 0);
console.log('\n--- najlepsze kompletne uklady ---');
ok.sort((a, b) => a.roads - b.roads || b.sq - a.sq).slice(0, 8).forEach(r => {
    console.log('  ' + String(r.roads).padStart(4) + ' drog | kwadrat ' + r.sq + 'x' + r.sq
        + ' | rozproszone ' + String(r.out).padStart(3) + ' | ' + r.tag.trim()
        + ' | ' + r.strategy + '/' + r.sortMode + '/' + r.packMode + ' seed ' + r.seed);
});
console.log('\nkompletnych: ' + ok.length + ' z ' + rows.length
    + (ok.length ? '' : '  (najmniej brakujacych: ' + Math.min.apply(null, rows.map(r => r.miss)) + ')'));
