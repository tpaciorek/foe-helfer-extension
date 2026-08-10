// Shared plumbing for the bench tools: pull the worker source out of the module
// and turn a bench file into the input the worker expects.
//
// The worker lives inside a template literal, so there is no build step and no
// copy to keep in sync - these tools always measure the current source.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const SRC = path.join(__dirname, '..', '..', 'js', 'web', 'city-builder', 'js', 'city-builder.js');

function workerSource() {
    const raw = fs.readFileSync(SRC, 'utf8');
    const start = raw.indexOf('WorkerCode: `') + 'WorkerCode: '.length;
    const end = raw.lastIndexOf('`,');
    if (start < 'WorkerCode: '.length || end < 0) throw new Error('WorkerCode literal not found in ' + SRC);
    return eval(raw.slice(start, end + 1));
}

/** The optimizer class on its own, for sweeping single variants. */
function optimizer() {
    const ctx = { console: { log: () => {} }, performance, setTimeout, clearTimeout };
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(workerSource() + '\nself.__OPT = CityOptimizerBrowser;', ctx);
    return ctx.__OPT;
}

/** The whole worker, message interface and all, for end-to-end runs. */
function searchWorker(logBaseline) {
    const ctx = {
        console: { log: (m) => { if (logBaseline && /baseline/.test(String(m))) console.log('  ' + m); } },
        performance, setTimeout, clearTimeout
    };
    ctx.self = ctx;
    let done = null;
    ctx.postMessage = (m) => { if (m && m.success !== undefined) done = m; };
    vm.createContext(ctx);
    vm.runInContext(workerSource(), ctx);
    return {
        run(input, budgetMs) {
            ctx.onmessage({ data: Object.assign({ budgetMs: budgetMs }, input) });
        },
        result: () => done
    };
}

/**
 * Read a bench file, whichever of the two shapes it is.
 *
 * A Save-input dump already is the worker input. A Copy-report has to be
 * expanded: its building list is grouped by name and size, and carries no
 * coordinates - so the reconstructed city has no baseline.
 */
function loadCity(file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (j.buildingsData) {
        return {
            name: j.city || path.basename(file),
            mapData: j.mapData,
            buildingsData: j.buildingsData,
            roadTiles: j.roadTiles || [],
            roadsBefore: j.roadsBefore,
            hasBaseline: !!(j.roadTiles && j.roadTiles.length)
        };
    }

    const mapData = j.map.areas.map(a => ({ x: a[0], y: a[1], width: a[2], length: a[3] }));
    const buildingsData = [];
    let id = 1;
    for (const [count, name, w, h, streetLevel, type] of j.buildings) {
        for (let i = 0; i < count; i++) {
            buildingsData.push({
                id: id, cityentity_id: 'e' + id, name: name, type: type,
                width: w, height: h, street_level: streetLevel
            });
            id++;
        }
    }
    return {
        name: j.city || path.basename(file),
        mapData: mapData,
        buildingsData: buildingsData,
        roadTiles: [],
        roadsBefore: j.result ? j.result.roadsBefore : undefined,
        hasBaseline: false
    };
}

/** Resolve a path given relative to the bench folder, the cwd, or bare. */
function resolveCity(arg) {
    const tries = [arg, path.join(__dirname, '..', arg),
        path.join(__dirname, '..', 'inputs', arg), path.join(__dirname, '..', 'reports', arg)];
    for (const t of tries) if (fs.existsSync(t)) return t;
    throw new Error('city file not found: ' + arg);
}

module.exports = { optimizer, searchWorker, loadCity, resolveCity, SRC };
