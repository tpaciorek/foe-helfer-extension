// The real search, end to end, on one or more bench cities.
//
//   node tools/search.js reports/xsenka.json
//   node tools/search.js inputs/*.json --budget=90000
//
// Prints the variant list the switcher would show. A heuristic that looks good
// in bench.js can still lose here, because the budget is zero-sum: every run it
// takes is a run the refinement does not get.
const { searchWorker, loadCity, resolveCity } = require('./city');
const { performance } = require('perf_hooks');

const args = process.argv.slice(2);
const budget = +((args.find(a => a.startsWith('--budget=')) || '--budget=90000').split('=')[1]);
const files = args.filter(a => a.endsWith('.json'));
if (!files.length) files.push('reports/pacior.json');

(async () => {
    for (const f of files) {
        const city = loadCity(resolveCity(f));
        const w = searchWorker(true);
        const started = performance.now();
        w.run({ mapData: city.mapData, buildingsData: city.buildingsData, roadTiles: city.roadTiles }, budget);
        while (!w.result() && performance.now() - started < budget + 60000) {
            await new Promise(r => setTimeout(r, 250));
        }
        const d = w.result();
        console.log('\n=== ' + city.name + ' (' + city.buildingsData.length + ' budynkow'
            + (city.roadsBefore ? ', drogi gracza: ' + city.roadsBefore : '')
            + (city.hasBaseline ? '' : ', bez linii bazowej') + ') ===');
        if (!d) { console.log('  przekroczony czas'); continue; }
        if (!d.success) {
            console.log('  BRAK kompletnego ukladu: brakuje ' + d.missing
                + ', bez drogi ' + d.unconnected + ', po ' + d.runs + ' przebiegach');
            continue;
        }
        console.log('  ' + d.stats.runs + ' przebiegow w ' + Math.round(d.stats.elapsedMs / 1000) + ' s');
        (d.variants || [{ stats: d.stats }]).forEach((v, i) => {
            const s = v.stats;
            // same order the button label uses, so the tool shows what the
            // player would actually read
            const what = s.baseline ? 'twoj uklad'
                : (s.tunedBaseline ? 'twoj uklad, dopracowany'
                    : (s.cheapestRoads ? 'NAJMNIEJ DROG (ratusz ' + s.placement + ')'
                        : ('ratusz ' + s.placement)));
            console.log('   ' + (i === d.variantIndex ? '>' : ' ') + ' ' + String(s.roads).padStart(4)
                + ' drog | kwadrat ' + String(s.square).padStart(2) + 'x' + s.square
                + ' | wolne ' + String(s.freeTotal).padStart(3)
                + ' (' + String(s.freeOutside).padStart(3) + ' rozproszonych) | ' + what);
        });
    }
})();
