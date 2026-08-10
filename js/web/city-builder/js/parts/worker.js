/*
 * **************************************************************************************
 * Copyright (C) 2026 FoE-Helper team - All Rights Reserved
 * You may use, distribute and modify this code under the
 * terms of the AGPL license.
 *
 * See file LICENSE.md or go to
 * https://github.com/mainIine/foe-helfer-extension/blob/master/LICENSE.md
 * for full license details.
 *
 * **************************************************************************************
 */

/**
 * A class that optimizes placement of buildings and roads within a grid-based city
 * layout. It processes map data, handles building placement, and ensures proper road
 * connectivity while adhering to defined constraints.
 *
 * The optimizer runs inside a Web Worker built from this template string, so it
 * must not contain backticks or dollar-brace sequences - string concatenation only.
 */
CityBuilder.WorkerCode = `class CityOptimizerBrowser {
            constructor(mapData, buildingsData, options) {
                const opts = options || {};
                this.strategy = opts.strategy || 'bands';
                this.sortMode = opts.sortMode || 'height';
                this.seed = opts.seed || 0;
                // {x, y, size} in real map coordinates: a square of tiles kept
                // out of the layout on purpose, so the spare space of the
                // finished city is one usable block instead of leftover seams
                this.reserve = opts.reserve || null;
                // 'careful' re-checks the free regions for every roadless
                // building, 'fast' packs them straight from one corner
                this.packMode = opts.packMode || 'careful';
                // district only: serve buildings wider than tall from road
                // columns instead of rows. Which of the two wins depends on the
                // shape of the map, so both are tried
                this.wideColumns = opts.wideColumns !== false;
                // where the district anchors its trunk: hard against the left
                // edge, or in the middle with bands reaching out both ways
                this.trunkAt = opts.trunkAt || 'left';
                // separate from the trunk: whether the bands start halfway down,
                // which is what puts the town hall in the middle of the city.
                // Measured apart because centring both at once cost what
                // centring the trunk alone had won.
                this.centerStart = opts.centerStart === true;
                // The district always opens at the top left: trunk at the start
                // of the run, bands from the top. Mirroring the map is the whole
                // of "start from another corner" - the packing problem is the
                // same up to a reflection, and the layout is reflected back on
                // export. Which corner wins depends on the shape of the map, so
                // it is searched rather than chosen.
                this.mirrorX = opts.mirrorX === true;
                this.mirrorY = opts.mirrorY === true;
                // vertical bands = the same band layout on a transposed map
                this.transposed = this.strategy === 'bands-vertical';
                this.grid = new Map();
                this.buildings = [];
                this.placedBuildings = [];
                this.mapBounds = { minX: 1000, maxX: 0, minY: 1000, maxY: 0 };
                this.townHall = null;
                this.townHallPos = null;
                this.roadTiles = new Set();
                // road tile key -> 1 (one-lane) or 2 (two-lane)
                this.roadLevel = new Map();

                // phase-by-phase trace of the run, reported for the winning
                // variant so a bad layout can be read back step by step
                this.trace = [];
                this.t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

                this.processData(mapData, buildingsData);
            }
    
            processData(rawMap, rawBuildings) {
                if (!rawMap) {
                    console.error("Worker: rawMap ist leer/null");
                    return;
                }
                const validTiles = new Set();
                const mapArray = Array.isArray(rawMap) ? rawMap : Object.values(rawMap || {});

                // the mirror axes have to be known before the first area is
                // transformed, so the raw extent is measured in its own pass
                this.mirrorAxisX = 0;
                this.mirrorAxisY = 0;
                if (this.mirrorX || this.mirrorY) {
                    let rMinX = 1e9, rMaxX = -1e9, rMinY = 1e9, rMaxY = -1e9;
                    mapArray.forEach(area => {
                        const ax = area.x || 0, ay = area.y || 0;
                        const aw = area.width || 4, al = area.length || 4;
                        rMinX = Math.min(rMinX, ax); rMaxX = Math.max(rMaxX, ax + aw);
                        rMinY = Math.min(rMinY, ay); rMaxY = Math.max(rMaxY, ay + al);
                    });
                    this.mirrorAxisX = rMinX + rMaxX;
                    this.mirrorAxisY = rMinY + rMaxY;
                }

                mapArray.forEach(area => {
                    let ax = area.x || 0;
                    let ay = area.y || 0;
                    let aw = area.width || 4;
                    let al = area.length || 4;
                    // mirror in real coordinates first, the transpose swaps axes after
                    if (this.mirrorX) ax = this.mirrorAxisX - (ax + aw);
                    if (this.mirrorY) ay = this.mirrorAxisY - (ay + al);
                    if (this.transposed) { [ax, ay] = [ay, ax]; [aw, al] = [al, aw]; }

                    this.mapBounds.minX = Math.min(this.mapBounds.minX, ax);
                    this.mapBounds.maxX = Math.max(this.mapBounds.maxX, ax + aw);
                    this.mapBounds.minY = Math.min(this.mapBounds.minY, ay);
                    this.mapBounds.maxY = Math.max(this.mapBounds.maxY, ay + al);
    
                    for (let i = ax; i < ax + aw; i++) {
                        for (let j = ay; j < ay + al; j++) {
                            validTiles.add(i + ',' + j);
                        }
                    }
                });
    
                for (let x = this.mapBounds.minX; x < this.mapBounds.maxX; x++) {
                    for (let y = this.mapBounds.minY; y < this.mapBounds.maxY; y++) {
                        this.grid.set(x + ',' + y, validTiles.has(x + ',' + y) ? 0 : -1);
                    }
                }

                // the reserved square is blocked for buildings and roads alike -
                // every placement test asks for grid value 0, so tagging the
                // tiles RESERVED keeps the whole layout away from them without
                // touching a single placement routine
                if (this.reserve && this.reserve.size > 0) {
                    let rx = this.reserve.x, ry = this.reserve.y;
                    // same order as the map areas: mirror, then transpose
                    if (this.mirrorX) rx = this.mirrorAxisX - (rx + this.reserve.size);
                    if (this.mirrorY) ry = this.mirrorAxisY - (ry + this.reserve.size);
                    if (this.transposed) { const t = rx; rx = ry; ry = t; }
                    for (let i = rx; i < rx + this.reserve.size; i++) {
                        for (let j = ry; j < ry + this.reserve.size; j++) {
                            if (this.grid.get(i + ',' + j) === 0) this.grid.set(i + ',' + j, 7);
                        }
                    }
                }

                const ignore = ["Hafen", "Terminal", "Hub", "Außenposten"];
                rawBuildings.forEach(b => {
                    if ((b.width || 0) <= 0) return;
                    if (['hub_main', 'hub_part', 'off_grid'].includes(b.type)) return;
                    if (ignore.some(ig => b.name.includes(ig))) return;
    
                    const bCopy = { ...b, street_level: b.street_level || 0 };
                    // Where this building stands today, carried into the space
                    // the layout works in. A plan that saves three road tiles by
                    // moving four hundred buildings is not a plan anyone carries
                    // out - so every layout has to be able to say how much of the
                    // city it leaves alone.
                    if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
                        let hx = this.mirrorX ? this.mirrorAxisX - (b.x + b.width) : b.x;
                        let hy = this.mirrorY ? this.mirrorAxisY - (b.y + b.height) : b.y;
                        if (this.transposed) { const t = hx; hx = hy; hy = t; }
                        bCopy.homeX = hx;
                        bCopy.homeY = hy;
                    }
                    if (this.transposed) {
                        const w = bCopy.width;
                        bCopy.width = bCopy.height;
                        bCopy.height = w;
                    }
                    // great buildings never need a two-lane street in the game
                    if (bCopy.type === 'greatbuilding' && (bCopy.street_level || 0) > 1) bCopy.street_level = 1;
                    if (bCopy.type === 'main_building') {
                        this.townHall = bCopy;
                        this.townHall.street_level = 1;
                    } else {
                        this.buildings.push(bCopy);
                    }
                });

                this.buildChainComposites();
            }

            // chain buildings must stand in one contiguous row, left to right in
            // chain order - merge each chain into one composite building that is
            // placed as a unit and split back into its members on export
            buildChainComposites() {
                const byChain = new Map();
                const rest = [];
                for (const b of this.buildings) {
                    if (b.chain_id && b.chain_pos >= 0) {
                        if (!byChain.has(b.chain_id)) byChain.set(b.chain_id, []);
                        byChain.get(b.chain_id).push(b);
                    } else {
                        rest.push(b);
                    }
                }

                // the chain runs along the real map x axis - along y in transposed space
                const span = this.transposed
                    ? this.mapBounds.maxY - this.mapBounds.minY
                    : this.mapBounds.maxX - this.mapBounds.minX;

                for (const [cid, list] of byChain) {
                    list.sort((a, b) => a.chain_pos - b.chain_pos || (a.id > b.id ? 1 : -1));

                    // duplicate members belong to parallel chains: greedily deal
                    // every instance into the first group it can extend
                    const groups = [];
                    for (const m of list) {
                        let g = null;
                        for (const cand of groups) {
                            if (cand[cand.length - 1].chain_pos < m.chain_pos) { g = cand; break; }
                        }
                        if (!g) { g = []; groups.push(g); }
                        g.push(m);
                    }

                    for (let gi = 0; gi < groups.length; gi++) {
                        const g = groups[gi];
                        if (g.length === 1) { rest.push(g[0]); continue; }

                        let len = 0, thick = 0, lvl = 0;
                        for (const m of g) {
                            if (this.transposed) { len += m.height; thick = Math.max(thick, m.width); }
                            else { len += m.width; thick = Math.max(thick, m.height); }
                            lvl = Math.max(lvl, m.street_level || 0);
                        }
                        // a chain longer than the map can never stand in one row
                        if (len > span) {
                            for (const m of g) rest.push(m);
                            continue;
                        }
                        rest.push({
                            id: 'chain-' + cid + '-' + gi,
                            name: g[0].name,
                            type: g[0].type,
                            width: this.transposed ? thick : len,
                            height: this.transposed ? len : thick,
                            street_level: lvl,
                            chainMembers: g
                        });
                    }
                }
                this.buildings = rest;
            }

            /**
             * Road district for cities where only a few buildings need a road.
             *
             * The band strategies pave the whole map with road rows and prune
             * afterwards - in a city of 428 buildings where only 56 need a road
             * that starts at hundreds of tiles and never recovers. Here the road
             * is laid only as far as the frontage of the road buildings demands:
             * one straight line per band, buildings hanging off both sides, each
             * with its short side against the road. That is the layout players
             * build by hand, and its cost is the sum of the short sides halved.
             *
             * @param {Array} street - buildings that need a road connection
             */
            layoutDistrict(street) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;

                // the town hall anchors the whole network, so it opens the first
                // band - everything else is served by the same straight lines
                // two-lane buildings go right behind the town hall: they are
                // served by the first band, whose road line is laid double so the
                // two-lane corridor exists from the start instead of being
                // squeezed in afterwards
                const sorted = this.sortBuildings(street.filter(b => b !== this.townHall));
                const twoLane = sorted.filter(b => (b.street_level || 0) >= 2);
                const oneLane = sorted.filter(b => (b.street_level || 0) < 2);

                // Short side against the road decides the direction: a horizontal
                // line is served by the building's width, a vertical one by its
                // height. So everything wider than tall belongs on a column, not
                // on a row - a 6x4 costs 6 tiles of frontage on a row but only 4
                // on a column.
                const wide = this.wideColumns ? oneLane.filter(b => b.width > b.height) : [];
                const tall = this.wideColumns ? oneLane.filter(b => b.width <= b.height) : oneLane;
                const queue = (this.townHall ? [this.townHall] : []).concat(twoLane, tall);

                // widest usable run of a row, so a band is not started in a notch
                const rowRun = (y) => {
                    let best = null, start = null;
                    for (let x = minX; x <= maxX; x++) {
                        if (x < maxX && this.grid.get(x + ',' + y) === 0) {
                            if (start === null) start = x;
                        } else if (start !== null) {
                            if (!best || x - start > best[1] - best[0]) best = [start, x];
                            start = null;
                        }
                    }
                    return best;
                };

                // one side of a band: fill along the road until the run is used up
                const fillSide = (roadY, above, run, pending, belowY) => {
                    const taken = [];
                    let x = run[0];
                    for (let i = 0; i < pending.length && x < run[1]; i++) {
                        const b = pending[i];
                        if (b.used) continue;
                        const y = above ? roadY - b.height : belowY;
                        if (y < minY || y + b.height > maxY) continue;
                        if (x + b.width > run[1]) continue;
                        if (!this.canPlace(x, y, b.width, b.height)) continue;
                        if (!this.gbKeepsStubSpace(x, y, b.width, b.height)) continue;
                        this.placeEntity(b, x, y, b.type === 'main_building' ? 9 : 1);
                        if (b.type === 'main_building') this.townHallPos = [x, y];
                        b.used = true;
                        taken.push([x, x + b.width]);
                        x += b.width;
                    }
                    return taken;
                };

                // one column stays free for the trunk that ties every band line
                // together - without it each line is an island the road network
                // check throws away
                let trunkX = null;
                const lines = [];
                // Centred layout starts its bands halfway down, so the town hall -
                // first in the queue - sits in the middle of the city with the
                // trunk running through it, instead of in a top corner. What does
                // not fit below is picked up by the second sweep from the top.
                const startY = this.centerStart
                    ? minY + (((maxY - minY) / 2) | 0)
                    : minY;
                let y = startY;
                let guard = 0;
                let sweptTop = startY === minY;

                while (queue.some(b => !b.used) && guard++ < 400) {
                    if (y >= maxY) {
                        if (sweptTop) break;
                        // wrap once: fill the rows above the centre as well
                        sweptTop = true;
                        y = minY;
                        continue;
                    }
                    // Tallest building still waiting decides how much room the
                    // upper half of this band needs.
                    //
                    // Sizing the band by the depth most of the frontage wants -
                    // flat backs instead of a comb of ragged gaps - was tried and
                    // measured worse on all four cities (Xsenka 5 homeless -> 13,
                    // rigunia 113 roads -> 132). A band filled from one depth
                    // group has only that group's frontage to spend, so bands get
                    // shorter and more numerous, and every extra band is another
                    // road line. The ragged gaps are cheaper than the lines.
                    const rest = queue.filter(b => !b.used);
                    const hAbove = Math.min(
                        Math.max.apply(null, rest.map(b => b.height)),
                        Math.max(1, maxY - y - 2)
                    );
                    const roadY = y + hAbove;
                    if (roadY + 1 >= maxY) break;

                    if (sweptTop && startY !== minY && roadY >= startY) break;

                    const run = rowRun(roadY);
                    if (!run || run[1] - run[0] < 3) { y++; continue; }

                    if (trunkX === null) {
                        // A trunk in the middle is pure overhead on its left in
                        // the edge layout; centred, both halves of every band
                        // hang off the same column instead of one.
                        trunkX = this.trunkAt === 'center'
                            ? run[0] + (((run[1] - run[0]) / 2) | 0)
                            : run[0];
                    }
                    // bands must reach the trunk, otherwise they cannot be joined
                    if (run[0] > trunkX || run[1] <= trunkX + 1) { y++; continue; }

                    // the first band carries the two-lane corridor, so its road
                    // line is two tiles deep and the lower side moves down by one
                    const dbl = lines.length === 0 && twoLane.length > 0;
                    if (dbl && roadY + 2 >= maxY) { y++; continue; }
                    const belowY = roadY + (dbl ? 2 : 1);

                    const band = [trunkX + 1, run[1]];
                    const top = fillSide(roadY, true, band, rest, belowY);
                    const bottom = fillSide(roadY, false, band, queue.filter(b => !b.used), belowY);
                    // centred trunk: the strip left of it is buildable too
                    let leftTop = [], leftBottom = [];
                    if (this.trunkAt === 'center' && trunkX > run[0]) {
                        const leftBand = [run[0], trunkX];
                        leftTop = fillSide(roadY, true, leftBand, queue.filter(b => !b.used), belowY);
                        leftBottom = fillSide(roadY, false, leftBand, queue.filter(b => !b.used), belowY);
                    }

                    // road only under the frontage that is actually used
                    const spans = top.concat(bottom, leftTop, leftBottom);
                    if (!spans.length) { y = belowY; continue; }
                    let to = -Infinity, from = trunkX;
                    for (const s of spans) { to = Math.max(to, s[1]); from = Math.min(from, s[0]); }
                    for (let rx = from; rx < to; rx++) {
                        this.placeRoadTile(rx, roadY, dbl ? 2 : 1);
                        if (dbl) this.placeRoadTile(rx, roadY + 1, 2);
                    }
                    lines.push(roadY);

                    let hBelow = 0;
                    for (const b of this.placedBuildings) {
                        if (b.y === belowY) hBelow = Math.max(hBelow, b.height);
                    }
                    y = belowY + Math.max(1, hBelow);
                }

                // the trunk: one straight column joining all band lines
                if (trunkX !== null && lines.length > 1) {
                    for (let i = 1; i < lines.length; i++) {
                        for (let ry = lines[i - 1]; ry <= lines[i]; ry++) this.placeRoadTile(trunkX, ry, 1);
                    }
                }

                // --- columns for the buildings that are wider than tall --------
                // Same construction turned by 90 degrees: a straight road column
                // with buildings left and right, each touching it with its short
                // side. The columns hang off the last row line, so they are part
                // of the network without a single connecting tile.
                if (wide.length && trunkX !== null && lines.length) {
                    const baseY = lines[lines.length - 1];

                    // usable vertical run of a column, below the last row line
                    const colRun = (x) => {
                        let start = null, best = null;
                        for (let cy = baseY + 1; cy <= maxY; cy++) {
                            if (cy < maxY && this.grid.get(x + ',' + cy) === 0) {
                                if (start === null) start = cy;
                            } else if (start !== null) {
                                if (!best || cy - start > best[1] - best[0]) best = [start, cy];
                                start = null;
                            }
                        }
                        return best;
                    };

                    const fillColumn = (roadX, left, run, pending) => {
                        const taken = [];
                        let cy = run[0];
                        for (let i = 0; i < pending.length && cy < run[1]; i++) {
                            const b = pending[i];
                            if (b.used) continue;
                            const x = left ? roadX - b.width : roadX + 1;
                            if (x < minX || x + b.width > maxX) continue;
                            if (cy + b.height > run[1]) continue;
                            if (!this.canPlace(x, cy, b.width, b.height)) continue;
                            if (!this.gbKeepsStubSpace(x, cy, b.width, b.height)) continue;
                            this.placeEntity(b, x, cy, 1);
                            b.used = true;
                            taken.push([cy, cy + b.height]);
                            cy += b.height;
                        }
                        return taken;
                    };

                    let x = trunkX;
                    let cGuard = 0;
                    while (wide.some(b => !b.used) && x < maxX && cGuard++ < 200) {
                        const rest = wide.filter(b => !b.used);
                        const wLeft = Math.min(
                            Math.max.apply(null, rest.map(b => b.width)),
                            Math.max(1, maxX - x - 2)
                        );
                        const roadX = x + wLeft;
                        if (roadX + 1 >= maxX) break;

                        const run = colRun(roadX);
                        if (!run || run[1] - run[0] < 2) { x++; continue; }

                        const l = fillColumn(roadX, true, run, rest);
                        const r = fillColumn(roadX, false, run, wide.filter(b => !b.used));
                        const spans = l.concat(r);
                        if (!spans.length) { x = roadX + 1; continue; }

                        let to = -Infinity;
                        for (const s of spans) to = Math.max(to, s[1]);
                        // from the row line down to the last served building
                        for (let ry = baseY; ry < to; ry++) this.placeRoadTile(roadX, ry, 1);

                        let wRight = 0;
                        for (const b of this.placedBuildings) {
                            if (b.x === roadX + 1) wRight = Math.max(wRight, b.width);
                        }
                        x = roadX + 1 + Math.max(1, wRight);
                    }
                }

                for (const b of queue.concat(wide)) delete b.used;
            }

            // deterministic PRNG so seeded variants are reproducible
            makeRng(seed) {
                let s = seed >>> 0;
                return function() {
                    s = (s + 0x6D2B79F5) >>> 0;
                    let t = s;
                    t = Math.imul(t ^ (t >>> 15), t | 1);
                    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                };
            }

            // build order for the current variant: base key by sortMode, descending;
            // a seed > 0 jitters the keys for randomized restarts
            sortBuildings(list) {
                const rng = this.makeRng(this.seed || 1);
                const mode = this.sortMode;
                const keyed = list.map(b => {
                    let v;
                    if (mode === 'area') v = b.width * b.height;
                    else if (mode === 'width') v = b.width * 100 + b.height;
                    else v = b.height * 100 + b.width;
                    if (this.seed) v *= 0.7 + 0.6 * rng();
                    return [v, b];
                });
                keyed.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
                return keyed.map(k => k[1]);
            }

            // nest the great buildings directly against the map border, ring by ring
            // from the outside in - road stubs connect them afterwards
            placeGreatBuildingsAtEdge(gbs) {
                if (!gbs.length) return;
                const edgeDepth = this.computeEdgeDepth();
                const coords = [];
                for (const key of edgeDepth.keys()) {
                    const parts = key.split(',');
                    coords.push([+parts[0], +parts[1]]);
                }
                coords.sort((a, b) => {
                    const da = edgeDepth.get(a[0] + ',' + a[1]);
                    const db = edgeDepth.get(b[0] + ',' + b[1]);
                    if (da !== db) return da - db;
                    if (a[1] !== b[1]) return a[1] - b[1];
                    return a[0] - b[0];
                });
                // nesting must keep stub channels open: after each placement every
                // great building still needs a free neighbour tile that connects to
                // the largest free region, where the road network will live
                const placedGbs = [];
                const keepsAccess = (x, y, w, h) => {
                    const inFoot = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
                    const isFree = (px, py) => !inFoot(px, py) && this.grid.get(px + ',' + py) === 0;
                    const seen = new Set();
                    let largest = null;
                    for (const [key, val] of this.grid) {
                        if (val !== 0 || seen.has(key)) continue;
                        const parts = key.split(',');
                        if (inFoot(+parts[0], +parts[1])) continue;
                        const region = new Set([key]);
                        const stack = [[+parts[0], +parts[1]]];
                        seen.add(key);
                        while (stack.length) {
                            const t = stack.pop();
                            for (const nb of [[t[0]-1,t[1]],[t[0]+1,t[1]],[t[0],t[1]-1],[t[0],t[1]+1]]) {
                                const nk = nb[0] + ',' + nb[1];
                                if (seen.has(nk) || !isFree(nb[0], nb[1])) continue;
                                seen.add(nk);
                                region.add(nk);
                                stack.push(nb);
                            }
                        }
                        if (!largest || region.size > largest.size) largest = region;
                    }
                    if (!largest) return false;

                    const touches = (bx, by, bw, bh) => {
                        for (let i = bx; i < bx + bw; i++) {
                            if (largest.has(i + ',' + (by - 1)) || largest.has(i + ',' + (by + bh))) return true;
                        }
                        for (let j = by; j < by + bh; j++) {
                            if (largest.has((bx - 1) + ',' + j) || largest.has((bx + bw) + ',' + j)) return true;
                        }
                        return false;
                    };
                    if (!touches(x, y, w, h)) return false;
                    for (const g of placedGbs) {
                        if (!touches(g.x, g.y, g.width, g.height)) return false;
                    }
                    return true;
                };

                for (const b of this.sortBuildings(gbs)) {
                    for (const [x, y] of coords) {
                        if (this.grid.get(x + ',' + y) !== 0) continue;
                        if (this.canPlace(x, y, b.width, b.height) && keepsAccess(x, y, b.width, b.height)) {
                            this.placeEntity(b, x, y, 1);
                            placedGbs.push({ x: x, y: y, width: b.width, height: b.height });
                            break;
                        }
                    }
                }
            }

            // a placement must not take an unconnected great building's last free
            // neighbour tile - that single tile becomes its road stub later
            gbKeepsStubSpace(x, y, w, h) {
                const inFoot = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
                for (const g of this.placedBuildings) {
                    if (g.type !== 'greatbuilding') continue;
                    // only neighbours of the new footprint can be affected
                    if (g.x > x + w || g.x + g.width < x || g.y > y + h || g.y + g.height < y) continue;
                    if (this.isConnectedToRoad(g.x, g.y, g.width, g.height)) continue;
                    let free = false;
                    for (let i = g.x; i < g.x + g.width && !free; i++) {
                        if (!inFoot(i, g.y - 1) && this.grid.get(i + ',' + (g.y - 1)) === 0) free = true;
                        if (!inFoot(i, g.y + g.height) && this.grid.get(i + ',' + (g.y + g.height)) === 0) free = true;
                    }
                    for (let j = g.y; j < g.y + g.height && !free; j++) {
                        if (!inFoot(g.x - 1, j) && this.grid.get((g.x - 1) + ',' + j) === 0) free = true;
                        if (!inFoot(g.x + g.width, j) && this.grid.get((g.x + g.width) + ',' + j) === 0) free = true;
                    }
                    if (!free) return false;
                }
                return true;
            }

            // street connection rectangle: chain composites connect through their
            // head member only - the game wires the rest through the chain
            connRect(b) {
                if (b.chainMembers) {
                    const m0 = b.chainMembers[0];
                    return { x: b.x, y: b.y, width: m0.width, height: m0.height };
                }
                return b;
            }

            // connect every placed street building that has no road yet with the
            // shortest possible stub - one touching tile is enough
            connectPlacedBuildings() {
                const unconn = (b) => {
                    const r = this.connRect(b);
                    return b.street_level > 0 && !this.isConnectedToRoad(r.x, r.y, r.width, r.height);
                };
                let todo = this.placedBuildings.filter(unconn);

                while (todo.length && this.roadTiles.size) {
                    // BFS over free tiles from the current network, parents give the path
                    const dist = new Map(), parent = new Map(), fifo = [];
                    for (const key of this.roadTiles) { dist.set(key, 0); fifo.push(key); }
                    let head = 0;
                    while (head < fifo.length) {
                        const key = fifo[head++];
                        const parts = key.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        const d = dist.get(key);
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            if (this.grid.get(nk) === 0 && !dist.has(nk)) {
                                dist.set(nk, d + 1);
                                parent.set(nk, key);
                                fifo.push(nk);
                            }
                        }
                    }

                    // build the cheapest stub of this round, then re-measure: fresh
                    // stubs often bring the next building within zero extra tiles
                    let bestPath = null;
                    for (const b of todo) {
                        const r = this.connRect(b);
                        const per = [];
                        for (let i = r.x; i < r.x + r.width; i++) per.push(i + ',' + (r.y - 1), i + ',' + (r.y + r.height));
                        for (let j = r.y; j < r.y + r.height; j++) per.push((r.x - 1) + ',' + j, (r.x + r.width) + ',' + j);
                        for (const pt of per) {
                            const dv = dist.get(pt);
                            if (dv === undefined) continue;
                            if (bestPath && dv >= bestPath.length) continue;
                            const path = [];
                            let cur = pt;
                            while (cur && dist.get(cur) > 0) {
                                path.push(cur);
                                cur = parent.get(cur);
                            }
                            bestPath = path;
                        }
                    }
                    if (!bestPath) break;

                    for (const key of bestPath) {
                        const parts = key.split(',');
                        this.placeRoadTile(+parts[0], +parts[1]);
                    }
                    todo = todo.filter(unconn);
                }
            }

            // last-resort guarantee that nothing which needs a street stays cut
            // off: Dijkstra from the road network where free tiles are cheap and
            // tiles of removable buildings are expensive - if no free path exists
            // the cheapest blockers get torn down, the stub is built and the
            // demolished buildings are re-placed next to the network
            repairUnconnected() {
                const isProtected = (b) => b.type === 'main_building' || b.type === 'greatbuilding';
                const requeue = [];
                let guard = 0;

                while (this.roadTiles.size && guard++ < 60) {
                    const todo = this.placedBuildings.filter(b => {
                        const r = this.connRect(b);
                        return b.street_level > 0 && !this.isConnectedToRoad(r.x, r.y, r.width, r.height);
                    });
                    if (!todo.length) break;
                    const todoSet = new Set(todo);

                    // tile -> building lookup for demolition costs
                    const owner = new Map();
                    for (const b of this.placedBuildings) {
                        for (let i = b.x; i < b.x + b.width; i++) {
                            for (let j = b.y; j < b.y + b.height; j++) owner.set(i + ',' + j, b);
                        }
                    }

                    // Dijkstra with a small binary heap: free tile costs 1, a tile
                    // of a removable building costs a lot, so demolition stays the
                    // last resort; town hall, great buildings and the buildings
                    // still waiting for their own stub are walls
                    const dist = new Map(), parent = new Map();
                    const heap = [];
                    const push = (key, d) => {
                        heap.push([d, key]);
                        let i = heap.length - 1;
                        while (i > 0) {
                            const p = (i - 1) >> 1;
                            if (heap[p][0] <= heap[i][0]) break;
                            const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
                            i = p;
                        }
                    };
                    const pop = () => {
                        const top = heap[0];
                        const last = heap.pop();
                        if (heap.length) {
                            heap[0] = last;
                            let i = 0;
                            while (true) {
                                const l = i * 2 + 1, r = l + 1;
                                let s = i;
                                if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
                                if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
                                if (s === i) break;
                                const t = heap[s]; heap[s] = heap[i]; heap[i] = t;
                                i = s;
                            }
                        }
                        return top;
                    };

                    for (const key of this.roadTiles) { dist.set(key, 0); push(key, 0); }
                    while (heap.length) {
                        const entry = pop();
                        const d = entry[0], key = entry[1];
                        if (d > dist.get(key)) continue;
                        const parts = key.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            const val = this.grid.get(nk);
                            let step;
                            if (val === 0) step = 1;
                            else if (val === 1) {
                                const b = owner.get(nk);
                                if (!b || isProtected(b) || todoSet.has(b)) continue;
                                step = 200 + b.width * b.height;
                            }
                            else continue;
                            const nd = d + step;
                            if (dist.has(nk) && dist.get(nk) <= nd) continue;
                            dist.set(nk, nd);
                            parent.set(nk, key);
                            push(nk, nd);
                        }
                    }

                    // cheapest stub over all unconnected buildings, then re-measure
                    let bestPath = null, bestCost = Infinity;
                    for (const b of todo) {
                        const r = this.connRect(b);
                        const per = [];
                        for (let i = r.x; i < r.x + r.width; i++) per.push(i + ',' + (r.y - 1), i + ',' + (r.y + r.height));
                        for (let j = r.y; j < r.y + r.height; j++) per.push((r.x - 1) + ',' + j, (r.x + r.width) + ',' + j);
                        for (const pt of per) {
                            const dv = dist.get(pt);
                            if (dv === undefined || dv === 0 || dv >= bestCost) continue;
                            const path = [];
                            let cur = pt;
                            while (cur && dist.get(cur) > 0) { path.push(cur); cur = parent.get(cur); }
                            bestPath = path;
                            bestCost = dv;
                        }
                    }
                    if (!bestPath) break;

                    for (const key of bestPath) {
                        const b = owner.get(key);
                        if (b && this.grid.get(key) === 1) {
                            // demolish: free every tile, re-place the building later
                            for (let i = b.x; i < b.x + b.width; i++) {
                                for (let j = b.y; j < b.y + b.height; j++) this.grid.set(i + ',' + j, 0);
                            }
                            this.placedBuildings.splice(this.placedBuildings.indexOf(b), 1);
                            requeue.push(b);
                        }
                    }
                    for (const key of bestPath) {
                        const parts = key.split(',');
                        this.placeRoadTile(+parts[0], +parts[1]);
                    }
                }

                // re-place what the stubs tore down: next to a road if possible,
                // any free spot otherwise - the closing connect pass wires them up
                if (requeue.length) {
                    const coords = [];
                    for (let cy = this.mapBounds.minY; cy < this.mapBounds.maxY; cy++) {
                        for (let cx = this.mapBounds.minX; cx < this.mapBounds.maxX; cx++) coords.push([cx, cy]);
                    }
                    for (const b of requeue) {
                        // free tiles reachable from the road network - a fallback
                        // spot must border one of them, otherwise the closing
                        // connect pass could never give it a stub
                        const reach = new Set();
                        const fifo = [...this.roadTiles];
                        const visited = new Set(fifo);
                        let head = 0;
                        while (head < fifo.length) {
                            const key = fifo[head++];
                            const parts = key.split(',');
                            const kx = +parts[0], ky = +parts[1];
                            for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                                if (this.grid.get(nk) === 0 && !visited.has(nk)) {
                                    visited.add(nk);
                                    reach.add(nk);
                                    fifo.push(nk);
                                }
                            }
                        }
                        // chain composites connect through the head member only
                        const hw = b.chainMembers ? b.chainMembers[0].width : b.width;
                        const hh = b.chainMembers ? b.chainMembers[0].height : b.height;
                        let spot = null;
                        for (const [cx, cy] of coords) {
                            if (this.grid.get(cx + ',' + cy) !== 0 || !this.canPlace(cx, cy, b.width, b.height)) continue;
                            if (!this.gbKeepsStubSpace(cx, cy, b.width, b.height)) continue;
                            if (this.isConnectedToRoad(cx, cy, hw, hh)) { spot = [cx, cy]; break; }
                            if (!spot) {
                                let touches = false;
                                for (let i = cx; i < cx + hw && !touches; i++) {
                                    if (reach.has(i + ',' + (cy - 1)) || reach.has(i + ',' + (cy + hh))) touches = true;
                                }
                                for (let j = cy; j < cy + hh && !touches; j++) {
                                    if (reach.has((cx - 1) + ',' + j) || reach.has((cx + hw) + ',' + j)) touches = true;
                                }
                                if (touches) spot = [cx, cy];
                            }
                        }
                        if (spot) this.placeEntity(b, spot[0], spot[1], 1);
                    }
                    this.connectPlacedBuildings();
                }
            }

            // roads must form one network reaching the town hall: join stray
            // components with the shortest free paths, drop what stays unreachable
            unifyRoadNetwork() {
                if (!this.roadTiles.size) return;

                const compOf = new Map();
                const comps = [];
                for (const key of this.roadTiles) {
                    if (compOf.has(key)) continue;
                    const comp = [];
                    const stack = [key];
                    compOf.set(key, comps.length);
                    while (stack.length) {
                        const k = stack.pop();
                        comp.push(k);
                        const parts = k.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            if (this.roadTiles.has(nk) && !compOf.has(nk)) {
                                compOf.set(nk, comps.length);
                                stack.push(nk);
                            }
                        }
                    }
                    comps.push(comp);
                }
                if (comps.length <= 1) return;

                // the component touching the town hall is the main one; without
                // a placed town hall the largest component takes that role
                let mainIdx = -1;
                if (this.townHallPos) {
                    const [tx, ty] = this.townHallPos;
                    const per = [];
                    for (let i = tx; i < tx + this.townHall.width; i++) per.push(i + ',' + (ty - 1), i + ',' + (ty + this.townHall.height));
                    for (let j = ty; j < ty + this.townHall.height; j++) per.push((tx - 1) + ',' + j, (tx + this.townHall.width) + ',' + j);
                    for (const pt of per) {
                        if (compOf.has(pt)) { mainIdx = compOf.get(pt); break; }
                    }
                }
                if (mainIdx === -1) {
                    comps.forEach((c, i) => { if (mainIdx === -1 || c.length > comps[mainIdx].length) mainIdx = i; });
                }

                let main = comps[mainIdx];
                let others = comps.filter((c, i) => i !== mainIdx);

                while (others.length) {
                    // BFS over free tiles from the main network
                    const dist = new Map(), parent = new Map(), fifo = [];
                    for (const key of main) { dist.set(key, 0); fifo.push(key); }
                    let head = 0;
                    while (head < fifo.length) {
                        const key = fifo[head++];
                        const parts = key.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        const d = dist.get(key);
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            if (this.grid.get(nk) === 0 && !dist.has(nk)) {
                                dist.set(nk, d + 1);
                                parent.set(nk, key);
                                fifo.push(nk);
                            }
                        }
                    }

                    // stray component with the cheapest link to the main network
                    let bestPath = null, bestIdx = -1;
                    for (let ci = 0; ci < others.length; ci++) {
                        for (const key of others[ci]) {
                            const parts = key.split(',');
                            const kx = +parts[0], ky = +parts[1];
                            for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                                const dv = dist.get(nk);
                                if (dv === undefined || dv === 0) continue;
                                if (bestPath && dv >= bestPath.length) continue;
                                const path = [];
                                let cur = nk;
                                while (cur && dist.get(cur) > 0) {
                                    path.push(cur);
                                    cur = parent.get(cur);
                                }
                                bestPath = path;
                                bestIdx = ci;
                            }
                        }
                    }

                    if (!bestPath) break;
                    for (const key of bestPath) {
                        const parts = key.split(',');
                        this.placeRoadTile(+parts[0], +parts[1]);
                    }
                    main = main.concat(bestPath, others[bestIdx]);
                    others.splice(bestIdx, 1);
                }

                // still stray = unusable in the game, remove those roads
                for (const comp of others) {
                    for (const key of comp) {
                        this.grid.set(key, 0);
                        this.roadTiles.delete(key);
                        this.roadLevel.delete(key);
                    }
                }
            }
    
            placeRoadTile(x, y, level) {
                const key = x + ',' + y;
                const lvl = level || 1;
                if (this.grid.get(key) === 0) {
                    this.grid.set(key, 2);
                    this.roadTiles.add(key);
                    this.roadLevel.set(key, lvl);
                    return true;
                }
                // an existing road tile can be upgraded to two-lane
                if (this.grid.get(key) === 2 && lvl > (this.roadLevel.get(key) || 1)) {
                    this.roadLevel.set(key, lvl);
                    return true;
                }
                return false;
            }
    
            // spare space of the finished city: really empty tiles plus the
            // reserved square, which is empty on purpose
            isFreeTile(x, y) {
                const v = this.grid.get(x + ',' + y);
                return v === 0 || v === 7;
            }

            isFreeKey(key) {
                const v = this.grid.get(key);
                return v === 0 || v === 7;
            }

            canPlace(x, y, w, h) {
                for (let i = x; i < x + w; i++) {
                    for (let j = y; j < y + h; j++) {
                        if (this.grid.get(i + ',' + j) !== 0) return false;
                    }
                }
                return true;
            }
    
            placeEntity(item, x, y, etype = 1) {
                for (let i = x; i < x + item.width; i++) {
                    for (let j = y; j < y + item.height; j++) {
                        const key = i + ',' + j;
                        this.grid.set(key, etype);
                        if (etype === 2) { this.roadTiles.add(key); this.roadLevel.set(key, 1); }
                    }
                }
                this.placedBuildings.push({ ...item, x: x, y: y });
            }
    
            isConnectedToRoad(x, y, w, h) {
                for (let i = x; i < x + w; i++) if (this.grid.get(i + ',' + (y - 1)) === 2) return true;
                for (let i = x; i < x + w; i++) if (this.grid.get(i + ',' + (y + h)) === 2) return true;
                for (let j = y; j < y + h; j++) if (this.grid.get((x - 1) + ',' + j) === 2) return true;
                for (let j = y; j < y + h; j++) if (this.grid.get((x + w) + ',' + j) === 2) return true;
                return false;
            }

            // all two-lane tiles reachable from the town hall through two-lane
            // tiles only - the game demands an unbroken two-lane path
            linkedTwoLaneTiles() {
                const linked = new Set();
                if (!this.townHallPos) return linked;
                const isL2 = (key) => this.grid.get(key) === 2 && (this.roadLevel.get(key) || 1) >= 2;
                const stack = [];
                const seed = (key) => {
                    if (isL2(key) && !linked.has(key)) { linked.add(key); stack.push(key); }
                };
                const [tx, ty] = this.townHallPos;
                for (let i = tx; i < tx + this.townHall.width; i++) { seed(i + ',' + (ty - 1)); seed(i + ',' + (ty + this.townHall.height)); }
                for (let j = ty; j < ty + this.townHall.height; j++) { seed((tx - 1) + ',' + j); seed((tx + this.townHall.width) + ',' + j); }
                while (stack.length) {
                    const k = stack.pop();
                    const parts = k.split(',');
                    const kx = +parts[0], ky = +parts[1];
                    seed((kx - 1) + ',' + ky);
                    seed((kx + 1) + ',' + ky);
                    seed(kx + ',' + (ky - 1));
                    seed(kx + ',' + (ky + 1));
                }
                return linked;
            }

            // does the building border on any tile of the given two-lane set?
            touchesTwoLane(b, linked) {
                for (let i = b.x; i < b.x + b.width; i++) {
                    if (linked.has(i + ',' + (b.y - 1)) || linked.has(i + ',' + (b.y + b.height))) return true;
                }
                for (let j = b.y; j < b.y + b.height; j++) {
                    if (linked.has((b.x - 1) + ',' + j) || linked.has((b.x + b.width) + ',' + j)) return true;
                }
                return false;
            }

            // while more two-lane buildings wait, a placement (footprint plus the
            // planned corridor tiles) must not entomb the two-lane network: the
            // corridor blocks must still reach the largest free region, where the
            // future buildings will go - and with enough room for all of them,
            // one reachable block in a dead-end bottleneck is worthless
            keepsTwoLaneGrowth(x, y, w, h, pathTiles, needBlocks) {
                const need = Math.max(1, needBlocks || 1);
                const linked = this.linkedTwoLaneTiles();
                const pathSet = new Set(pathTiles || []);
                if (!linked.size && !pathSet.size) return true;
                const inFoot = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
                // corridor tiles count as two-lane road, not as free space
                const val = (key) => pathSet.has(key) ? 2 : this.grid.get(key);

                // largest free region outside the planned footprint
                const regionOf = new Map();
                let largestId = -1, largestSize = 0, regionId = 0;
                for (const [key] of this.grid) {
                    if (val(key) !== 0 || regionOf.has(key)) continue;
                    const parts = key.split(',');
                    if (inFoot(+parts[0], +parts[1])) continue;
                    const id = regionId++;
                    let size = 0;
                    const stack = [key];
                    regionOf.set(key, id);
                    while (stack.length) {
                        const k = stack.pop();
                        size++;
                        const p2 = k.split(',');
                        const kx = +p2[0], ky = +p2[1];
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            if (val(nk) !== 0 || regionOf.has(nk)) continue;
                            const p3 = nk.split(',');
                            if (inFoot(+p3[0], +p3[1])) continue;
                            regionOf.set(nk, id);
                            stack.push(nk);
                        }
                    }
                    if (size > largestSize) { largestSize = size; largestId = id; }
                }
                if (largestId === -1) return true;

                // block-level reachability BFS: a tile-connected escape through a
                // one tile wide gap is useless, the 2x2 corridor blocks themselves
                // must reach a block lying fully inside the largest free region
                const blockValid = (bx, by) => {
                    for (const pt of [[bx, by], [bx + 1, by], [bx, by + 1], [bx + 1, by + 1]]) {
                        if (inFoot(pt[0], pt[1])) return false;
                        const v = val(pt[0] + ',' + pt[1]);
                        if (v !== 0 && v !== 2) return false;
                    }
                    return true;
                };
                const inRegionBlock = (bx, by) => {
                    for (const pt of [[bx, by], [bx + 1, by], [bx, by + 1], [bx + 1, by + 1]]) {
                        if (regionOf.get(pt[0] + ',' + pt[1]) !== largestId) return false;
                    }
                    return true;
                };
                const seen = new Set();
                const stack = [];
                const seed = (bx, by) => {
                    const key = bx + ',' + by;
                    if (!seen.has(key) && blockValid(bx, by)) { seen.add(key); stack.push([bx, by]); }
                };
                // seeds: blocks on the network (with the planned corridor) plus
                // fresh blocks anchored at the town hall
                for (const key of [...linked, ...pathSet]) {
                    const parts = key.split(',');
                    const kx = +parts[0], ky = +parts[1];
                    for (let bx = kx - 1; bx <= kx; bx++) {
                        for (let by = ky - 1; by <= ky; by++) seed(bx, by);
                    }
                }
                if (this.townHallPos) {
                    const th = { x: this.townHallPos[0], y: this.townHallPos[1], width: this.townHall.width, height: this.townHall.height };
                    for (let by = th.y - 2; by <= th.y + th.height; by++) {
                        for (let bx = th.x - 2; bx <= th.x + th.width; bx++) {
                            if (this.blockTouchesRect(bx, by, th)) seed(bx, by);
                        }
                    }
                }
                let regionBlocks = 0;
                while (stack.length) {
                    const blk = stack.pop();
                    if (inRegionBlock(blk[0], blk[1])) {
                        regionBlocks++;
                        if (regionBlocks >= need) return true;
                    }
                    seed(blk[0] - 1, blk[1]);
                    seed(blk[0] + 1, blk[1]);
                    seed(blk[0], blk[1] - 1);
                    seed(blk[0], blk[1] + 1);
                }
                return false;
            }

            // the four tile keys of the 2x2 block with this top-left corner
            blockTiles(bx, by) {
                return [bx + ',' + by, (bx + 1) + ',' + by, bx + ',' + (by + 1), (bx + 1) + ',' + (by + 1)];
            }

            // does the 2x2 block orthogonally touch the given rectangle?
            blockTouchesRect(bx, by, r) {
                for (const key of this.blockTiles(bx, by)) {
                    const parts = key.split(',');
                    const px = +parts[0], py = +parts[1];
                    if ((py === r.y - 1 || py === r.y + r.height) && px >= r.x && px < r.x + r.width) return true;
                    if ((px === r.x - 1 || px === r.x + r.width) && py >= r.y && py < r.y + r.height) return true;
                }
                return false;
            }

            // Dijkstra over 2x2 block top-left positions. Two-lane streets are 2x2
            // pieces, so corridors are built from such blocks; upgrading existing
            // one-lane tiles is cheaper than claiming free ones. Seeds: blocks
            // fully inside the linked network (free) and blocks touching the town
            // hall (anchor of a brand-new network). With footprint=true every
            // block costs - existing two-lane included - so the cheapest chain
            // is the shortest one: that is the pricing for the trim pass, which
            // decides how much two-lane road survives at all. With a parity
            // [px, py] the search runs on a step-2 lattice: all blocks are
            // disjoint like the game's real 2x2 pieces, so the result is always
            // buildable from whole pieces
            twoLaneBlockDist(linked, footprint, parity) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;
                const step = parity ? 2 : 1;
                const onLattice = (bx, by) => !parity
                    || (((bx % 2) + 2) % 2 === parity[0] && ((by % 2) + 2) % 2 === parity[1]);
                // -1 = blocked, otherwise price: free tile 2, one-lane road 1, two-lane 0
                const blockCost = (bx, by) => {
                    let cost = 0;
                    for (const key of this.blockTiles(bx, by)) {
                        const v = this.grid.get(key);
                        if (v !== 0 && v !== 2) return -1;
                        if (footprint) cost += (v === 0) ? 3 : 2;
                        else if (v === 0) cost += 2;
                        else if ((this.roadLevel.get(key) || 1) < 2) cost += 1;
                    }
                    return cost;
                };
                const th = { x: this.townHallPos[0], y: this.townHallPos[1], width: this.townHall.width, height: this.townHall.height };

                const dist = new Map(), parent = new Map();
                const heap = [];
                const push = (key, d) => {
                    heap.push([d, key]);
                    let i = heap.length - 1;
                    while (i > 0) {
                        const p = (i - 1) >> 1;
                        if (heap[p][0] <= heap[i][0]) break;
                        const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
                        i = p;
                    }
                };
                const pop = () => {
                    const top = heap[0];
                    const last = heap.pop();
                    if (heap.length) {
                        heap[0] = last;
                        let i = 0;
                        while (true) {
                            const l = i * 2 + 1, r = l + 1;
                            let s = i;
                            if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
                            if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
                            if (s === i) break;
                            const t = heap[s]; heap[s] = heap[i]; heap[i] = t;
                            i = s;
                        }
                    }
                    return top;
                };

                for (let by = minY; by < maxY - 1; by++) {
                    for (let bx = minX; bx < maxX - 1; bx++) {
                        if (!onLattice(bx, by)) continue;
                        const c = blockCost(bx, by);
                        if (c < 0) continue;
                        let d = -1;
                        if (linked.size && this.blockTiles(bx, by).every(k => linked.has(k))) d = 0;
                        else if (this.blockTouchesRect(bx, by, th)) d = c;
                        if (d >= 0) {
                            const bk = bx + ',' + by;
                            if (!dist.has(bk) || dist.get(bk) > d) { dist.set(bk, d); push(bk, d); }
                        }
                    }
                }

                while (heap.length) {
                    const entry = pop();
                    const d = entry[0], key = entry[1];
                    if (d > dist.get(key)) continue;
                    const parts = key.split(',');
                    const bx = +parts[0], by = +parts[1];
                    for (const nb of [[bx-step,by],[bx+step,by],[bx,by-step],[bx,by+step]]) {
                        if (nb[0] < minX || nb[0] >= maxX - 1 || nb[1] < minY || nb[1] >= maxY - 1) continue;
                        const c = blockCost(nb[0], nb[1]);
                        if (c < 0) continue;
                        const nk = nb[0] + ',' + nb[1];
                        const nd = d + c;
                        if (dist.has(nk) && dist.get(nk) <= nd) continue;
                        dist.set(nk, nd);
                        parent.set(nk, key);
                        push(nk, nd);
                    }
                }
                return { dist: dist, parent: parent };
            }

            // build the block path ending in this block, network first
            materializeBlockPath(bestKey, parent) {
                let cur = bestKey;
                while (cur !== undefined) {
                    const parts = cur.split(',');
                    for (const key of this.blockTiles(+parts[0], +parts[1])) {
                        const kp = key.split(',');
                        this.placeRoadTile(+kp[0], +kp[1], 2);
                    }
                    cur = parent.get(cur);
                }
            }

            // two-lane requirement: the building must touch a two-lane road whose
            // network reaches the town hall - give every already placed two-lane
            // building the cheapest block corridor that is still possible
            connectTwoLane() {
                if (!this.townHallPos) return;
                let guard = 0;
                while (guard++ < 40) {
                    const linked = this.linkedTwoLaneTiles();
                    const todo = this.placedBuildings.filter(b => (b.street_level || 0) >= 2 && !this.touchesTwoLane(this.connRect(b), linked));
                    if (!todo.length) return;

                    const bd = this.twoLaneBlockDist(linked);

                    // cheapest corridor over all waiting buildings, then re-measure
                    let bestKey = null, bestCost = Infinity;
                    for (const t of todo) {
                        const r = this.connRect(t);
                        for (let by = r.y - 2; by <= r.y + r.height; by++) {
                            for (let bx = r.x - 2; bx <= r.x + r.width; bx++) {
                                if (!this.blockTouchesRect(bx, by, r)) continue;
                                const dv = bd.dist.get(bx + ',' + by);
                                if (dv !== undefined && dv < bestCost) { bestCost = dv; bestKey = bx + ',' + by; }
                            }
                        }
                    }
                    if (bestKey === null) return;

                    this.materializeBlockPath(bestKey, bd.parent);
                }
            }

            // the strategies lay two-lane roads generously (double band rows, a
            // double trunk) and pruneRoadsSmart never touches level-2 tiles - so
            // re-route every two-lane building onto its cheapest possible block
            // corridor from the town hall (reusing existing two-lane for free,
            // upgrading one-lane cheaply, claiming free tiles as the last
            // resort) and downgrade every other two-lane tile to one-lane,
            // where the prune pass can take it back; a single two-lane building
            // next to the town hall ends up with one single 2x2 piece
            trimTwoLane() {
                if (!this.townHallPos) return;
                const l2Buildings = this.placedBuildings.filter(b => (b.street_level || 0) >= 2);
                if (!l2Buildings.length) {
                    for (const key of this.roadTiles) {
                        if ((this.roadLevel.get(key) || 1) >= 2) this.roadLevel.set(key, 1);
                    }
                    return;
                }

                // cheapest chain head per building for a given Dijkstra tree,
                // null when some building is unreachable in it
                const resolveChains = (bd) => {
                    const heads = [];
                    let total = 0;
                    for (const b of l2Buildings) {
                        const r = this.connRect(b);
                        let bestKey = null, bestCost = Infinity;
                        for (let by = r.y - 2; by <= r.y + r.height; by++) {
                            for (let bx = r.x - 2; bx <= r.x + r.width; bx++) {
                                if (!this.blockTouchesRect(bx, by, r)) continue;
                                const dv = bd.dist.get(bx + ',' + by);
                                if (dv !== undefined && dv < bestCost) { bestCost = dv; bestKey = bx + ',' + by; }
                            }
                        }
                        if (bestKey === null) return null;
                        heads.push(bestKey);
                        total += bestCost;
                    }
                    return { heads: heads, total: total };
                };

                // fresh block Dijkstra seeded at the town hall only, footprint
                // pricing (shortest chain wins) - all chains come from one tree,
                // so corridors of nearby buildings share their common prefix
                // automatically. Preferred: a step-2 parity lattice, whose blocks
                // are disjoint like the game's real 2x2 pieces - the cheapest of
                // the four lattices wins; the free unit-step search is only the
                // fallback for buildings no lattice can reach
                let chosen = null, chosenBd = null;
                for (const par of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                    const bd = this.twoLaneBlockDist(new Set(), true, par);
                    const res = resolveChains(bd);
                    if (res && (!chosen || res.total < chosen.total)) { chosen = res; chosenBd = bd; }
                }
                if (!chosen) {
                    const bd = this.twoLaneBlockDist(new Set(), true);
                    const res = resolveChains(bd);
                    // not even freely reachable: keep the network untouched,
                    // trimming could cut a working connection
                    if (!res) return;
                    chosen = res;
                    chosenBd = bd;
                }

                const needed = new Set();
                for (const bestKey of chosen.heads) {
                    let cur = bestKey;
                    while (cur !== undefined) {
                        const parts = cur.split(',');
                        for (const key of this.blockTiles(+parts[0], +parts[1])) needed.add(key);
                        cur = chosenBd.parent.get(cur);
                    }
                }

                // build the new corridors (claims free tiles, upgrades one-lane
                // tiles), then downgrade all two-lane tiles outside of them
                for (const key of needed) {
                    const parts = key.split(',');
                    this.placeRoadTile(+parts[0], +parts[1], 2);
                }
                for (const key of this.roadTiles) {
                    if ((this.roadLevel.get(key) || 1) >= 2 && !needed.has(key)) this.roadLevel.set(key, 1);
                }
            }

            // remove a placed building again and free its tiles
            /**
             * Packs the buildings that need no road, straight from one corner.
             *
             * The careful packer re-scans every free region of the whole map for
             * each single building - with several hundred of them that costs
             * seconds per run and still leaves seams all over the city. This one
             * takes the first spot that fits, scanning row by row from the top
             * left, keeping a per-row hint so the scan does not restart at the
             * beginning every time. Packing tight from one corner is exactly what
             * leaves the spare space as one block at the far end.
             *
             * @param {Array} list - roadless buildings, largest first
             */
            packRoadlessFast(list) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;
                // first free column per row, so the scan skips the built-up part
                const rowHint = new Map();

                for (const b of list) {
                    let done = false;
                    for (let y = minY; y + b.height <= maxY && !done; y++) {
                        let firstFree = -1;
                        const from = rowHint.has(y) ? rowHint.get(y) : minX;
                        for (let x = from; x + b.width <= maxX; x++) {
                            if (this.grid.get(x + ',' + y) !== 0) continue;
                            if (firstFree < 0) firstFree = x;
                            if (this.canPlace(x, y, b.width, b.height)) {
                                this.placeEntity(b, x, y, 1);
                                done = true;
                                break;
                            }
                        }
                        if (firstFree >= 0) rowHint.set(y, firstFree);
                    }
                }
            }

            /**
             * Shelf packing for the roadless mass.
             *
             * The row-major packer fills every row to its right edge and leaves a
             * ragged vertical seam behind, so a 2x2 can end up homeless while
             * dozens of single tiles sit free. Here the buildings are grouped by
             * height and each shelf is filled with equal-height pieces only, which
             * keeps the leftover space rectangular instead of jagged.
             *
             * @param {Array} list - roadless buildings
             */
            packRoadlessShelf(list) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;

                // tallest first, so the deep shelves are laid while space is free
                const byHeight = new Map();
                for (const b of list) {
                    if (!byHeight.has(b.height)) byHeight.set(b.height, []);
                    byHeight.get(b.height).push(b);
                }
                const heights = [...byHeight.keys()].sort((a, b) => b - a);

                for (const h of heights) {
                    const group = byHeight.get(h).sort((a, b) => b.width - a.width);
                    let i = 0;
                    for (let y = minY; y + h <= maxY && i < group.length; y++) {
                        // walk this shelf once, dropping in what fits
                        for (let x = minX; i < group.length && x + group[i].width <= maxX; ) {
                            const b = group[i];
                            if (this.canPlace(x, y, b.width, h)) {
                                this.placeEntity(b, x, y, 1);
                                x += b.width;
                                i++;
                            } else {
                                x++;
                            }
                        }
                    }
                }

                // whatever the shelves could not take falls back to first fit
                const done = new Set(this.placedBuildings.map(b => b.id));
                const rest = list.filter(b => !done.has(b.id));
                if (rest.length) this.packRoadlessFast(rest);
            }

            /**
             * The free space of the map cut into every maximal empty rectangle.
             *
             * "Maximal" means a rectangle that cannot grow in any direction.
             * Their set covers every spot a building could possibly take, so a
             * packer walking this list never misses a fit that exists. Built by
             * accumulating rows top down: for each pair of rows the columns
             * free in all of them form runs, and a run that can grow neither up
             * nor down is one such rectangle.
             *
             * @returns {Array<{x:number,y:number,w:number,h:number}>} in map coordinates
             */
            freeMaximalRects() {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;
                const W = maxX - minX, H = maxY - minY;
                if (W <= 0 || H <= 0) return [];

                const free = new Uint8Array(W * H);
                for (let y = 0; y < H; y++) {
                    const row = y * W;
                    for (let x = 0; x < W; x++) {
                        free[row + x] = this.grid.get((minX + x) + ',' + (minY + y)) === 0 ? 1 : 0;
                    }
                }

                const rects = [];
                const alive = new Uint8Array(W);
                for (let y1 = 0; y1 < H; y1++) {
                    alive.set(free.subarray(y1 * W, y1 * W + W));
                    for (let y2 = y1; y2 < H; y2++) {
                        // columns free in every row of the band y1..y2
                        const band = y2 * W;
                        let any = false;
                        for (let x = 0; x < W; x++) {
                            if (!alive[x]) continue;
                            if (y2 > y1 && !free[band + x]) { alive[x] = 0; continue; }
                            any = true;
                        }
                        // the band only ever shrinks - once empty it stays empty
                        if (!any) break;

                        const above = (y1 - 1) * W, below = (y2 + 1) * W;
                        let x = 0;
                        while (x < W) {
                            if (!alive[x]) { x++; continue; }
                            let x2 = x;
                            while (x2 + 1 < W && alive[x2 + 1]) x2++;
                            // a run that could still grow up or down is only a
                            // part of a bigger rectangle, emitted on its own pass
                            let grows = y1 > 0;
                            if (grows) {
                                for (let i = x; i <= x2; i++) if (!free[above + i]) { grows = false; break; }
                            }
                            if (!grows && y2 + 1 < H) {
                                grows = true;
                                for (let i = x; i <= x2; i++) if (!free[below + i]) { grows = false; break; }
                            }
                            if (!grows) rects.push({ x: minX + x, y: minY + y1, w: x2 - x + 1, h: y2 - y1 + 1 });
                            x = x2 + 1;
                        }
                    }
                }
                return rects;
            }

            /**
             * How much of a footprint's outline would rest against something
             * solid - another building, a road, the reserve or the map border.
             *
             * A building that nestles into the city takes its tiles out of the
             * free area without cutting into it; one dropped into the middle of
             * open space splits that space in two. Measured as a permille of
             * the outline so wide and narrow buildings compare fairly.
             *
             * @returns {number} 0 (free-standing) .. 1000 (fully enclosed)
             */
            contactScore(x, y, w, h) {
                let touch = 0;
                for (let i = x; i < x + w; i++) {
                    if (this.grid.get(i + ',' + (y - 1)) !== 0) touch++;
                    if (this.grid.get(i + ',' + (y + h)) !== 0) touch++;
                }
                for (let j = y; j < y + h; j++) {
                    if (this.grid.get((x - 1) + ',' + j) !== 0) touch++;
                    if (this.grid.get((x + w) + ',' + j) !== 0) touch++;
                }
                return Math.round(1000 * touch / (2 * (w + h)));
            }

            /**
             * Maximal-rectangle packing for the roadless mass.
             *
             * The row-major packer fills from a corner and leaves a one-tile
             * seam wherever two neighbouring rows end at different heights.
             * Those seams add up to dozens of tiles that are free but too thin
             * to build on, while whole buildings end up homeless. Here every
             * candidate spot is a corner of a maximal free rectangle and the
             * spot with the least useless leftover wins: a strip exactly one
             * tile wide is what almost nothing fits into, so it is penalised
             * first, then the usual best-short-side fit, then top-left.
             *
             * The rectangle list is split after every placement and rebuilt
             * from the grid every so often - splitting alone would pile up
             * rectangles contained in one another, and rebuilding is cheap.
             *
             * @param {Array} list - roadless buildings, any order
             * @param {number} [jitter] - seed that shuffles the build order; 0 is deterministic
             * @returns {Array} the ones that found no spot at all
             */
            packRoadlessMaxRects(list, jitter) {
                let rects = this.freeMaximalRects();
                let since = 0;
                const unplaced = [];

                // Big pieces first: they are the ones with no second choice,
                // and the small ones still find the gaps they leave behind.
                // The last few tiles of a full city are decided by the order,
                // not by the rules - so a seed can shuffle it and the search
                // gets a genuinely different packing out of the same city.
                const rng = jitter ? this.makeRng(jitter) : null;
                const items = list.map(b => {
                    let v = b.width * b.height;
                    // a one-tile-wide building is far pickier than its area
                    // suggests - it needs its tiles in a line and only a line
                    // will do, so it is served among the big pieces instead of
                    // being left the scraps
                    if (Math.min(b.width, b.height) === 1 && Math.max(b.width, b.height) > 1) v *= 2;
                    if (rng) v *= 0.7 + 0.6 * rng();
                    return [v, b];
                });
                items.sort((a, b) => b[0] - a[0]
                    || Math.max(b[1].width, b[1].height) - Math.max(a[1].width, a[1].height)
                    || b[1].height - a[1].height);

                for (const entry of items) {
                    const b = entry[1];
                    if (since >= 24 || rects.length > 6000) {
                        rects = this.freeMaximalRects();
                        since = 0;
                    }

                    // Candidate spots, deduplicated: neighbouring maximal
                    // rectangles share corners, and the same spot reached
                    // through a tighter rectangle keeps the better keys.
                    // spot -> [oneTileGaps, shortLeftover, longLeftover, x, y]
                    const spots = new Map();
                    for (const r of rects) {
                        const gw = r.w - b.width, gh = r.h - b.height;
                        if (gw < 0 || gh < 0) continue;
                        const k0 = (gw === 1 ? 1 : 0) + (gh === 1 ? 1 : 0);
                        const k1 = gw < gh ? gw : gh;
                        const k2 = gw < gh ? gh : gw;
                        for (const c of [[r.x, r.y], [r.x + gw, r.y], [r.x, r.y + gh], [r.x + gw, r.y + gh]]) {
                            const key = c[0] + ',' + c[1];
                            const old = spots.get(key);
                            if (old && (k0 > old[0]
                                || (k0 === old[0] && (k1 > old[1]
                                || (k1 === old[1] && k2 >= old[2]))))) continue;
                            spots.set(key, [k0, k1, k2, c[0], c[1]]);
                        }
                    }

                    // best = [oneTileGaps, -contact, shortLeftover, longLeftover, y, x]
                    let best = null;
                    for (const s of spots.values()) {
                        // a spot that cannot beat the leader on the gap count is
                        // dropped before a single tile is looked at
                        if (best && s[0] > best[0]) continue;
                        if (!this.canPlace(s[3], s[4], b.width, b.height)) continue;
                        const contact = -this.contactScore(s[3], s[4], b.width, b.height);
                        let take = !best;
                        if (best) {
                            if (s[0] !== best[0]) take = s[0] < best[0];
                            else if (contact !== best[1]) take = contact < best[1];
                            else if (s[1] !== best[2]) take = s[1] < best[2];
                            else if (s[2] !== best[3]) take = s[2] < best[3];
                            else if (s[4] !== best[4]) take = s[4] < best[4];
                            else take = s[3] < best[5];
                        }
                        if (take) best = [s[0], contact, s[1], s[2], s[4], s[3]];
                    }

                    if (!best) { unplaced.push(b); continue; }
                    const px = best[5], py = best[4];
                    this.placeEntity(b, px, py, 1);
                    since++;

                    // every rectangle the footprint touches falls apart into the
                    // strips left of, right of, above and below it
                    const next = [];
                    for (const r of rects) {
                        if (px + b.width <= r.x || px >= r.x + r.w
                            || py + b.height <= r.y || py >= r.y + r.h) { next.push(r); continue; }
                        if (py > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: py - r.y });
                        if (py + b.height < r.y + r.h) next.push({ x: r.x, y: py + b.height, w: r.w, h: r.y + r.h - py - b.height });
                        if (px > r.x) next.push({ x: r.x, y: r.y, w: px - r.x, h: r.h });
                        if (px + b.width < r.x + r.w) next.push({ x: px + b.width, y: r.y, w: r.x + r.w - px - b.width, h: r.h });
                    }
                    rects = next;
                }

                return unplaced;
            }

            /**
             * Slide every roadless building up and left until it rests against
             * the city. This closes the thin seams the placement order leaves
             * between the rows, so the roadless mass stands as one solid block
             * and the spare space collects at the far end of the map.
             *
             * Which direction goes first decides how the seams that do survive
             * are turned: pulling up first leaves them lying flat between the
             * rows, pulling left first stands them upright between the columns.
             * A city full of tall thin buildings needs upright seams and a city
             * full of flat ones needs the opposite, so both are tried.
             *
             * @param {Array} [dirs] - slide directions in order, default up then left
             */
            compactRoadless(dirs) {
                const steps = dirs || [[0, -1], [-1, 0]];
                const fitsAt = (b, nx, ny) => {
                    for (let i = nx; i < nx + b.width; i++) {
                        for (let j = ny; j < ny + b.height; j++) {
                            const v = this.grid.get(i + ',' + j);
                            if (v === 0) continue;
                            if (v === 1 && i >= b.x && i < b.x + b.width && j >= b.y && j < b.y + b.height) continue;
                            return false;
                        }
                    }
                    return true;
                };
                const applyMove = (b, nx, ny, val) => {
                    for (let i = b.x; i < b.x + b.width; i++) {
                        for (let j = b.y; j < b.y + b.height; j++) this.grid.set(i + ',' + j, 0);
                    }
                    for (let i = nx; i < nx + b.width; i++) {
                        for (let j = ny; j < ny + b.height; j++) this.grid.set(i + ',' + j, val);
                    }
                    b.x = nx;
                    b.y = ny;
                };
                // pure top-left gravity, processed in top-left order so a whole
                // row cascades within one pass; a temporary gap behind a sliding
                // building is closed by the neighbours that follow. If a slide
                // seals a pocket for good, the wasted metric makes that variant
                // lose the selection - no veto needed here
                let movedAny = true, guard = 0;
                while (movedAny && guard++ < 15) {
                    movedAny = false;
                    const order = this.placedBuildings
                        .filter(b => b.street_level === 0 && b.type !== 'main_building')
                        .sort((p, q) => (p.x + p.y) - (q.x + q.y) || p.y - q.y);
                    for (const b of order) {
                        for (const [dx, dy] of steps) {
                            while (fitsAt(b, b.x + dx, b.y + dy)) {
                                applyMove(b, b.x + dx, b.y + dy, 1);
                                movedAny = true;
                            }
                        }
                    }
                }
            }

            // second copy of a snapshot: restore() hands its own maps to the
            // optimizer, so a snapshot that is restored more than once has to
            // be duplicated first or the next phase writes into it
            copyOf(s) {
                return {
                    grid: new Map(s.grid),
                    roadTiles: new Set(s.roadTiles),
                    roadLevel: new Map(s.roadLevel),
                    placed: s.placed.map(b => ({ ...b })),
                    townHallPos: s.townHallPos ? [s.townHallPos[0], s.townHallPos[1]] : null
                };
            }

            // free tiles that lie outside the biggest connected free region -
            // the seams and speckles a good layout does not have
            freeOutsideCount() {
                let total = 0, largest = 0;
                const seen = new Set();
                for (const key of this.grid.keys()) {
                    if (!this.isFreeKey(key)) continue;
                    total++;
                    if (seen.has(key)) continue;
                    let size = 0;
                    const stack = [key];
                    seen.add(key);
                    while (stack.length) {
                        const k = stack.pop();
                        size++;
                        const parts = k.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        for (const nk of [(kx - 1) + ',' + ky, (kx + 1) + ',' + ky, kx + ',' + (ky - 1), kx + ',' + (ky + 1)]) {
                            if (this.isFreeKey(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
                        }
                    }
                    if (size > largest) largest = size;
                }
                return total - largest;
            }

            /**
             * Homeless roadless buildings while free tiles are still lying
             * around: nothing ties a roadless building to its spot, so the
             * whole mass is fair game. Two attempts, cheapest first.
             *
             * 1. lay the mass out again - packer and gravity direction decide
             *    whether the seams that survive lie flat or stand upright, and
             *    which of the two the leftovers need depends on their shape,
             *    so the recipes are simply tried and measured.
             * 2. eviction: take a spot that is almost free, throw out the
             *    roadless neighbours occupying the rest of it and give them a
             *    new home somewhere else.
             *
             * Nothing is kept unless it puts more buildings on the map than the
             * layout that came in.
             *
             * @param {Array} decos - every roadless building of the city
             */
            rescueLeftovers(decos) {
                const missing = () => {
                    const on = new Set(this.placedBuildings.map(b => b.id));
                    return decos.filter(b => !on.has(b.id));
                };

                let left = missing();
                if (!left.length) return;

                const UP_LEFT = [[0, -1], [-1, 0]];
                const LEFT_UP = [[-1, 0], [0, -1]];
                const base = this.snapshot();
                let best = base;
                let bestPlaced = this.placedBuildings.length;
                let bestOutside = this.freeOutsideCount();
                const target = bestPlaced + left.length;

                // packer x build order x gravity direction. The order decides
                // which shapes get the good spots and the gravity decides
                // whether the seams that survive lie flat or stand upright -
                // neither can be reasoned out in advance for a given city, so
                // they are tried until one takes the whole mass.
                const recipes = [];
                for (const dirs of [UP_LEFT, LEFT_UP]) {
                    for (const j of [0, this.seed + 101, this.seed + 227, this.seed + 419]) {
                        recipes.push(['maxrects', dirs, j]);
                    }
                }
                recipes.push(['fast', UP_LEFT, 0], ['fast', LEFT_UP, 0]);

                let tries = 0;
                for (const [mode, dirs, jit] of recipes) {
                    // the run itself already produced this one
                    if (mode === this.packMode && dirs === UP_LEFT && jit === (this.seed || 0)) continue;
                    tries++;
                    this.restore(this.copyOf(base));
                    for (const p of [...this.placedBuildings]) {
                        if ((p.street_level || 0) === 0 && p.type !== 'main_building') this.removePlaced(p);
                    }
                    let rest;
                    if (mode === 'maxrects') rest = this.packRoadlessMaxRects(decos, jit);
                    else { this.packRoadlessFast(decos); rest = missing(); }
                    this.compactRoadless(dirs);
                    if (rest.length) this.packRoadlessFast(rest);

                    const placed = this.placedBuildings.length;
                    const outside = this.freeOutsideCount();
                    if (placed > bestPlaced || (placed === bestPlaced && outside < bestOutside)) {
                        best = this.snapshot();
                        bestPlaced = placed;
                        bestOutside = outside;
                    }
                    if (bestPlaced >= target) break;
                    // a different build order closes a gap of one or two
                    // buildings, never one of ten - once two recipes agree that
                    // the mass simply does not fit, stop burning the clock the
                    // search needs for the road count
                    if (tries >= 2 && target - bestPlaced > 2) break;
                }

                this.restore(this.copyOf(best));
                left = missing();
                this.mark('repackRoadless', left.length + ' homeless after ' + tries + ' repacks');

                if (!left.length) return;
                const gained = this.makeRoomForLeftovers(decos, 3);
                if (gained) this.mark('makeRoom', gained + ' of ' + left.length + ' placed by evicting neighbours');
            }

            /**
             * Eviction pass for the last homeless roadless buildings.
             *
             * A spot that is half free and half covered by two small roadless
             * neighbours is useless as it stands, but those neighbours have no
             * street to lose and usually fit somewhere else. So the spot is
             * cleared, the leftover takes it and the evicted ones are packed
             * again - and if even one of them finds no new home the whole trade
             * is rolled back.
             *
             * @param {Array} decos - every roadless building of the city
             * @param {number} passes - eviction rounds; a round without progress stops early
             * @returns {number} how many buildings the pass got onto the map
             */
            makeRoomForLeftovers(decos, passes) {
                const byId = new Map();
                for (const b of decos) byId.set(b.id, b);
                // hard cap on the whole pass: the chain branches, and a city
                // that cannot take the building would otherwise be searched
                // until the clock runs out
                const budget = { left: 900 };
                let gained = 0;

                for (let pass = 0; pass < passes; pass++) {
                    const on = new Set(this.placedBuildings.map(b => b.id));
                    const left = decos.filter(b => !on.has(b.id));
                    if (!left.length || budget.left <= 0) break;
                    let progress = false;
                    for (const b of left) {
                        if (this.homeFor(b, 3, byId, budget)) { progress = true; gained++; }
                    }
                    if (!progress) break;
                }

                return gained;
            }

            /**
             * Every spot where a roadless building would fit if the roadless
             * neighbours sitting there moved out. Street buildings, roads, the
             * town hall, the reserve and the map border are not for sale, so a
             * spot touching any of them is not a spot.
             *
             * Sorted by what the trade costs: the evicted ones have to find a
             * new home, and that gets harder the bigger they are - a spot that
             * only clips the corner of a 6x6 looks cheap and is not.
             *
             * @returns {Array<{ids:Set, x:number, y:number}>} cheapest first
             */
            evictionSpots(b) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;
                // A building is hard to place when its longest side is long -
                // a 1x3 wants three tiles in a line and only a line will do,
                // while a 1x1 takes anything. Only strictly easier neighbours
                // may be evicted: without that rule a 1x3 throws out the next
                // 1x3, which has exactly the same problem, and the chain runs
                // in circles instead of ending at a 1x1.
                const hardness = (w, h) => Math.max(w, h) * 1000 + w * h;
                const limit = hardness(b.width, b.height);
                const owner = new Map();
                const hardOf = new Map();
                for (const p of this.placedBuildings) {
                    if ((p.street_level || 0) !== 0 || p.type === 'main_building') continue;
                    const hd = hardness(p.width, p.height);
                    if (hd >= limit) continue;
                    hardOf.set(p.id, hd);
                    for (let i = p.x; i < p.x + p.width; i++) {
                        for (let j = p.y; j < p.y + p.height; j++) owner.set(i + ',' + j, p.id);
                    }
                }

                // One entry per set of neighbours, not per tile. A 1x3 slid
                // through a 4x5 building yields a dozen spots that all throw
                // out the very same neighbour - trying six of those is trying
                // one thing six times, which is what made the whole pass
                // useless. Only the spot that leaves the least to fill again
                // survives per set.
                const bySet = new Map();
                for (let y = minY; y + b.height <= maxY; y++) {
                    for (let x = minX; x + b.width <= maxX; x++) {
                        let freeTiles = 0, ok = true;
                        const evict = new Set();
                        for (let i = x; i < x + b.width && ok; i++) {
                            for (let j = y; j < y + b.height && ok; j++) {
                                const key = i + ',' + j;
                                const v = this.grid.get(key);
                                if (v === 0) { freeTiles++; continue; }
                                const id = v === 1 ? owner.get(key) : undefined;
                                if (id === undefined) ok = false; else evict.add(id);
                            }
                        }
                        // an empty eviction set would have been taken by the
                        // packer already. A spot with no free tile at all is
                        // still worth trying: three 1x1 towers in a column hold
                        // a slot no 1x3 can reach, and each of them only needs
                        // a single tile back
                        if (!ok || !evict.size) continue;
                        let cost = 0;
                        for (const id of evict) cost += hardOf.get(id) || 0;
                        const sig = [...evict].sort((p, q) => p - q).join('|');
                        const old = bySet.get(sig);
                        if (old && old.free >= freeTiles) continue;
                        bySet.set(sig, { area: cost, free: freeTiles, n: evict.size, x: x, y: y, ids: evict });
                    }
                }
                const out = [...bySet.values()];
                out.sort((p, q) => p.area - q.area || q.free - p.free || p.n - q.n || p.y - q.y || p.x - q.x);
                return out;
            }

            /**
             * Find a spot for one roadless building, moving neighbours out of
             * the way if that is what it takes.
             *
             * A plain spot is tried first. Failing that the building takes a
             * spot held by roadless neighbours, and each of them is then put
             * through the same treatment - which is what turns a hopeless case
             * into a solvable one: a 1x3 needs three tiles in a column, the 2x2
             * standing there needs a square, and the 1x1 that has to move for
             * the 2x2 needs a single tile, of which the city has plenty. Any
             * link of the chain that fails rolls the whole trade back.
             *
             * @param {Object} b - the building to place
             * @param {number} depth - how many further evictions the chain may cause
             * @param {Map} byId - id -> original building, to re-place an evicted one
             * @param {Object} budget - shared {left} counter of eviction attempts
             * @returns {boolean} whether the building now stands on the map
             */
            homeFor(b, depth, byId, budget) {
                const before = this.placedBuildings.length;
                this.packRoadlessFast([b]);
                if (this.placedBuildings.length > before) return true;
                if (depth <= 0 || budget.left <= 0) return false;

                // the first link of the chain is the one worth searching wide;
                // deeper down the alternatives multiply and the budget is the
                // only thing keeping the endgame short
                const spots = this.evictionSpots(b);
                const cap = depth >= 3 ? 24 : 8;
                for (let ci = 0; ci < spots.length && ci < cap; ci++) {
                    if (budget.left-- <= 0) break;
                    const c = spots[ci];
                    const snap = this.snapshot();
                    const victimIds = [...c.ids];
                    for (const id of victimIds) {
                        const v = this.placedBuildings.find(p => p.id === id);
                        if (v) this.removePlaced(v);
                    }
                    this.placeEntity(b, c.x, c.y, 1);

                    // ids, not objects: a rolled-back link further down the
                    // chain replaces the whole placed list with fresh copies
                    let ok = true;
                    for (const id of victimIds) {
                        const src = byId.get(id);
                        if (!src || !this.homeFor(src, depth - 1, byId, budget)) { ok = false; break; }
                    }
                    if (ok) return true;
                    this.restore(snap);
                }
                return false;
            }

            // full state copy, so a relocation attempt that does not pay off can
            // be rolled back - pruning roads is destructive and cannot be undone
            // by simply putting the building back
            // one trace line: what the layout looks like after this phase
            mark(phase, extra) {
                const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                this.trace.push({
                    phase: phase,
                    ms: Math.round(now - this.t0),
                    roads: this.roadTiles.size,
                    placed: this.placedBuildings.length,
                    note: extra === undefined ? '' : String(extra)
                });
            }

            snapshot() {
                return {
                    grid: new Map(this.grid),
                    roadTiles: new Set(this.roadTiles),
                    roadLevel: new Map(this.roadLevel),
                    placed: this.placedBuildings.map(b => ({ ...b })),
                    townHallPos: this.townHallPos ? [this.townHallPos[0], this.townHallPos[1]] : null
                };
            }

            restore(s) {
                this.grid = s.grid;
                this.roadTiles = s.roadTiles;
                this.roadLevel = s.roadLevel;
                this.placedBuildings = s.placed;
                this.townHallPos = s.townHallPos;
            }

            // Manhattan distance of a building from the town hall - outliers are
            // the ones whose spurs cost the most road
            townHallDistance(b) {
                if (!this.townHallPos) return 0;
                return Math.abs(b.x - this.townHallPos[0]) + Math.abs(b.y - this.townHallPos[1]);
            }

            // a free spot where the building touches the existing road network,
            // so placing it there costs zero new road tiles; among those the one
            // closest to the town hall keeps the network compact
            spotNextToRoad(b) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;
                const hw = b.chainMembers ? b.chainMembers[0].width : b.width;
                const hh = b.chainMembers ? b.chainMembers[0].height : b.height;
                let best = null, bestScore = Infinity;

                for (let y = minY; y + b.height <= maxY; y++) {
                    for (let x = minX; x + b.width <= maxX; x++) {
                        if (this.grid.get(x + ',' + y) !== 0) continue;
                        if (!this.canPlace(x, y, b.width, b.height)) continue;
                        if (!this.isConnectedToRoad(x, y, hw, hh)) continue;
                        if (!this.gbKeepsStubSpace(x, y, b.width, b.height)) continue;
                        const score = this.townHallPos
                            ? Math.abs(x - this.townHallPos[0]) + Math.abs(y - this.townHallPos[1])
                            : x + y;
                        if (score < bestScore) { bestScore = score; best = [x, y]; }
                    }
                }
                return best;
            }

            /**
             * Road-shortening relocation pass.
             *
             * After pruneRoadsSmart the network is minimal: no single tile can be
             * removed. It is still far from minimum, because tiles exist only to
             * reach buildings that sit far away. Pulling such an outlier next to
             * an existing road makes its whole spur removable - this is the move a
             * player makes by hand. Every attempt is rolled back unless the total
             * road count actually drops, so the pass can never make things worse.
             *
             * @param {number} maxPasses - sweeps over all candidates
             * @returns {number} road tiles saved
             */
            relocateForRoads(maxPasses) {
                const startRoads = this.roadTiles.size;

                for (let pass = 0; pass < (maxPasses || 3); pass++) {
                    let improved = 0;

                    // Cheap pre-filter: a building can only free road tiles if it
                    // is the sole user of at least one of them. Counting users per
                    // road tile costs one sweep, while the honest test costs a full
                    // prune per candidate - this keeps the pass affordable.
                    const users = new Map();
                    for (const b of this.placedBuildings) {
                        if (!(b.street_level > 0)) continue;
                        const r = this.connRect(b);
                        for (let i = r.x; i < r.x + r.width; i++) {
                            for (const k of [i + ',' + (r.y - 1), i + ',' + (r.y + r.height)]) {
                                if (this.roadTiles.has(k)) users.set(k, (users.get(k) || 0) + 1);
                            }
                        }
                        for (let j = r.y; j < r.y + r.height; j++) {
                            for (const k of [(r.x - 1) + ',' + j, (r.x + r.width) + ',' + j]) {
                                if (this.roadTiles.has(k)) users.set(k, (users.get(k) || 0) + 1);
                            }
                        }
                    }
                    const hasExclusiveRoad = (b) => {
                        const r = this.connRect(b);
                        for (let i = r.x; i < r.x + r.width; i++) {
                            for (const k of [i + ',' + (r.y - 1), i + ',' + (r.y + r.height)]) {
                                if (users.get(k) === 1) return true;
                            }
                        }
                        for (let j = r.y; j < r.y + r.height; j++) {
                            for (const k of [(r.x - 1) + ',' + j, (r.x + r.width) + ',' + j]) {
                                if (users.get(k) === 1) return true;
                            }
                        }
                        return false;
                    };

                    // farthest from the town hall first: longest spurs, biggest win
                    const ids = this.placedBuildings
                        .filter(b => b.street_level === 1 && b.type !== 'main_building' && hasExclusiveRoad(b))
                        .sort((p, q) => this.townHallDistance(q) - this.townHallDistance(p))
                        .map(b => b.id);

                    for (const id of ids) {
                        const before = this.roadTiles.size;
                        const snap = this.snapshot();
                        const b = this.placedBuildings.find(p => p.id === id);
                        if (!b) continue;

                        this.removePlaced(b);
                        this.pruneRoadsSmart();
                        // nothing became removable - the building is not the reason
                        // for any road tile, so moving it cannot pay off
                        if (this.roadTiles.size === before) { this.restore(snap); continue; }

                        const spot = this.spotNextToRoad(b);
                        if (!spot) { this.restore(snap); continue; }

                        this.placeEntity(b, spot[0], spot[1], 1);
                        this.pruneRoadsSmart();

                        if (this.roadTiles.size < before) improved++;
                        else this.restore(snap);
                    }

                    if (!improved) break;
                }

                return startRoads - this.roadTiles.size;
            }

            removePlaced(b) {
                for (let i = b.x; i < b.x + b.width; i++) {
                    for (let j = b.y; j < b.y + b.height; j++) this.grid.set(i + ',' + j, 0);
                }
                this.placedBuildings.splice(this.placedBuildings.indexOf(b), 1);
            }

            // a building even the repair passes could not wire up must not stay
            // on the map as a fake plan - drop it, the export reports it in the
            // unplaced list instead
            dropUnconnected() {
                for (const b of [...this.placedBuildings]) {
                    if (b.type === 'main_building' || !(b.street_level > 0)) continue;
                    const r = this.connRect(b);
                    if (this.isConnectedToRoad(r.x, r.y, r.width, r.height)) continue;
                    this.removePlaced(b);
                }
            }

            // same policy for two-lane buildings no corridor could reach
            dropTwoLaneUnserved() {
                const linked = this.linkedTwoLaneTiles();
                let dropped = false;
                for (const b of [...this.placedBuildings]) {
                    if ((b.street_level || 0) < 2) continue;
                    if (this.touchesTwoLane(this.connRect(b), linked)) continue;
                    this.removePlaced(b);
                    dropped = true;
                }
                return dropped;
            }

            // greedy top-left tiling of the two-lane tiles into disjoint 2x2
            // pieces - the same order the export uses; returns the tiles no
            // piece covers
            tileTwoLaneBlocks() {
                const isL2 = (key) => this.roadTiles.has(key) && (this.roadLevel.get(key) || 1) >= 2;
                const consumed = new Set();
                const strays = [];
                const coords = [...this.roadTiles].filter(isL2).map(k => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
                for (const [x, y] of coords) {
                    const key = x + ',' + y;
                    if (consumed.has(key)) continue;
                    const rest = [(x + 1) + ',' + y, x + ',' + (y + 1), (x + 1) + ',' + (y + 1)];
                    if (rest.every(k => isL2(k) && !consumed.has(k))) {
                        consumed.add(key);
                        rest.forEach(k => consumed.add(k));
                    } else {
                        strays.push([x, y]);
                    }
                }
                return strays;
            }

            // the game only sells two-lane streets as whole 2x2 pieces, so the
            // planned corridors must decompose into such pieces - corridors of
            // odd length leave a 2x1 rest after the tiling; grow them by free
            // tiles until every two-lane tile is covered by a whole piece
            completeTwoLaneBlocks() {
                const isL2 = (key) => this.roadTiles.has(key) && (this.roadLevel.get(key) || 1) >= 2;
                let guard = 0;
                let strays = this.tileTwoLaneBlocks();
                while (strays.length && guard++ < 20) {
                    let grown = false;
                    for (const [x, y] of strays) {
                        // any block containing this tile whose missing tiles are
                        // free or upgradable one-lane road tiles
                        for (const [bx, by] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
                            const missing = this.blockTiles(bx, by).filter(k => !isL2(k));
                            if (missing.length && missing.every(k => this.grid.get(k) === 0 || this.grid.get(k) === 2)) {
                                for (const k of missing) {
                                    const parts = k.split(',');
                                    this.placeRoadTile(+parts[0], +parts[1], 2);
                                }
                                grown = true;
                                break;
                            }
                        }
                    }
                    if (!grown) break;
                    strays = this.tileTwoLaneBlocks();
                }

                // tiles no whole piece can cover get downgraded - two-lane
                // buildings whose only interface was such a tile are returned:
                // their spot cannot be served with whole pieces even in the
                // game, the caller drops them into the unplaced report
                strays = this.tileTwoLaneBlocks();
                const broken = [];
                if (strays.length) {
                    const backup = strays.map(([x, y]) => x + ',' + y);
                    for (const k of backup) this.roadLevel.set(k, 1);
                    const linked = this.linkedTwoLaneTiles();
                    for (const b of this.placedBuildings) {
                        if ((b.street_level || 0) >= 2 && !this.touchesTwoLane(this.connRect(b), linked)) broken.push(b);
                    }
                }
                return broken;
            }

            // organic placement for a two-lane building: prefer spots that already
            // touch the linked network, otherwise take the spot with the cheapest
            // block corridor and build that corridor before placing - a corridor
            // planned after tight packing would find no room anymore
            placeTwoLaneOrganic(b, coords, keepsGrowth, needed, l2Left) {
                const linked = this.linkedTwoLaneTiles();
                const hw = b.chainMembers ? b.chainMembers[0].width : b.width;
                const hh = b.chainMembers ? b.chainMembers[0].height : b.height;
                const bd = this.twoLaneBlockDist(linked);

                const candidates = [];
                for (const [x, y] of coords) {
                    if (this.grid.get(x + ',' + y) !== 0 || !this.canPlace(x, y, b.width, b.height)) continue;
                    // never take an unconnected great building's last free
                    // neighbour tile - repair cannot demolish its walls
                    if (!this.gbKeepsStubSpace(x, y, b.width, b.height)) continue;
                    const head = { x: x, y: y, width: hw, height: hh };
                    if (this.touchesTwoLane(head, linked)) {
                        if (!keepsGrowth([], x, y, b.width, b.height, needed)) continue;
                        if (l2Left > 0 && !this.keepsTwoLaneGrowth(x, y, b.width, b.height, [], l2Left)) continue;
                        this.placeEntity(b, x, y, 1);
                        return true;
                    }
                    // cheapest block next to the head that does not overlap the footprint
                    let cost = Infinity, bkey = null;
                    for (let by = head.y - 2; by <= head.y + head.height; by++) {
                        for (let bx = head.x - 2; bx <= head.x + head.width; bx++) {
                            if (bx + 1 >= x && bx < x + b.width && by + 1 >= y && by < y + b.height) continue;
                            if (!this.blockTouchesRect(bx, by, head)) continue;
                            const dv = bd.dist.get(bx + ',' + by);
                            if (dv !== undefined && dv < cost) { cost = dv; bkey = bx + ',' + by; }
                        }
                    }
                    if (bkey !== null) candidates.push([cost, x, y, bkey]);
                }

                candidates.sort((p, q) => p[0] - q[0]);
                for (const cand of candidates) {
                    const x = cand[1], y = cand[2];
                    // walk the corridor first - it must not cross the footprint
                    const path = [];
                    let cur = cand[3], ok = true;
                    while (cur !== undefined) {
                        const parts = cur.split(',');
                        const bx = +parts[0], by = +parts[1];
                        if (bx + 1 >= x && bx < x + b.width && by + 1 >= y && by < y + b.height) { ok = false; break; }
                        path.push(cur);
                        cur = bd.parent.get(cur);
                    }
                    if (!ok) continue;
                    const pathTiles = [];
                    for (const bk of path) {
                        const parts = bk.split(',');
                        for (const key of this.blockTiles(+parts[0], +parts[1])) {
                            if (this.grid.get(key) === 0) pathTiles.push(key);
                        }
                    }
                    if (!keepsGrowth(pathTiles, x, y, b.width, b.height, needed)) continue;
                    if (l2Left > 0 && !this.keepsTwoLaneGrowth(x, y, b.width, b.height, pathTiles, l2Left)) continue;
                    for (const bk of path) {
                        const parts = bk.split(',');
                        for (const key of this.blockTiles(+parts[0], +parts[1])) {
                            const kp = key.split(',');
                            this.placeRoadTile(+kp[0], +kp[1], 2);
                        }
                    }
                    this.placeEntity(b, x, y, 1);
                    return true;
                }
                return false;
            }

            // Multi-source BFS from the map border inward: depth 0 = tile touches the
            // border (or a locked area), used to fill roadless buildings edge-first
            computeEdgeDepth() {
                const depth = new Map();
                const queue = [];
                for (const [key, val] of this.grid) {
                    if (val === -1) continue;
                    const [x, y] = key.split(',').map(Number);
                    for (const [nx, ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
                        const nv = this.grid.get(nx + ',' + ny);
                        if (nv === undefined || nv === -1) {
                            depth.set(key, 0);
                            queue.push([x, y]);
                            break;
                        }
                    }
                }
                let head = 0;
                while (head < queue.length) {
                    const [x, y] = queue[head++];
                    const d = depth.get(x + ',' + y);
                    for (const [nx, ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
                        const nkey = nx + ',' + ny;
                        const nv = this.grid.get(nkey);
                        if (nv === undefined || nv === -1 || depth.has(nkey)) continue;
                        depth.set(nkey, d + 1);
                        queue.push([nx, ny]);
                    }
                }
                return depth;
            }

            countAdjacentRoadTiles(b) {
                let count = 0;
                for (let i = b.x; i < b.x + b.width; i++) {
                    if (this.roadTiles.has(i + ',' + (b.y - 1))) count++;
                    if (this.roadTiles.has(i + ',' + (b.y + b.height))) count++;
                }
                for (let j = b.y; j < b.y + b.height; j++) {
                    if (this.roadTiles.has((b.x - 1) + ',' + j)) count++;
                    if (this.roadTiles.has((b.x + b.width) + ',' + j)) count++;
                }
                return count;
            }
    
            pruneRoadsSmart() {
                // the town hall counts too: its last road tile must survive -
                // chain composites only guard the road at their head member
                const streetBuildings = this.placedBuildings.filter(b => b.street_level > 0).map(b => this.connRect(b));

                const buildingsTouching = (rx, ry) => streetBuildings.filter(b =>
                    ((ry === b.y - 1 || ry === b.y + b.height) && rx >= b.x && rx < b.x + b.width) ||
                    ((rx === b.x - 1 || rx === b.x + b.width) && ry >= b.y && ry < b.y + b.height)
                );

                // a road tile may go when every remaining tile still reaches the
                // town hall through roads (adjacency to the town hall is the
                // anchor - that keeps networks of several town-hall-anchored
                // components prunable) and no adjacent building loses its last
                // road tile - unlike pure dead-end peeling this also removes
                // parallel double roads, which are connected at both ends and
                // would survive forever otherwise
                const th = this.townHallPos
                    ? { x: this.townHallPos[0], y: this.townHallPos[1], width: this.townHall.width, height: this.townHall.height }
                    : null;
                const stillConnected = (skipKey) => {
                    const seeds = [];
                    if (th) {
                        for (let i = th.x; i < th.x + th.width; i++) {
                            for (const k of [i + ',' + (th.y - 1), i + ',' + (th.y + th.height)]) {
                                if (k !== skipKey && this.roadTiles.has(k)) seeds.push(k);
                            }
                        }
                        for (let j = th.y; j < th.y + th.height; j++) {
                            for (const k of [(th.x - 1) + ',' + j, (th.x + th.width) + ',' + j]) {
                                if (k !== skipKey && this.roadTiles.has(k)) seeds.push(k);
                            }
                        }
                    } else {
                        for (const key of this.roadTiles) { if (key !== skipKey) { seeds.push(key); break; } }
                    }
                    if (!seeds.length) return this.roadTiles.size <= 1;
                    const seen = new Set([skipKey, ...seeds]);
                    const stack = [...seeds];
                    let count = seeds.length;
                    while (stack.length) {
                        const k = stack.pop();
                        const parts = k.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            if (this.roadTiles.has(nk) && !seen.has(nk)) {
                                seen.add(nk);
                                count++;
                                stack.push(nk);
                            }
                        }
                    }
                    return count === this.roadTiles.size - 1;
                };

                let changed = true;
                while (changed) {
                    changed = false;
                    for (const key of [...this.roadTiles]) {
                        const [rx, ry] = key.split(',').map(Number);

                        // two-lane tiles are deliberate 2x2 blocks - never prune them
                        if ((this.roadLevel.get(key) || 1) >= 2) continue;

                        // One connection tile per building is enough - keep this tile
                        // if some adjacent building would lose its last road tile
                        if (buildingsTouching(rx, ry).some(b => this.countAdjacentRoadTiles(b) <= 1)) continue;

                        let neighbors = 0;
                        if (this.grid.get((rx-1) + ',' + ry) === 2) neighbors++;
                        if (this.grid.get((rx+1) + ',' + ry) === 2) neighbors++;
                        if (this.grid.get(rx + ',' + (ry-1)) === 2) neighbors++;
                        if (this.grid.get(rx + ',' + (ry+1)) === 2) neighbors++;

                        // endpoints can never split the tile graph - but a tile
                        // on the town hall perimeter can be the anchor of its
                        // whole branch, so it always takes the reachability check
                        const anchorTile = th
                            && (((ry === th.y - 1 || ry === th.y + th.height) && rx >= th.x && rx < th.x + th.width)
                                || ((rx === th.x - 1 || rx === th.x + th.width) && ry >= th.y && ry < th.y + th.height));
                        if ((neighbors > 1 || anchorTile) && !stillConnected(key)) continue;

                        this.grid.set(key, 0);
                        this.roadTiles.delete(key);
                        this.roadLevel.delete(key);
                        changed = true;
                    }
                }
            }
    
            generateExportData() {
                const exportList = [];
                for (const b of this.placedBuildings) {
                    // split chain composites back into their members, in chain order
                    if (b.chainMembers) {
                        let off = 0;
                        for (const m of b.chainMembers) {
                            if (this.transposed) { exportList.push({ ...m, x: b.x, y: b.y + off }); off += m.height; }
                            else { exportList.push({ ...m, x: b.x + off, y: b.y }); off += m.width; }
                        }
                    } else {
                        exportList.push(b);
                    }
                }
                // two-lane roads are exported as their 2x2 game pieces so the map
                // can draw the block raster - greedy top-left tiling, stray tiles
                // from overlapping corridors fall back to single tiles
                const isL2 = (key) => this.roadTiles.has(key) && (this.roadLevel.get(key) || 1) >= 2;
                const consumed = new Set();
                const roadCoords = [...this.roadTiles].map(k => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
                for (const [x, y] of roadCoords) {
                    const key = x + ',' + y;
                    if (consumed.has(key)) continue;
                    if (isL2(key)) {
                        const blockRest = [(x + 1) + ',' + y, x + ',' + (y + 1), (x + 1) + ',' + (y + 1)];
                        if (blockRest.every(k => isL2(k) && !consumed.has(k))) {
                            consumed.add(key);
                            blockRest.forEach(k => consumed.add(k));
                            exportList.push({ x: x, y: y, width: 2, height: 2, type: 'street', name: 'Road', street_level: 0, level: 2 });
                            continue;
                        }
                    }
                    consumed.add(key);
                    exportList.push({ x: x, y: y, width: 1, height: 1, type: 'street', name: 'Road', street_level: 0, level: this.roadLevel.get(key) || 1 });
                }
                // back to real map coordinates, undoing the input transforms in
                // reverse: the transpose was applied last, so it comes off first
                let out = exportList;
                if (this.transposed) {
                    out = out.map(item => ({ ...item, x: item.y, y: item.x, width: item.height, height: item.width }));
                }
                if (this.mirrorX || this.mirrorY) {
                    out = out.map(item => ({
                        ...item,
                        x: this.mirrorX ? this.mirrorAxisX - (item.x + item.width) : item.x,
                        y: this.mirrorY ? this.mirrorAxisY - (item.y + item.height) : item.y
                    }));
                }
                return out;
            }

            layoutBands(street) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;

                // two-lane buildings first: their bands get double road rows and a
                // double trunk, so the two-lane network stays one connected piece
                const twoLane = street.filter(b => (b.street_level || 0) >= 2);
                const oneLane = street.filter(b => (b.street_level || 0) < 2);
                const hasTwoLane = twoLane.length > 0;

                // buildable stretches per row: all of them get roads and buildings
                // (side areas cut off by the great buildings included), the widest
                // stretch anchors the trunk
                const rowRuns = new Map();
                const rowRange = new Map();
                for (let y = minY; y < maxY; y++) {
                    const runs = [];
                    let curStart = null;
                    for (let x = minX; x <= maxX; x++) {
                        if (x < maxX && this.grid.get(x + ',' + y) === 0) {
                            if (curStart === null) curStart = x;
                        } else if (curStart !== null) {
                            runs.push([curStart, x]);
                            curStart = null;
                        }
                    }
                    if (runs.length) {
                        rowRuns.set(y, runs);
                        let widest = runs[0];
                        for (const run of runs) if (run[1] - run[0] > widest[1] - widest[0]) widest = run;
                        rowRange.set(y, widest);
                    }
                }

                // one long trunk road down the column with the longest contiguous
                // streak of rows whose buildable stretch contains it - rows outside
                // that streak would end up disconnected from the trunk
                let trunkX = minX, trunkTop = minY, trunkBottom = minY;
                for (let x = minX; x < maxX; x++) {
                    let start = null;
                    for (let y = minY; y <= maxY; y++) {
                        const range = y < maxY ? rowRange.get(y) : null;
                        const covers = !!(range && x >= range[0] && x < range[1]);
                        if (covers && start === null) start = y;
                        if (!covers && start !== null) {
                            if (y - start > trunkBottom - trunkTop) { trunkX = x; trunkTop = start; trunkBottom = y; }
                            start = null;
                        }
                    }
                }
                for (let y = trunkTop; y < trunkBottom; y++) {
                    this.placeRoadTile(trunkX, y, hasTwoLane ? 2 : 1);
                    // two-lane cities need a two tiles wide trunk (2x2 pieces)
                    if (hasTwoLane) this.placeRoadTile(trunkX + 1, y, 2);
                }

                // hook up the pre-placed great buildings while the rows are still
                // empty - once the bands are built they wall off the free pockets
                // and no stub can reach the trunk anymore (pruneRoadsSmart removes
                // stubs that band roads make obsolete afterwards)
                this.connectPlacedBuildings();

                // build order comes from the variant: bands of similar height need the
                // fewest road rows, and every building touches its road row by
                // construction - the town hall strictly leads the two-lane group
                // (never jittered away by a seed) so the two-lane buildings pack
                // right next to it and their corridors stay as short as possible
                const queue = hasTwoLane
                    ? [this.townHall, ...this.sortBuildings(twoLane)].concat(this.sortBuildings(oneLane))
                    : this.sortBuildings([this.townHall, ...street]);

                // fill one row of buildings along a road row: mode 'above' puts their
                // bottom edge on it, mode 'below' their top edge
                const placeRow = (roadY, mode) => {
                    if (!queue.length || !rowRuns.has(roadY)) return 0;
                    const bandH = queue[0].height;
                    for (const run of rowRuns.get(roadY)) {
                        for (let x = run[0]; x < run[1]; x++) {
                            for (let q = 0; q < queue.length; q++) {
                                const b = queue[q];
                                const by = mode === 'above' ? roadY - b.height : roadY + 1;
                                if (x + b.width <= run[1] && this.canPlace(x, by, b.width, b.height) && this.gbKeepsStubSpace(x, by, b.width, b.height)) {
                                    if (b.type === 'main_building') this.townHallPos = [x, by];
                                    this.placeEntity(b, x, by, b.type === 'main_building' ? 9 : 1);
                                    queue.splice(q, 1);
                                    x += b.width - 1;
                                    break;
                                }
                            }
                        }
                    }
                    return bandH;
                };

                // bands top-down: [buildings above][road row(s)][buildings below] ...
                // while two-lane buildings wait, the road row is two tiles thick
                let y = minY;
                let lastTwoLaneRow = trunkTop - 1;
                while (queue.length && y < maxY) {
                    const dbl = hasTwoLane && queue.some(q => (q.street_level || 0) >= 2);
                    const rows = dbl ? 2 : 1;
                    const roadY = y + queue[0].height;
                    if (roadY + rows - 1 >= maxY) break;

                    // the road row must exist and cross the trunk to stay connected
                    const range = rowRange.get(roadY);
                    if (!range || roadY < trunkTop || roadY >= trunkBottom || trunkX < range[0] || trunkX >= range[1] || (dbl && !rowRuns.has(roadY + 1))) { y++; continue; }

                    // roads first so the row packing sees them, side stretches get
                    // linked to the trunk by the unify pass afterwards
                    for (let r = 0; r < rows; r++) {
                        for (const run of rowRuns.get(roadY + r)) {
                            for (let x = run[0]; x < run[1]; x++) this.placeRoadTile(x, roadY + r, dbl ? 2 : 1);
                        }
                    }
                    if (dbl) lastTwoLaneRow = roadY + 1;
                    placeRow(roadY, 'above');
                    const hBelow = placeRow(roadY + rows - 1, 'below');

                    y = roadY + rows + hBelow;
                }

                // below the last double row the second trunk column is ordinary
                // one-lane road again - the prune pass may take it back
                if (hasTwoLane) {
                    for (let dy = Math.max(trunkTop, lastTwoLaneRow + 1); dy < trunkBottom; dy++) {
                        for (const cx of [trunkX, trunkX + 1]) {
                            const key = cx + ',' + dy;
                            if (this.roadTiles.has(key)) this.roadLevel.set(key, 1);
                        }
                    }
                }
            }

            layoutOrganic(street) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;

                // grow from the top-left corner instead of the center: a city
                // packed into one corner (right below the edge-nested great
                // buildings) leaves the spare space as one connected block at
                // the opposite side - a centered city only leaves a useless ring
                const coords = [];
                for (let y = minY; y < maxY; y++) {
                    for (let x = minX; x < maxX; x++) coords.push([x, y]);
                }
                coords.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[1] - b[1]);

                // the town hall must sit in the largest free region: the road
                // network grows from it, so everything outside its region would
                // stay unreachable - the center tile alone can be a side pocket
                const thRegionOf = new Map();
                const thRegionSizes = [];
                for (const [key, val] of this.grid) {
                    if (val !== 0 || thRegionOf.has(key)) continue;
                    const id = thRegionSizes.length;
                    let size = 0;
                    const stack = [key];
                    thRegionOf.set(key, id);
                    while (stack.length) {
                        const k = stack.pop();
                        size++;
                        const parts = k.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            if (this.grid.get(nk) === 0 && !thRegionOf.has(nk)) { thRegionOf.set(nk, id); stack.push(nk); }
                        }
                    }
                    thRegionSizes.push(size);
                }
                let thLargest = -1;
                thRegionSizes.forEach((s, i) => { if (thLargest === -1 || s > thRegionSizes[thLargest]) thLargest = i; });

                // town hall as close to the top-left corner as possible within
                // that region - it must not take an edge-nested great building's
                // stub channel: the town hall can never be demolished, so a
                // walled-in great building would stay cut off forever
                for (const [x, y] of coords) {
                    if (thRegionOf.get(x + ',' + y) !== thLargest) continue;
                    if (this.canPlace(x, y, this.townHall.width, this.townHall.height)
                        && this.gbKeepsStubSpace(x, y, this.townHall.width, this.townHall.height)) {
                        this.townHallPos = [x, y];
                        this.placeEntity(this.townHall, x, y, 9);
                        break;
                    }
                }
                // fallback: anywhere it fits
                if (!this.townHallPos) {
                    for (const [x, y] of coords) {
                        if (this.canPlace(x, y, this.townHall.width, this.townHall.height)
                            && this.gbKeepsStubSpace(x, y, this.townHall.width, this.townHall.height)) {
                            this.townHallPos = [x, y];
                            this.placeEntity(this.townHall, x, y, 9);
                            break;
                        }
                    }
                }
                // last resort: without the town hall there is no city at all
                if (!this.townHallPos) {
                    for (const [x, y] of coords) {
                        if (this.canPlace(x, y, this.townHall.width, this.townHall.height)) {
                            this.townHallPos = [x, y];
                            this.placeEntity(this.townHall, x, y, 9);
                            break;
                        }
                    }
                }
                if (!this.townHallPos) return;

                // seed road: first free tile around the town hall
                const [tx, ty] = this.townHallPos;
                const seeds = [];
                for (let i = tx; i < tx + this.townHall.width; i++) seeds.push([i, ty - 1], [i, ty + this.townHall.height]);
                for (let j = ty; j < ty + this.townHall.height; j++) seeds.push([tx - 1, j], [tx + this.townHall.width, j]);
                for (const [sx, sy] of seeds) {
                    if (this.placeRoadTile(sx, sy)) break;
                }

                // hook up the pre-placed great buildings while the map is still
                // empty - the grown city would wall them off later
                this.connectPlacedBuildings();

                // two-lane buildings first: while the map is still open their 2x2
                // block corridors can grow right next to the town hall
                const twoLane = street.filter(b => (b.street_level || 0) >= 2);
                const oneLane = street.filter(b => (b.street_level || 0) < 2);
                const queue = twoLane.length
                    ? this.sortBuildings(twoLane).concat(this.sortBuildings(oneLane))
                    : this.sortBuildings([...street]);

                // a placement (with its new road path, if any) must not entomb the
                // network: the largest connected free region still reachable from the
                // roads has to hold the remaining buildings - scattered pockets that
                // are individually too small do not count
                const keepsGrowth = (path, x, y, w, h, needed) => {
                    if (needed <= 0) return true;
                    const pathSet = new Set(path);
                    const inFoot = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
                    const isFree = (nx, ny) => {
                        const nk = nx + ',' + ny;
                        return this.grid.get(nk) === 0 && !pathSet.has(nk) && !inFoot(nx, ny);
                    };
                    const seeds = [];
                    for (const key of [...this.roadTiles, ...path]) {
                        const parts = key.split(',');
                        const rx = +parts[0], ry = +parts[1];
                        for (const nb of [[rx-1,ry],[rx+1,ry],[rx,ry-1],[rx,ry+1]]) {
                            if (isFree(nb[0], nb[1])) seeds.push(nb);
                        }
                    }
                    const seen = new Set();
                    for (const seed of seeds) {
                        const sk = seed[0] + ',' + seed[1];
                        if (seen.has(sk)) continue;
                        let size = 0;
                        const stack = [seed];
                        seen.add(sk);
                        while (stack.length) {
                            const t = stack.pop();
                            size++;
                            if (size >= needed) return true;
                            for (const nb of [[t[0]-1,t[1]],[t[0]+1,t[1]],[t[0],t[1]-1],[t[0],t[1]+1]]) {
                                const nk = nb[0] + ',' + nb[1];
                                if (!seen.has(nk) && isFree(nb[0], nb[1])) { seen.add(nk); stack.push(nb); }
                            }
                        }
                    }
                    return false;
                };

                let remaining = queue.reduce((sum, q) => sum + q.width * q.height, 0);
                let l2Left = twoLane.length;

                for (const b of queue) {
                    // free area that must stay reachable for the buildings after this one
                    remaining -= b.width * b.height;
                    const needed = remaining;

                    // two-lane buildings get their corridor together with the
                    // placement - planned afterwards it would find no room
                    if ((b.street_level || 0) >= 2) {
                        l2Left--;
                        this.placeTwoLaneOrganic(b, coords, keepsGrowth, needed, l2Left);
                        continue;
                    }

                    // BFS from the road network across free tiles: the distance is the
                    // number of new road tiles a spot would cost, parents give the path
                    const dist = new Map(), parent = new Map(), fifo = [];
                    for (const key of this.roadTiles) { dist.set(key, 0); fifo.push(key); }
                    let head = 0;
                    while (head < fifo.length) {
                        const key = fifo[head++];
                        const parts = key.split(',');
                        const kx = +parts[0], ky = +parts[1];
                        const d = dist.get(key);
                        for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                            if (this.grid.get(nk) === 0 && !dist.has(nk)) {
                                dist.set(nk, d + 1);
                                parent.set(nk, key);
                                fifo.push(nk);
                            }
                        }
                    }

                    // free spots already touching the network cost nothing - otherwise
                    // collect spots sorted by road cost, top-left order breaks ties
                    const attempt = (limit) => {
                        let cheap = 0;
                        const candidates = [];
                        for (const [x, y] of coords) {
                            if (this.grid.get(x + ',' + y) !== 0 || !this.canPlace(x, y, b.width, b.height)) continue;
                            // never take an unconnected great building's last free
                            // neighbour tile - repair cannot demolish its walls
                            if (!this.gbKeepsStubSpace(x, y, b.width, b.height)) continue;
                            if (this.isConnectedToRoad(x, y, b.width, b.height)) {
                                if (!keepsGrowth([], x, y, b.width, b.height, needed)) continue;
                                this.placeEntity(b, x, y, 1);
                                return true;
                            }
                            let cost = Infinity;
                            for (let i = x; i < x + b.width; i++) {
                                for (const j of [y - 1, y + b.height]) {
                                    const dv = dist.get(i + ',' + j);
                                    if (dv !== undefined && dv < cost) cost = dv;
                                }
                            }
                            for (let j = y; j < y + b.height; j++) {
                                for (const i of [x - 1, x + b.width]) {
                                    const dv = dist.get(i + ',' + j);
                                    if (dv !== undefined && dv < cost) cost = dv;
                                }
                            }
                            if (cost < Infinity) {
                                candidates.push([cost, x, y]);
                                if (cost <= 1) cheap++;
                                // keep a few alternatives in case the best one seals the network
                                if (limit !== Infinity && (cheap >= 3 || candidates.length >= limit)) break;
                            }
                        }

                        candidates.sort((p, q) => p[0] - q[0]);
                        for (const cand of candidates) {
                            const x = cand[1], y = cand[2];
                            // shortest road path to the spot that does not cross the building
                            let bestPath = null;
                            const per = [];
                            for (let i = x; i < x + b.width; i++) per.push(i + ',' + (y - 1), i + ',' + (y + b.height));
                            for (let j = y; j < y + b.height; j++) per.push((x - 1) + ',' + j, (x + b.width) + ',' + j);
                            for (const pt of per) {
                                const dv = dist.get(pt);
                                if (dv === undefined || dv === 0) continue;
                                if (bestPath && dv >= bestPath.length) continue;
                                const path = [];
                                let cur = pt, ok = true;
                                while (cur && dist.get(cur) > 0) {
                                    const parts = cur.split(',');
                                    const px = +parts[0], py = +parts[1];
                                    if (px >= x && px < x + b.width && py >= y && py < y + b.height) { ok = false; break; }
                                    path.push(cur);
                                    cur = parent.get(cur);
                                }
                                if (ok) bestPath = path;
                            }
                            if (bestPath && keepsGrowth(bestPath, x, y, b.width, b.height, needed)) {
                                for (const key of bestPath) {
                                    const parts = key.split(',');
                                    this.placeRoadTile(+parts[0], +parts[1]);
                                }
                                this.placeEntity(b, x, y, 1);
                                return true;
                            }
                        }
                        return false;
                    };

                    // capped scan first, full scan as the safety net
                    if (!attempt(25)) attempt(Infinity);
                }
            }

            run() {
                if (!this.townHall) return { error: "Rathaus nicht gefunden" };

                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;

                const street = this.buildings.filter(b => b.street_level > 0);
                const decos = this.buildings.filter(b => b.street_level === 0);
                const gbs = street.filter(b => b.type === 'greatbuilding');
                const rest = street.filter(b => b.type !== 'greatbuilding');

                // great buildings nest directly against the map border, the strategy
                // lays out everything else around them
                this.mark('start', this.buildings.length + ' buildings, ' + street.length + ' need a road, ' + decos.length + ' do not');

                // the district serves the great buildings from its own bands -
                // nesting them at the map border first would only force long
                // stubs back to them
                if (this.strategy !== 'district') {
                    this.placeGreatBuildingsAtEdge(gbs);
                    this.mark('greatBuildings', gbs.length + ' great buildings at the edge');
                }

                if (this.strategy === 'district') this.layoutDistrict(street.concat(this.townHall ? [this.townHall] : []));
                else if (this.strategy === 'organic') this.layoutOrganic(rest);
                else this.layoutBands(rest);
                this.mark('layout:' + this.strategy);

                // roads must be one network before the stubs attach to it
                this.unifyRoadNetwork();
                this.mark('unifyRoads');

                // single road stubs for everything the strategy left unconnected
                this.connectPlacedBuildings();
                this.mark('connectStubs');

                // two-lane corridors for buildings the strategy could not serve
                this.connectTwoLane();
                this.mark('twoLane');

                const allCoords = [];
                for (let cy = minY; cy < maxY; cy++) {
                    for (let cx = minX; cx < maxX; cx++) allCoords.push([cx, cy]);
                }

                // leftovers: whatever the strategy could not place gets any free
                // spot next to the existing road network
                const placedIds = new Set(this.placedBuildings.map(b => b.id));
                const leftovers = [this.townHall, ...street].filter(b => !placedIds.has(b.id));
                for (const b of leftovers) {
                    // chain composites connect through the head member only
                    const hw = b.chainMembers ? b.chainMembers[0].width : b.width;
                    const hh = b.chainMembers ? b.chainMembers[0].height : b.height;
                    for (const [cx, cy] of allCoords) {
                        if (this.grid.get(cx + ',' + cy) === 0
                            && this.canPlace(cx, cy, b.width, b.height)
                            && this.isConnectedToRoad(cx, cy, hw, hh)
                            && this.gbKeepsStubSpace(cx, cy, b.width, b.height)) {
                            if (b.type === 'main_building') this.townHallPos = [cx, cy];
                            this.placeEntity(b, cx, cy, b.type === 'main_building' ? 9 : 1);
                            break;
                        }
                    }
                }

                if (!this.townHallPos) return { error: "Rathaus konnte nicht platziert werden" };

                // hard guarantee before pruning: tear down blockers if that is the
                // only way left to give a building its street connection - a
                // re-placed blocker can itself land badly, so repair runs in up
                // to three passes (a clean pass exits immediately)
                for (let rp = 0; rp < 3; rp++) this.repairUnconnected();

                // whatever still has no street now never gets one - off the map
                // and into the unplaced report
                this.dropUnconnected();

                // the repair passes may have moved buildings and freed space -
                // final chance for every two-lane corridor
                this.connectTwoLane();

                // strip two-lane tiles nobody needs - stray ones as well as the
                // generously laid double rows and trunks of the bands strategy
                this.trimTwoLane();

                // two-lane buildings no corridor reaches follow the same drop
                // policy - their removal frees space, so re-trim afterwards
                if (this.dropTwoLaneUnserved()) this.trimTwoLane();

                // pad odd corridors so they decompose into whole 2x2 pieces; a
                // building whose spot cannot be served with whole pieces at all
                // is dropped as well, its corridor rest re-trimmed away
                const broken = this.completeTwoLaneBlocks();
                if (broken.length) {
                    for (const b of broken) this.removePlaced(b);
                    this.trimTwoLane();
                    this.completeTwoLaneBlocks();
                }

                this.mark('repairAndTrim');

                this.pruneRoadsSmart();
                this.mark('pruneRoads');

                // the network is minimal now - no single tile can go. What is left
                // is spurs that exist only because a building sits far away, so
                // pull those buildings in and let the spurs disappear
                const saved = this.relocateForRoads(3);
                this.mark('relocate', 'saved ' + saved + ' road tiles');

                // free-space fragmentation of the pure building layout, measured
                // before the decorations plug the holes: every free tile outside
                // the largest connected free region is a scattered speckle the
                // final layout should not have
                let fragmentTiles = 0;
                {
                    let totalFree = 0, largestFree = 0;
                    const seen = new Set();
                    for (const key of this.grid.keys()) {
                        if (!this.isFreeKey(key)) continue;
                        totalFree++;
                        if (seen.has(key)) continue;
                        let size = 0;
                        const stack = [key];
                        seen.add(key);
                        while (stack.length) {
                            const k = stack.pop();
                            size++;
                            const parts = k.split(',');
                            const kx = +parts[0], ky = +parts[1];
                            for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                                if (this.isFreeKey(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
                            }
                        }
                        if (size > largestFree) largestFree = size;
                    }
                    fragmentTiles = totalFree - largestFree;
                }

                // Roadless buildings: plug the dead pockets between the buildings
                // first, then pack the rest row by row from the top-left, tight
                // against the built-up city - and never cut the big free area in
                // two, it stays in one piece for expansion. Height-major order
                // builds rows of uniform height, so the rows stack flush instead
                // of leaving stripes of free tiles between jagged edges
                decos.sort((a, b) => b.height - a.height || (b.width * b.height) - (a.width * a.height));
                if (this.packMode === 'maxrects') this.packRoadlessMaxRects(decos, this.seed);
                else if (this.packMode === 'shelf') this.packRoadlessShelf(decos);
                else if (this.packMode === 'fast') this.packRoadlessFast(decos);
                else for (const b of decos) {
                    // fresh free regions (roads count as walls here)
                    const regionOf = new Map();
                    const regionSizes = [];
                    for (const [key, val] of this.grid) {
                        if (val !== 0 || regionOf.has(key)) continue;
                        const id = regionSizes.length;
                        let size = 0;
                        const stack = [key];
                        regionOf.set(key, id);
                        while (stack.length) {
                            const k = stack.pop();
                            size++;
                            const parts = k.split(',');
                            const kx = +parts[0], ky = +parts[1];
                            for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                                if (this.grid.get(nk) === 0 && !regionOf.has(nk)) {
                                    regionOf.set(nk, id);
                                    stack.push(nk);
                                }
                            }
                        }
                        regionSizes.push(size);
                    }
                    let largestId = -1;
                    regionSizes.forEach((s, i) => { if (largestId === -1 || s > regionSizes[largestId]) largestId = i; });

                    // free tiles of the largest region that a footprint would cut
                    // off from its biggest remaining part - 0 means the region
                    // just shrinks compactly. Every separated part borders the
                    // footprint, so seeding the BFS around it finds them all
                    const sealedAfter = (x, y, w, h) => {
                        const inFoot = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
                        const target = regionSizes[largestId] - w * h;
                        if (target <= 0) return 0;
                        const seeds = [];
                        for (let i = x - 1; i <= x + w; i++) {
                            for (const j of [y - 1, y + h]) {
                                if (regionOf.get(i + ',' + j) === largestId) seeds.push(i + ',' + j);
                            }
                        }
                        for (let j = y; j < y + h; j++) {
                            for (const i of [x - 1, x + w]) {
                                if (regionOf.get(i + ',' + j) === largestId) seeds.push(i + ',' + j);
                            }
                        }
                        const seen = new Set();
                        let largest = 0;
                        for (const seed of seeds) {
                            if (seen.has(seed)) continue;
                            let size = 0;
                            const stack = [seed];
                            seen.add(seed);
                            while (stack.length) {
                                const k = stack.pop();
                                size++;
                                const parts = k.split(',');
                                const kx = +parts[0], ky = +parts[1];
                                for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                                    if (seen.has(nk) || regionOf.get(nk) !== largestId) continue;
                                    const p2 = nk.split(',');
                                    if (inFoot(+p2[0], +p2[1])) continue;
                                    seen.add(nk);
                                    stack.push(nk);
                                }
                            }
                            if (size > largest) largest = size;
                        }
                        return target - largest;
                    };

                    let done = false;
                    // 1) dead pockets between the buildings - smallest pockets
                    // first, so the speckles get erased completely before a
                    // decoration bites into a bigger pocket
                    const pocketOrder = [];
                    for (const [cx, cy] of allCoords) {
                        const rid = regionOf.get(cx + ',' + cy);
                        if (rid === undefined || rid === largestId) continue;
                        pocketOrder.push([regionSizes[rid], cx, cy]);
                    }
                    pocketOrder.sort((p, q) => p[0] - q[0]);
                    for (const pc of pocketOrder) {
                        const cx = pc[1], cy = pc[2];
                        if (this.grid.get(cx + ',' + cy) !== 0) continue;
                        if (!this.canPlace(cx, cy, b.width, b.height)) continue;
                        this.placeEntity(b, cx, cy, 1);
                        done = true;
                        break;
                    }
                    // 2) pack against the built-up city, row by row from the
                    // top-left: the roadless buildings form one solid block right
                    // behind the street buildings, so the spare space collects as
                    // a single area at the far end of the map. A spot that
                    // strands no free tile wins instantly; otherwise the spot
                    // stranding the fewest wins - a small sealed notch beats the
                    // stripes of free tiles a strict rejection would leave
                    if (!done) {
                        let best = null;
                        let candidates = 0;
                        for (const [cx, cy] of allCoords) {
                            const key = cx + ',' + cy;
                            if (this.grid.get(key) !== 0 || regionOf.get(key) !== largestId) continue;
                            if (!this.canPlace(cx, cy, b.width, b.height)) continue;
                            const sealed = sealedAfter(cx, cy, b.width, b.height);
                            if (sealed <= 0) { best = [0, cx, cy]; break; }
                            if (!best || sealed < best[0]) best = [sealed, cx, cy];
                            if (++candidates >= 40) break;
                        }
                        if (best) {
                            this.placeEntity(b, best[1], best[2], 1);
                            done = true;
                        }
                    }
                    // 3) fallback: anywhere it fits, splitting allowed as the
                    // last resort
                    if (!done) {
                        for (const [cx, cy] of allCoords) {
                            if (this.grid.get(cx + ',' + cy) !== 0) continue;
                            if (this.canPlace(cx, cy, b.width, b.height)) {
                                this.placeEntity(b, cx, cy, 1);
                                break;
                            }
                        }
                    }
                }
    
                // slide the roadless mass together, so the seams the placement
                // order leaves between the rows close up
                this.compactRoadless();

                // Second chance for what did not fit: the compaction above closes
                // the seams the placement order left behind, and that often frees
                // exactly the 2x2 pockets the leftovers need. Without this retry
                // the buildings are reported as unplaced while the space they
                // require is already sitting there.
                {
                    const placedNow = new Set(this.placedBuildings.map(b => b.id));
                    const leftover = decos.filter(b => !placedNow.has(b.id));
                    if (leftover.length) {
                        const before = this.placedBuildings.length;
                        this.packRoadlessFast(leftover);
                        this.mark('retryLeftovers', (this.placedBuildings.length - before)
                            + ' of ' + leftover.length + ' placed after compaction');
                    }
                }

                // Still homeless while free tiles are lying around: repack the
                // whole roadless mass with the maximal-rectangle packer, and if
                // that is not enough, evict neighbours to make room. A dropped
                // building makes the whole variant unusable, so this is worth
                // far more than the milliseconds it costs.
                this.rescueLeftovers(decos);

                return this.measure(fragmentTiles);
            }

            /**
             * Rebuild the city exactly as it stands in the game right now.
             *
             * The player's own layout is a complete, working plan by definition
             * - on a full city it is often better than anything the search
             * comes up with. Measured with the same yardstick it becomes the
             * floor no proposal may fall below, which is the only way to stop
             * the module from offering a layout that costs more road than the
             * one already on the map.
             *
             * @param {Array} roadRects - the live road pieces, {x, y, width, height}
             * @returns {boolean} whether the city could be rebuilt from its own coordinates
             */
            placeCurrentCity(roadRects) {
                // everything here arrives in real map coordinates, while the
                // grid may be mirrored - so both roads and buildings go through
                // the same reflection the map areas did
                const mx = (x, w) => this.mirrorX ? this.mirrorAxisX - (x + w) : x;
                const my = (y, h) => this.mirrorY ? this.mirrorAxisY - (y + h) : y;

                for (const r of roadRects || []) {
                    // a two-lane street piece is the one that is 2x2
                    const lvl = (r.width > 1 && r.height > 1) ? 2 : 1;
                    const rx = mx(r.x, r.width), ry = my(r.y, r.height);
                    for (let i = rx; i < rx + r.width; i++) {
                        for (let j = ry; j < ry + r.height; j++) this.placeRoadTile(i, j, lvl);
                    }
                }

                for (const b of (this.townHall ? [this.townHall] : []).concat(this.buildings)) {
                    let x = mx(b.x, b.width), y = my(b.y, b.height);
                    if (b.chainMembers) {
                        // the composite stands where its leftmost member does -
                        // placing the members one by one would leave the
                        // composite's own id off the map and count as missing
                        x = Infinity; y = Infinity;
                        for (const m of b.chainMembers) {
                            if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return false;
                            x = Math.min(x, mx(m.x, m.width));
                            y = Math.min(y, my(m.y, m.height));
                        }
                    }
                    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
                    if (!this.canPlace(x, y, b.width, b.height)) return false;
                    this.placeEntity(b, x, y, b.type === 'main_building' ? 9 : 1);
                    if (b.type === 'main_building') this.townHallPos = [x, y];
                }
                return !!this.townHallPos;
            }

            /**
             * Score whatever currently stands on the grid.
             *
             * Split out of run() so the city the player already built can be
             * measured with the very same yardstick: a proposal that needs more
             * road than what is on the map is not an improvement, and without
             * measuring both the same way there is no way to notice.
             *
             * @param {number} fragmentTiles - free-space fragmentation of the street layout
             */
            measure(fragmentTiles) {
                const minX = this.mapBounds.minX, maxX = this.mapBounds.maxX;
                const minY = this.mapBounds.minY, maxY = this.mapBounds.maxY;

                // usable spare space: the largest empty rectangle left on the map.
                // "connected" alone is not enough - a thin ring around the city is
                // connected but useless; free tiles outside the biggest rectangle
                // count as waste, so compact corner layouts win the selection
                let wastedFree = 0, freeTotal = 0, freeOutside = 0, squareSide = 0, rectW = 0, rectH = 0;
                {
                    const W = maxX - minX;
                    let finalFree = 0, largestRect = 0;
                    const heights = new Array(W).fill(0);
                    // largest all-free square, DP row by row: prev/cur hold the
                    // side of the biggest square ending in each column
                    let prevSq = new Array(W).fill(0);
                    let curSq = new Array(W).fill(0);
                    for (let y = minY; y < maxY; y++) {
                        for (let x = minX; x < maxX; x++) {
                            const free = this.isFreeTile(x, y);
                            const i = x - minX;
                            if (free) {
                                finalFree++;
                                curSq[i] = (i === 0)
                                    ? 1
                                    : 1 + Math.min(prevSq[i], prevSq[i - 1], curSq[i - 1]);
                                if (curSq[i] > squareSide) squareSide = curSq[i];
                            } else {
                                curSq[i] = 0;
                            }
                            heights[i] = free ? heights[i] + 1 : 0;
                        }
                        const swap = prevSq; prevSq = curSq; curSq = swap;
                        // largest rectangle in histogram, monotonic stack
                        const stack = [];
                        for (let i = 0; i <= W; i++) {
                            const h = i < W ? heights[i] : 0;
                            while (stack.length && heights[stack[stack.length - 1]] >= h) {
                                const th = heights[stack.pop()];
                                const left = stack.length ? stack[stack.length - 1] + 1 : 0;
                                const area = th * (i - left);
                                // the usable spare space is not always a square -
                                // remember the shape of the biggest rectangle too
                                if (area > largestRect) {
                                    largestRect = area;
                                    rectW = i - left;
                                    rectH = th;
                                }
                            }
                            stack.push(i);
                        }
                    }
                    wastedFree = finalFree - largestRect;
                    freeTotal = finalFree;

                    // spare space should be one single block: everything outside
                    // the largest connected free region is a leftover seam
                    let largestRegion = 0;
                    const seen = new Set();
                    for (const key of this.grid.keys()) {
                        if (!this.isFreeKey(key) || seen.has(key)) continue;
                        let size = 0;
                        const stack = [key];
                        seen.add(key);
                        while (stack.length) {
                            const k = stack.pop();
                            size++;
                            const parts = k.split(',');
                            const kx = +parts[0], ky = +parts[1];
                            for (const nk of [(kx-1)+','+ky, (kx+1)+','+ky, kx+','+(ky-1), kx+','+(ky+1)]) {
                                if (this.isFreeKey(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
                            }
                        }
                        if (size > largestRegion) largestRegion = size;
                    }
                    freeOutside = finalFree - largestRegion;
                }

                // how much of the city this plan leaves standing: the number that
                // decides whether it can be carried out at all
                let kept = 0, known = 0;
                for (const b of this.placedBuildings) {
                    if (b.homeX === undefined) continue;
                    known++;
                    if (b.x === b.homeX && b.y === b.homeY) kept++;
                }

                // built building area minus road area: the winning strategy places
                // as much as possible while spending the fewest road tiles; a placed
                // building that never got a road counts like a missing one
                let builtTiles = 0;
                let unconnected = 0;
                const l2linked = this.linkedTwoLaneTiles();
                for (const b of this.placedBuildings) {
                    const r = this.connRect(b);
                    const bad = (b.street_level > 0 && !this.isConnectedToRoad(r.x, r.y, r.width, r.height))
                        || ((b.street_level || 0) >= 2 && !this.touchesTwoLane(r, l2linked));
                    if (bad) {
                        unconnected++;
                        continue;
                    }
                    builtTiles += b.width * b.height;
                }

                // whatever still has no spot gets reported instead of silently
                // dropped - chain composites are split back into their members,
                // sizes go back to real map orientation
                const finalIds = new Set(this.placedBuildings.map(b => b.id));
                const unplaced = [];
                for (const b of [this.townHall, ...this.buildings]) {
                    if (finalIds.has(b.id)) continue;
                    const members = b.chainMembers ? b.chainMembers : [b];
                    for (const m of members) {
                        unplaced.push({
                            id: m.id,
                            asset_id: m.asset_id,
                            name: m.name,
                            type: m.type,
                            width: this.transposed ? m.height : m.width,
                            height: this.transposed ? m.width : m.height,
                            street_level: m.street_level || 0
                        });
                    }
                }

                this.mark('final', 'square ' + squareSide + 'x' + squareSide + ', free ' + freeTotal
                    + ' (' + freeOutside + ' outside the main block), missing ' + (this.buildings.length - this.placedBuildings.length + 1));

                return {
                    success: true,
                    layout: this.generateExportData(),
                    unplaced: unplaced,
                    stats: {
                        strategy: this.strategy,
                        sortMode: this.sortMode,
                        packMode: this.packMode,
                        seed: this.seed,
                        // where this layout puts the town hall - the one thing
                        // about a plan a player sees before any of the numbers
                        placement: this.centerStart && this.trunkAt === 'center'
                            ? 'center'
                            : ((this.mirrorY ? 'bottom' : 'top') + '-' + (this.mirrorX ? 'right' : 'left')),
                        score: builtTiles - this.roadTiles.size,
                        fragments: fragmentTiles,
                        wasted: wastedFree,
                        square: squareSide,
                        rectW: rectW,
                        rectH: rectH,
                        freeTotal: freeTotal,
                        freeOutside: freeOutside,
                        reserve: this.reserve ? this.reserve.size : 0,
                        trace: this.trace,
                        roads: this.roadTiles.size,
                        l2: [...this.roadTiles].filter(k => (this.roadLevel.get(k) || 1) >= 2).length,
                        buildings: this.placedBuildings.length,
                        // buildings that keep their exact spot, and how many of
                        // them we could even judge (0 when the live city's
                        // coordinates were not supplied)
                        kept: kept,
                        knownHomes: known,
                        moved: known ? known - kept : 0,
                        missing: this.buildings.length - this.placedBuildings.length + 1,
                        unconnected: unconnected
                    }
                };
            }
        }
    
        // ---------------------------------------------------------------
        // Search driver. Fewest road tiles first, then the biggest square of
        // spare space - and a square may cost a few road tiles, because spare
        // space one cannot build on is not spare space.
        // A layout engine cannot be talked into leaving a big square by
        // scoring alone - so the search reserves a square up front, blocks
        // it and makes the engines fit the whole city around it. A binary
        // search over the side length finds the largest square that still
        // takes every building; the remaining budget shaves roads at that
        // size.
        // ---------------------------------------------------------------
        const STRATEGIES = ['district', 'bands', 'bands-vertical', 'organic'];
        const SORT_MODES = ['height', 'area', 'width'];
        const PACK_MODES = ['maxrects', 'fast', 'shelf', 'careful'];
        // which corner the district layout opens from, as [mirrorX, mirrorY]
        const MIRRORS = [[false, false], [true, false], [false, true], [true, true]];

        // A layout that drops buildings or leaves them without a road is not a
        // worse plan - it is not a plan at all, because it cannot be rebuilt in
        // the game. Completeness is therefore a hard gate, not a ranking
        // criterion: incomplete variants never become the proposal.
        function isComplete(r) {
            return r && r.success && (r.stats.missing + r.stats.unconnected) === 0;
        }

        // How many road tiles a bigger square of spare space may cost.
        // Roads still decide, but not by a single tile: 70 free tiles strung
        // out as a 40x1 ribbon are worth less than 64 in an 8x8 block, and
        // refusing to pay three tiles of asphalt for that block is not thrift.
        const ROAD_TOLERANCE = 5;

        // How many road tiles the layout representing a town hall position may
        // cost over the cheapest one for that position. Wider than the proposal's
        // tolerance on purpose: this picks what a button shows, not what is
        // proposed, and a corner is worth looking at in its tidy form.
        const PLACEMENT_TOLERANCE = 12;

        /**
         * Pick between two complete layouts.
         *
         * Road count first, but only where the difference is real - within a
         * handful of tiles the two count as equally cheap and the usable
         * square decides instead. The floor argument is the fewest roads any
         * complete layout has managed so far: without it a chain of "only
         * three more tiles" steps could walk the proposal far away from the
         * cheapest layout, one tolerated step at a time.
         */
        function beatsBest(cand, best, floor) {
            if (!best) return true;
            const a = cand.stats, b = best.stats;
            const limit = (floor || Math.min(a.roads, b.roads)) + ROAD_TOLERANCE;
            // paying more than the tolerance over the cheapest layout known is
            // never on the table, whatever it buys
            if (a.roads > limit && a.roads > b.roads) return false;
            if (Math.abs(a.roads - b.roads) > ROAD_TOLERANCE) return a.roads < b.roads;
            if (a.square !== b.square) return a.square > b.square;
            if (a.roads !== b.roads) return a.roads < b.roads;
            const blobA = (a.freeTotal || 0) - (a.freeOutside || 0);
            const blobB = (b.freeTotal || 0) - (b.freeOutside || 0);
            if (Math.floor(blobA / 5) !== Math.floor(blobB / 5)) return blobA > blobB;
            if (a.l2 !== b.l2) return a.l2 < b.l2;
            return a.score > b.score;
        }

        // ranking among incomplete layouts - only ever used to explain a failed
        // search, never to propose a layout
        function beatsFallback(cand, best) {
            if (!best) return true;
            const a = cand.stats.missing + cand.stats.unconnected;
            const b = best.stats.missing + best.stats.unconnected;
            if (a !== b) return a < b;
            return cand.stats.roads < best.stats.roads;
        }

        // valid tiles of the map as a grid, plus the largest-square DP that
        // answers "does a KxK square of valid tiles fit here" in O(1)
        function mapGeometry(rawMap) {
            const arr = Array.isArray(rawMap) ? rawMap : Object.values(rawMap || {});
            let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
            const tiles = new Set();
            for (const area of arr) {
                const ax = area.x || 0, ay = area.y || 0;
                const aw = area.width || 4, al = area.length || 4;
                minX = Math.min(minX, ax); maxX = Math.max(maxX, ax + aw);
                minY = Math.min(minY, ay); maxY = Math.max(maxY, ay + al);
                for (let i = ax; i < ax + aw; i++) {
                    for (let j = ay; j < ay + al; j++) tiles.add(i + ',' + j);
                }
            }
            const W = Math.max(0, maxX - minX), H = Math.max(0, maxY - minY);
            const sq = [];
            for (let j = 0; j < H; j++) {
                sq.push(new Array(W).fill(0));
                for (let i = 0; i < W; i++) {
                    if (!tiles.has((minX + i) + ',' + (minY + j))) continue;
                    sq[j][i] = (i === 0 || j === 0)
                        ? 1
                        : 1 + Math.min(sq[j - 1][i], sq[j - 1][i - 1], sq[j][i - 1]);
                }
            }
            return { tiles: tiles, count: tiles.size, minX: minX, maxX: maxX, minY: minY, maxY: maxY, W: W, H: H, sq: sq };
        }

        // where to cut the reserved square out of the map. A square taken
        // from a corner leaves the rest of the map in one piece, one taken
        // from the middle splits the city in two - so corners come first
        function squareAnchors(geo, size, limit) {
            if (size <= 0 || size > geo.W || size > geo.H) return [];
            const out = [];
            for (let j = size - 1; j < geo.H; j++) {
                for (let i = size - 1; i < geo.W; i++) {
                    if (geo.sq[j][i] < size) continue;
                    const ax = geo.minX + i - size + 1;
                    const ay = geo.minY + j - size + 1;
                    const dx = Math.min(ax - geo.minX, geo.maxX - (ax + size));
                    const dy = Math.min(ay - geo.minY, geo.maxY - (ay + size));
                    out.push({ x: ax, y: ay, size: size, edge: dx + dy });
                }
            }
            out.sort((a, b) => a.edge - b.edge || a.y - b.y || a.x - b.x);
            return out.slice(0, limit);
        }

        // total footprint of everything the optimizer will actually place -
        // mirrors the filters of processData
        function buildingArea(list) {
            const ignore = ["Hafen", "Terminal", "Hub", "Außenposten"];
            let sum = 0;
            for (const b of list) {
                if ((b.width || 0) <= 0) continue;
                if (['hub_main', 'hub_part', 'off_grid'].includes(b.type)) continue;
                if (ignore.some(ig => b.name.includes(ig))) continue;
                sum += b.width * b.height;
            }
            return sum;
        }

        let stopRequested = false;
        let busy = false;

        self.onmessage = function(e) {
            const msg = e.data || {};
            // the search yields to the event loop regularly, so a stop can
            // land while it is still running - it then returns the best
            // layout found so far instead of nothing
            if (msg.cmd === 'stop') { stopRequested = true; return; }
            if (busy) return;
            busy = true;
            runSearch(msg).catch(function(err) {
                self.postMessage({ success: false, error: err && err.message ? err.message : String(err) });
            });
        };

        async function runSearch(input) {
            try {
                const budgetMs = input.budgetMs || 600000;
                // safety net only - the clock is meant to end the search, so the
                // cap sits far above what a real city manages in its budget
                const maxRuns = 200000;
                const started = performance.now();
                const elapsed = () => performance.now() - started;
                const remaining = () => Math.max(0, budgetMs - elapsed());
                const strategies = STRATEGIES;
                const sortModes = SORT_MODES;

                let best = null;
                // fewest road tiles any complete layout has reached - the floor
                // the square tolerance is measured against
                let cheapestRoads = null;

                // Every complete layout that nothing beats on roads and square
                // at once. The ranking has to pick one plan, and its road
                // tolerance silently throws away the trade a player might well
                // want - on a city at 119 tiles it discarded a layout costing
                // ten more roads for a free square of 8x8 instead of 6x6. So
                // the alternatives are kept and offered instead of decided.
                const front = [];
                const FRONT_MAX = 6;
                const addToFront = (r) => {
                    const a = r.stats;
                    for (const f of front) {
                        const b = f.stats;
                        if (b.roads === a.roads && b.square === a.square) return;
                        // an existing entry is at least as cheap and at least as
                        // roomy, and strictly better in one - nothing to add
                        if (b.roads <= a.roads && b.square >= a.square) return;
                    }
                    for (let i = front.length - 1; i >= 0; i--) {
                        const b = front[i].stats;
                        if (a.roads <= b.roads && a.square >= b.square) front.splice(i, 1);
                    }
                    front.push(r);
                    // a front this long is noise, not a choice - keep the cheap end
                    if (front.length > FRONT_MAX) {
                        front.sort((x, y) => x.stats.roads - y.stats.roads);
                        front.length = FRONT_MAX;
                    }
                };

                // Best complete layout per town hall position. The front alone
                // would drop a centred plan the moment a corner beats it on both
                // numbers - but where the town hall sits is the first thing a
                // player judges a plan by, and "show me the centred one" is a
                // fair request even when it costs a few road tiles. So one plan
                // per position is kept regardless of the ranking.
                // The plain cheapest complete layout, whatever its spare space
                // looks like. The front and the per-position picks both lean
                // towards the roomy layout, and the coverage prune drops a plan
                // that costs two tiles less but scatters its free space - so the
                // one extreme a player may care about most can vanish. It is
                // always offered, on its own button.
                let cheapest = null;
                const noteCheapest = (r) => {
                    if (!cheapest
                        || r.stats.roads < cheapest.stats.roads
                        || (r.stats.roads === cheapest.stats.roads && r.stats.square > cheapest.stats.square)) {
                        cheapest = r;
                    }
                };

                const byPlacement = new Map();
                const notePlacement = (r) => {
                    const p = r.stats.placement || 'top-left';
                    const cur = byPlacement.get(p);
                    if (!cur) { byPlacement.set(p, r); return; }
                    // Same shape as the proposal's rule, but a wider tolerance,
                    // and deliberately so: this only decides which layout stands
                    // for a corner on its button, never what gets proposed. A
                    // genuinely cheap layout is already in the Pareto front, so
                    // the corner button is free to show the roomy one - and at
                    // the proposal's five tiles it kept showing plans whose
                    // spare space was 52 loose specks out of 80.
                    const a = r.stats, b = cur.stats;
                    // The wide tolerance buys a bigger square and nothing else.
                    // Letting it also buy "the same square, less scattered" made
                    // a corner pay eleven road tiles for eleven fewer specks at
                    // an unchanged 2x2 - the loose count only settles a tie.
                    if (a.square !== b.square) {
                        if (Math.abs(a.roads - b.roads) > PLACEMENT_TOLERANCE) {
                            if (a.roads < b.roads) byPlacement.set(p, r);
                        } else if (a.square > b.square) {
                            byPlacement.set(p, r);
                        }
                        return;
                    }
                    if (a.roads !== b.roads) {
                        if (a.roads < b.roads) byPlacement.set(p, r);
                        return;
                    }
                    if ((a.freeOutside || 0) < (b.freeOutside || 0)) byPlacement.set(p, r);
                };
                // best incomplete layout - kept only to report what went wrong
                let fallback = null;
                let runs = 0;
                let lastError = null;
                const tried = [];
                let phase = 'base';
                let pct = 0;

                const report = () => {
                    self.postMessage({
                        progress: Math.max(0, Math.min(99, Math.round(pct))),
                        phase: phase,
                        runs: runs,
                        etaMs: Math.round(remaining()),
                        square: best ? best.stats.square : 0,
                        roads: best ? best.stats.roads : 0,
                        reserve: best ? (best.stats.reserve || 0) : 0
                    });
                };

                // one layout attempt; yields to the event loop first so a stop
                // message can be delivered between runs
                const attempt = async (variant) => {
                    await new Promise(r => setTimeout(r, 0));
                    if (stopRequested || runs >= maxRuns) return null;
                    runs++;
                    let result = null;
                    try {
                        result = new CityOptimizerBrowser(input.mapData, input.buildingsData, variant).run();
                    } catch (err) {
                        result = { error: err && err.message ? err.message : 'failed' };
                    }
                    if (result && result.success) {
                        if (tried.length < 200) {
                            tried.push({
                                strategy: variant.strategy, sortMode: variant.sortMode,
                                packMode: variant.packMode, seed: variant.seed,
                                reserve: variant.reserve ? variant.reserve.size : 0,
                                square: result.stats.square, roads: result.stats.roads, l2: result.stats.l2,
                                freeOutside: result.stats.freeOutside, fragments: result.stats.fragments,
                                score: result.stats.score, missing: result.stats.missing, unconnected: result.stats.unconnected
                            });
                        }
                        // hard gate: only complete layouts can ever be proposed
                        if (isComplete(result)) {
                            addToFront(result);
                            notePlacement(result);
                            noteCheapest(result);
                            if (cheapestRoads === null || result.stats.roads < cheapestRoads) {
                                cheapestRoads = result.stats.roads;
                            }
                            if (beatsBest(result, best, cheapestRoads)) {
                                best = result;
                                if (variant.reserve) best.stats.reserveAt = variant.reserve;
                            }
                        } else if (beatsFallback(result, fallback)) {
                            fallback = result;
                        }
                    } else {
                        lastError = (result && result.error) || 'failed';
                        if (tried.length < 200) {
                            tried.push({ strategy: variant.strategy, sortMode: variant.sortMode, seed: variant.seed, error: lastError });
                        }
                    }
                    if (runs % 3 === 0) report();
                    return result;
                };

                // --- phase 0: the city the player already built --------------
                // A plan that costs more road than what is on the map is not a
                // plan, and on a full city the existing layout is frequently
                // unbeatable. It is complete by definition, so it goes in as
                // the floor the search has to clear - and if nothing does, the
                // honest answer is "keep what you have".
                // the player's own layout with the road passes run over it
                let tuned = null;
                let baselineNote = 'no road data for the current city';
                if (input.roadTiles && input.roadTiles.length) {
                    try {
                        const live = new CityOptimizerBrowser(input.mapData, input.buildingsData, { strategy: 'district' });
                        if (!live.placeCurrentCity(input.roadTiles)) {
                            baselineNote = 'the current city could not be rebuilt from its own coordinates';
                        } else {
                            const r = live.measure(0);
                            if (isComplete(r)) {
                                r.stats.baseline = true;
                                best = r;
                                cheapestRoads = r.stats.roads;
                                addToFront(r);
                                baselineNote = r.stats.roads + ' road tiles, complete - used as the floor';

                                // --- phase 0b: shave the player's own layout ---
                                // The two passes that turn a generated layout
                                // from 280 road tiles into 169 work on whatever
                                // stands on the grid - so they can be run on the
                                // live city too. Building from scratch throws
                                // away everything the player got right; this
                                // keeps it and only takes back the tiles that
                                // nothing needs. It is also the one plan a player
                                // can actually carry out, because most of the
                                // city stays where it is.
                                try {
                                    const polish = new CityOptimizerBrowser(input.mapData, input.buildingsData, { strategy: 'district' });
                                    if (polish.placeCurrentCity(input.roadTiles)) {
                                        polish.pruneRoadsSmart();
                                        const saved = polish.relocateForRoads(3);
                                        const t = polish.measure(0);
                                        if (isComplete(t) && t.stats.roads < r.stats.roads) {
                                            // not part of the per-corner set: its
                                            // town hall stands wherever the
                                            // player put it, not in a corner the
                                            // layout engine chose
                                            t.stats.tunedBaseline = true;
                                            // deliberately not in the Pareto
                                            // front: a generated layout with the
                                            // same roads and a bigger square
                                            // would push it out, and this is the
                                            // one plan the player can carry out
                                            // without rebuilding the city. It is
                                            // offered by category, like the town
                                            // hall positions.
                                            tuned = t;
                                            if (t.stats.roads < cheapestRoads) cheapestRoads = t.stats.roads;
                                            if (beatsBest(t, best, cheapestRoads)) best = t;
                                            baselineNote += '; polished to ' + t.stats.roads
                                                + ' (' + saved + ' tiles freed by moving buildings)';
                                        }
                                    }
                                } catch (err) {
                                    // polishing is a bonus, the floor stands either way -
                                    // but a silent catch once hid a name collision, so it
                                    // says so in the note as well as the console
                                    baselineNote += '; polishing failed - ' + (err && err.message ? err.message : err);
                                }
                            } else {
                                // knowing which check rejected it is the only way
                                // to tell a real difference from a reading bug
                                baselineNote = r.stats.roads + ' road tiles, but our rules call it incomplete ('
                                    + r.stats.missing + ' missing, ' + r.stats.unconnected
                                    + ' without a street) - ignored';
                            }
                        }
                    } catch (err) {
                        // reading the live city is a bonus, never a blocker
                        baselineNote = 'failed to read - ' + (err && err.message ? err.message : err);
                    }
                }
                console.log('CityBuilder baseline: ' + baselineNote);

                // --- phase 1: baseline without a reserved square ------------
                // establishes a layout that is guaranteed to work and measures
                // the square the plain packers leave on their own
                phase = 'base';
                // the base round packs fast: it is an order of magnitude quicker
                // and packs tighter, so the careful packer only appears in the
                // randomized rounds where there is time to spare
                const baseVariants = [];
                for (const strategy of strategies) {
                    // organic has not returned a single complete layout on any
                    // city measured (0 of 72 runs on one of them), so its base
                    // slots are pure loss. It stays in the refinement rotation,
                    // where a wasted run costs nothing anyone notices.
                    if (strategy === 'organic') continue;
                    for (const sortMode of sortModes) {
                        // road columns are only worth a base slot once: every
                        // extra base variant is one probe less for the square
                        // search, and that search is what makes the spare space
                        // one block instead of a seam
                        baseVariants.push({ strategy: strategy, sortMode: sortMode, seed: 0, packMode: 'maxrects', wideColumns: false });
                        // the second packer is a district-only luxury now: pack
                        // mode moved neither roads nor completeness on any city
                        // measured, and every base slot it eats is one the
                        // reserved-square phase needs
                        if (strategy === 'district') {
                            baseVariants.push({ strategy: strategy, sortMode: sortMode, seed: 0, packMode: 'fast', wideColumns: false });
                        }
                        if (strategy === 'district') {
                            baseVariants.push({ strategy: strategy, sortMode: sortMode, seed: 0, packMode: 'maxrects', wideColumns: false, trunkAt: 'center' });
                            baseVariants.push({ strategy: strategy, sortMode: sortMode, seed: 0, packMode: 'maxrects', wideColumns: false, trunkAt: 'center', centerStart: true });
                            // the other three corners. Measured worth 4-7 road
                            // tiles, and which one wins differs per city - the
                            // maps are irregular, so it cannot be picked ahead
                            for (const m of [[true, false], [false, true], [true, true]]) {
                                baseVariants.push({
                                    strategy: strategy, sortMode: sortMode, seed: 0,
                                    packMode: 'maxrects', wideColumns: false,
                                    mirrorX: m[0], mirrorY: m[1]
                                });
                            }
                        }
                    }
                }
                for (let i = 0; i < baseVariants.length; i++) {
                    if (stopRequested || remaining() <= 0) break;
                    await attempt(baseVariants[i]);
                    pct = 8 * (i + 1) / baseVariants.length;
                }

                // --- phase 2: how big can the reserved square be? -----------
                // binary search on the side length: if a KxK reserve still
                // takes every building, everything below K would too
                const geo = mapGeometry(input.mapData);
                const freeBudget = Math.max(0, geo.count - buildingArea(input.buildingsData));
                let lo = best && isComplete(best) ? best.stats.square : 0;
                let hi = Math.min(geo.W, geo.H, Math.floor(Math.sqrt(freeBudget)));
                const searchStart = elapsed();
                // the square is the second goal, roads are the first - so most
                // of the clock belongs to the road refinement that follows
                const searchBudget = budgetMs * 0.35;
                const steps = Math.max(1, Math.ceil(Math.log2(Math.max(2, hi - lo + 1))));
                let step = 0;

                // A run on a small city takes milliseconds, on a full 400-building
                // city well over a second - a fixed number of probes per step
                // would eat the whole budget there. So the probe width follows the
                // measured cost of a single run.
                const avgRunMs = runs > 0 ? Math.max(1, elapsed() / runs) : 50;
                const estRuns = Math.max(10, Math.floor(remaining() / avgRunMs));
                const anchorLimit = Math.max(2, Math.min(10, Math.round(estRuns / 40)));
                const probeCap = Math.max(3, Math.floor(estRuns / Math.max(2, steps * 3)));
                console.log('CityBuilder search: ' + Math.round(avgRunMs) + ' ms per run, ~' + estRuns
                    + ' runs left, ' + anchorLimit + ' anchors and ' + probeCap + ' runs per probe');

                phase = 'square';
                while (lo < hi && !stopRequested && remaining() > 0 && (elapsed() - searchStart) < searchBudget) {
                    const mid = Math.ceil((lo + hi) / 2);
                    const anchors = squareAnchors(geo, mid, anchorLimit);
                    const probeStartRuns = runs;
                    // time slice for this probe: what is left of the phase,
                    // spread over the binary-search steps still to come
                    const sliceEnd = elapsed() + Math.max(1500, (searchBudget - (elapsed() - searchStart)) / Math.max(1, steps - step));
                    let feasible = false;

                    // every anchor with every layout engine first, then the same
                    // grid again with jittered build orders - a square this big
                    // often fits only in one particular order, so declaring it
                    // impossible after the deterministic runs alone is premature
                    outer:
                    for (let probeRound = 0; probeRound < 200; probeRound++) {
                        for (let ai = 0; ai < anchors.length; ai++) {
                            for (const strategy of strategies) {
                                for (const sortMode of sortModes) {
                                    if (stopRequested || elapsed() > sliceEnd || remaining() <= 0) break outer;
                                    if (runs - probeStartRuns >= probeCap) break outer;
                                    const r = await attempt({
                                        strategy: strategy,
                                        sortMode: sortMode,
                                        seed: probeRound === 0 ? 0 : probeRound * 31 + ai,
                                        // the packer decides whether a square of
                                        // this size still takes every building,
                                        // so the probe alternates between the
                                        // tight one and the quick one
                                        packMode: probeRound % 2 === 0 ? 'maxrects' : 'fast',
                                        wideColumns: probeRound % 2 === 1,
                                        // the corners have to reach this phase too:
                                        // a reserved square is the only thing that
                                        // gathers the spare space into one block,
                                        // and without it every mirrored layout is
                                        // condemned to a field of loose tiles
                                        mirrorX: MIRRORS[probeRound % MIRRORS.length][0],
                                        mirrorY: MIRRORS[probeRound % MIRRORS.length][1],
                                        reserve: anchors[ai]
                                    });
                                    if (isComplete(r)) { feasible = true; break outer; }
                                }
                            }
                        }
                    }

                    if (feasible) lo = mid; else hi = mid - 1;
                    step++;
                    pct = 8 + 32 * Math.min(1, step / steps);
                    report();
                }

                // --- phase 3: same square, fewer roads ----------------------
                // the side length is settled; the rest of the budget goes into
                // randomized restarts that try to serve the city with less road
                phase = 'roads';
                // The size the binary search proved feasible, not the size the
                // current front-runner happens to have. Roads rank first, so the
                // front-runner is regularly a layout with a 3x3 square while the
                // search has just shown 8x8 fits - reserving 3 then throws that
                // proof away and every later run inherits speckled spare space.
                const target = Math.max(lo, best && isComplete(best) ? best.stats.square : 0);
                const anchors = squareAnchors(geo, target, 14);

                // --- phase 2b: the same square for every town hall position --
                // Left to the random rotation the corners hardly ever draw a
                // reserved square, and without one their spare space stays a
                // field of single tiles - 61 loose of 74 on the user's own city
                // against 10 with a reserve, at the very same road count. Each
                // position is therefore given one deliberate run with it.
                if (anchors.length) {
                    const sortMode = (best && best.stats.sortMode) || sortModes[0];
                    const placements = [
                        { mirrorX: false, mirrorY: false },
                        { mirrorX: true, mirrorY: false },
                        { mirrorX: false, mirrorY: true },
                        { mirrorX: true, mirrorY: true },
                        { trunkAt: 'center', centerStart: true }
                    ];
                    // Three anchors, one build order. Cycling the build order as
                    // well was tried and measured worse: the extra runs came out
                    // of the refinement, and corners that had been landing an 8x8
                    // square fell back to 3x3. The stubborn corners are better
                    // left to the refinement rounds than paid for here.
                    for (const p of placements) {
                        if (stopRequested || remaining() <= 0) break;
                        // the first anchor does not suit every corner - with the
                        // square cut out of the wrong side a layout can lose
                        // buildings and be thrown away, so try a few spots
                        for (let ai = 0; ai < Math.min(3, anchors.length); ai++) {
                            if (stopRequested || remaining() <= 0) break;
                            const r = await attempt(Object.assign({
                                strategy: 'district', sortMode: sortMode, seed: 0,
                                packMode: 'maxrects', wideColumns: false, reserve: anchors[ai]
                            }, p));
                            if (isComplete(r)) break;
                        }
                    }
                }
                // the column variant lives in the randomized rounds
                let round = 0;
                const refineStart = elapsed();
                const refineTotal = Math.max(1, remaining());
                while (!stopRequested && remaining() > 0 && runs < maxRuns) {
                    // every third round runs without a reserve: a forced square
                    // makes the layout tighter and that can cost road tiles -
                    // and roads are what the ranking asks for first
                    const anchor = (!anchors.length || round % 3 === 2) ? null : anchors[round % anchors.length];
                    const variant = {
                        strategy: strategies[round % strategies.length],
                        sortMode: sortModes[((round / strategies.length) | 0) % sortModes.length],
                        seed: 1 + round,
                        packMode: PACK_MODES[round % PACK_MODES.length],
                        wideColumns: ((round / 2) | 0) % 2 === 0,
                        // own stride, so the corner does not stay locked to the
                        // strategy the way pack mode and wideColumns are
                        mirrorX: MIRRORS[((round / 5) | 0) % MIRRORS.length][0],
                        mirrorY: MIRRORS[((round / 5) | 0) % MIRRORS.length][1],
                        reserve: anchor
                    };
                    await attempt(variant);
                    round++;
                    pct = 40 + 59 * Math.min(1, (elapsed() - refineStart) / refineTotal);
                }

                if (best) {
                    best.stats.runs = runs;
                    best.stats.tried = tried;
                    best.stats.stopped = stopRequested;
                    best.stats.elapsedMs = Math.round(elapsed());
                    best.stats.baselineNote = baselineNote;

                    // the proposal is always on the list, even when the front
                    // technically dominates it - it is what the ranking chose
                    // and switching away from it has to be the player's move.
                    // An entry with the same two numbers is the same offer and
                    // stands in for it - pushing regardless doubles the button.
                    const sameOffer = (f) => f === best
                        || (f.stats.roads === best.stats.roads && f.stats.square === best.stats.square);
                    if (!front.some(sameOffer)) front.push(best);

                    // one plan per town hall position on top of the front, so a
                    // centred layout is on offer even when a corner beats it.
                    // A position the front already covers gets no second button
                    // - two entries labelled "town hall top left" read as a bug,
                    // and the front's own entry is the better of the two anyway.
                    // the polished live city goes in ahead of the corners: it is
                    // the only plan that keeps most buildings where they stand
                    if (tuned && front.indexOf(tuned) === -1) front.push(tuned);

                    // the fewest-roads extreme, flagged so nothing prunes it and
                    // so its button says what it is rather than which corner it
                    // happens to use
                    if (cheapest && !cheapest.stats.baseline) {
                        cheapest.stats.cheapestRoads = true;
                        if (front.indexOf(cheapest) === -1) front.push(cheapest);
                    }

                    for (const r of byPlacement.values()) {
                        if (front.length >= 6) break;
                        if (front.some(f => !f.stats.baseline && !f.stats.tunedBaseline
                            && f.stats.placement === r.stats.placement)) continue;
                        front.push(r);
                    }

                    front.sort((x, y) => x.stats.roads - y.stats.roads || y.stats.square - x.stats.square);

                    // Two plans for the same town hall position are a real choice
                    // only when the cheaper one is meaningfully cheaper. 122
                    // roads with a 2x2 square next to 123 with 8x8 is not a
                    // decision - one road tile against fifty usable ones - while
                    // 126 with 2x2 next to 129 with 8x8 is exactly the trade the
                    // switcher exists for. So an entry goes if another for the
                    // same position is at least as roomy and costs no more than
                    // two tiles extra. The proposal and the player's own layout
                    // are never dropped.
                    for (let i = front.length - 1; i >= 0; i--) {
                        const a = front[i];
                        if (a === best || a.stats.baseline || a.stats.tunedBaseline || a.stats.cheapestRoads) continue;
                        const covered = front.some(b => b !== a && !b.stats.baseline && !b.stats.tunedBaseline
                            && b.stats.placement === a.stats.placement
                            && b.stats.square >= a.stats.square
                            && b.stats.roads <= a.stats.roads + 2);
                        if (covered) front.splice(i, 1);
                    }

                    best.variantIndex = Math.max(0, front.findIndex(sameOffer));
                    // the layouts are shared with the proposal, and a structured
                    // clone keeps shared references shared - so this costs one copy
                    best.variants = front.map(f => ({
                        layout: f.layout,
                        unplaced: f.unplaced,
                        stats: f.stats
                    }));

                    self.postMessage(best);
                } else if (fallback) {
                    // nothing complete was found: report the failure instead of
                    // proposing a layout that cannot be rebuilt in the game
                    fallback.stats.runs = runs;
                    fallback.stats.stopped = stopRequested;
                    fallback.stats.elapsedMs = Math.round(elapsed());
                    // the variant list is what explains a failure - it was only
                    // ever attached to a successful result
                    fallback.stats.tried = tried;
                    self.postMessage({
                        success: false,
                        incomplete: true,
                        missing: fallback.stats.missing,
                        unconnected: fallback.stats.unconnected,
                        unplaced: fallback.unplaced,
                        layout: fallback.layout,
                        stats: fallback.stats,
                        runs: runs,
                        stopped: stopRequested
                    });
                } else {
                    self.postMessage({ success: false, error: lastError || 'Kein Layout gefunden' });
                }
            } catch (err) {
                self.postMessage({ success: false, error: err && err.message ? err.message : String(err) });
            } finally {
                busy = false;
            }
        }`;
