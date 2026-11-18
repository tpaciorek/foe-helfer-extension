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

// Loaded after city-builder.js via the "parts" mechanism in js/internal.json, so
// CityBuilder is already there and this file only has to extend it.
//
// What it is for: the City Builder hands out a finished layout, but carrying it
// out in the game's reconstruction mode means placing four hundred buildings by
// hand with no idea which one comes next. This turns a chosen layout into an
// ordered walk through the city - and the order is the whole point: the city is
// drawn isometrically, so a building's sprite covers the ground *behind* it. Fill
// the map front to back and every building you place hides the spot the next one
// belongs on; fill it back to front and the ground you still need stays visible.

let RebuildGuide = {

    // the layout being carried out - one of the variants the City Builder
    // offered, handed over explicitly by the player
    Plan: null,
    // plan items in placement order, each with its band and current state
    Steps: [],
    // entityId -> draft entry while the game is in reconstruction mode. Outside
    // it the live city map is the source, so the guide also works when the
    // player just looks at their city
    Draft: null,
    // the band the player is working on
    Band: 0,
    // set while the player pages through the bands by hand - stops the guide
    // from jumping back to the first unfinished one under their fingers
    ManualBand: false,
    // the last placement that did not match the plan, shown as a warning
    OffPlan: null,
    // buildings put down in reconstruction mode off every spot of the plan,
    // each with the spot it should go to: [{rec, target}]
    Misplaced: [],
    // the building the player looked up ("where does this go?"):
    // {a, n, w, h, s, t}. Its free spots are outlined on the game map until the
    // player clears it - a building often comes in many copies, so it stays
    // picked while they put them down one by one
    Seek: null,
    // whether the variant list of the guide is unfolded - kept across redraws
    VariantsOpen: false,
    // where the player dragged the plan map to; while set, a redraw keeps
    // that view instead of jumping back to the current step
    MapScroll: null,
    // the markers on the game map are the guide's - only then may it take them
    // down again, another module may have put its own arrows there
    SeekMarked: false,


    /**
     * Screen depth of a tile. The overlay transform the helper puts on the live
     * city (skewX(-63.5deg) skewY(14deg) scale(s, s/4)) works out to
     * screen_x ~ (x - y) / 2, screen_y ~ (x + y) / 4 - a plain isometric
     * projection. So x+y is how far down the screen a tile sits, and a stripe of
     * constant x+y is a horizontal line in the game.
     *
     * @param {Object} s - plan item with x/y
     * @returns {number} depth in the game view, or the plain row in row mode
     */
    Depth: (s) => RebuildGuide.Order() === 'rows' ? s.y : s.x + s.y,


    Order: () => localStorage.getItem('RebuildGuideOrder') || 'screen',
    // short view: only the search box, its answer and what is left
    Compact: () => localStorage.getItem('RebuildGuideCompact') === '1',
    BandSize: () => Math.max(1, parseInt(localStorage.getItem('RebuildGuideBand') || 4)),
    ShowRoads: () => localStorage.getItem('RebuildGuideRoads') !== '0',
    // 12 px per tile is the smallest scale at which a 3x4 building still has
    // room for its number and its footprint written into it
    Scale: () => Math.max(4, parseInt(localStorage.getItem('RebuildGuideScale') || 12)),


    /**
     * One storage slot per world and player: a plan for another city is worse
     * than no plan at all, it points at coordinates that mean something else.
     *
     * @returns {string} localStorage key
     */
    StorageKey: () => 'CityBuilderRebuildPlan|'
        + ((typeof ExtWorld !== 'undefined' && ExtWorld) || '?') + '|'
        + ((typeof ExtPlayerName !== 'undefined' && ExtPlayerName) || '?'),


    /**
     * Takes the layout currently shown in the City Builder as the plan to carry
     * out. Called from the button in the map toolbar - the variant on screen is
     * the one the player decided on.
     */
    UsePlan: () => {
        const items = (typeof CityBuilder !== 'undefined' && CityBuilder.Data) || [];
        if (!items.length) {
            HTML.ShowToastMsg({
                head: i18n('Boxes.RebuildGuide.Title'),
                text: i18n('Boxes.CityBuilder.NoData'),
                type: 'error',
                hideAfter: 4000
            });
            return;
        }

        // A layout for a city we are only visiting must never reach the storage:
        // the slot is keyed by our own name, so it would quietly overwrite the
        // plan we are in the middle of building - and its coordinates mean
        // something else entirely in our city. Looking at other people's cities
        // is what the City Builder is for; carrying one out is not.
        if (typeof ActiveMap !== 'undefined' && ActiveMap === 'OtherPlayer') {
            HTML.ShowToastMsg({
                head: i18n('Boxes.RebuildGuide.Title'),
                text: i18n('Boxes.RebuildGuide.OwnCityOnly'),
                type: 'error',
                hideAfter: 6000
            });
            return;
        }

        RebuildGuide.Plan = {
            world: (typeof ExtWorld !== 'undefined' && ExtWorld) || '',
            owner: (typeof ExtPlayerName !== 'undefined' && ExtPlayerName) || '',
            created: Date.now(),
            label: (CityBuilder.VariantLabel && CityBuilder.VariantLabel(CityBuilder.VariantIndex)) || '',
            // short keys on purpose: four hundred items go through localStorage
            items: items.map(b => ({
                x: parseInt(b.x) || 0,
                y: parseInt(b.y) || 0,
                w: parseInt(b.width) || 1,
                h: parseInt(b.height) || 1,
                a: b.asset_id || '',
                n: b.name || '',
                t: (b.type === 'street' || b.name === 'Road') ? 'street' : (b.type || 'generic_building'),
                s: b.street_level || 0,
                l: parseInt(b.level) || 1
            }))
        };

        // Read back what was written. A rebuild runs over days and reloads, so
        // "it is remembered" is the whole promise here - and a storage that
        // silently refused (quota, private mode) would only be found out after
        // the reload, with the search to run again.
        let stored = false;
        try {
            localStorage.setItem(RebuildGuide.StorageKey(), JSON.stringify(RebuildGuide.Plan));
            stored = !!localStorage.getItem(RebuildGuide.StorageKey());
        } catch (e) {
            console.warn('RebuildGuide: plan could not be stored', e);
        }

        HTML.ShowToastMsg({
            head: i18n('Boxes.RebuildGuide.Title'),
            text: i18n(stored ? 'Boxes.RebuildGuide.Stored' : 'Boxes.RebuildGuide.NotStored'),
            type: stored ? 'success' : 'error',
            hideAfter: stored ? 4000 : 8000
        });

        RebuildGuide.Band = 0;
        RebuildGuide.ManualBand = false;
        RebuildGuide.OffPlan = null;
        RebuildGuide.Prepare();
        RebuildGuide.Open();
    },


    /**
     * The variants of the City Builder's last search, ready to pick from inside
     * the guide: what each costs in roads, the square it keeps free, how many
     * buildings it moves and - while a plan is being carried out - how many of
     * its spots that plan already shares. One of them is marked as the
     * recommendation.
     *
     * Only a search on our own city counts: a visited city's layout can never
     * become the plan.
     *
     * @returns {Array<Object>} [{i, label, roads, square, moved, shared, current, recommended}]
     */
    VariantRows: () => {
        if (typeof CityBuilder === 'undefined') return [];
        const list = CityBuilder.Variants || [];
        if (!list.length || (CityBuilder.SearchMap && CityBuilder.SearchMap !== 'main')) return [];

        const excluded = CityBuilder.Excluded || new Set();
        const shown = (v) => v.layout.filter(b => !(b.id !== undefined && b.id !== null && excluded.has(b.id)));
        const key = (b) => (parseInt(b.x) || 0) + ',' + (parseInt(b.y) || 0) + ',' + (parseInt(b.width) || 1) + 'x' + (parseInt(b.height) || 1);
        const plan = RebuildGuide.Plan;
        const planKeys = plan ? new Set(plan.items.map(it => it.x + ',' + it.y + ',' + it.w + 'x' + it.h)) : null;

        const rows = list.map((v, i) => {
            if (!v || !v.layout) return null;
            const items = shown(v);
            const st = v.stats || {};
            return {
                i: i,
                label: CityBuilder.VariantLabel ? CityBuilder.VariantLabel(i) : String(i + 1),
                roads: st.roads,
                square: st.square,
                moved: typeof st.moved === 'number' ? st.moved : null,
                total: st.knownHomes || null,
                shared: planKeys ? items.filter(b => planKeys.has(key(b))).length : null,
                count: items.length,
                current: !!plan && RebuildGuide.Signature(items) === plan.sig,
                recommended: false
            };
        }).filter(Boolean);
        if (!rows.length) return rows;

        // A few roads are worth far less than a few hundred buildings carried
        // across the city: among the plans close to the fewest roads, the one
        // that keeps most of what stands - of the plan under way when there is
        // one, of the live city otherwise
        const minRoads = Math.min(...rows.map(r => r.roads || 0));
        const close = rows.filter(r => (r.roads || 0) <= minRoads + 3);
        const score = (r) => r.shared !== null ? -r.shared : (r.moved !== null ? r.moved : 0);
        close.sort((a, b) => score(a) - score(b) || (a.roads || 0) - (b.roads || 0));
        close[0].recommended = true;
        return rows;
    },


    /**
     * Makes one of the City Builder's variants the plan. Replacing a plan that
     * is already half built asks first - that progress is what it throws away.
     *
     * @param {number} i - index into CityBuilder.Variants
     */
    UseVariant: (i) => {
        if (typeof CityBuilder === 'undefined' || !CityBuilder.Variants || !CityBuilder.Variants[i]) return;
        const p = RebuildGuide.Plan && RebuildGuide.Steps.length ? RebuildGuide.Progress() : null;
        if (p && p.done > 0) {
            const q = i18n('Boxes.RebuildGuide.ReplaceAsk')
                .replace('__done__', p.done).replace('__total__', p.total);
            if (!window.confirm(q)) return;
        }
        CityBuilder.SelectVariant(i);
        RebuildGuide.UsePlan();
    },


    /**
     * Reads a plan stored in an earlier session. The rebuild takes hours and
     * survives reloads, the plan has to as well.
     *
     * @returns {boolean} whether a usable plan is loaded
     */
    Load: () => {
        if (RebuildGuide.Plan) return true;
        try {
            const raw = localStorage.getItem(RebuildGuide.StorageKey());
            if (!raw) return false;
            const plan = JSON.parse(raw);
            if (!plan || !Array.isArray(plan.items) || !plan.items.length) return false;
            RebuildGuide.Plan = plan;
            RebuildGuide.Prepare();
            return true;
        } catch (e) {
            console.warn('RebuildGuide: stored plan unreadable', e);
            return false;
        }
    },


    /**
     * Whether there is a plan to go back to - asked by the city map before it
     * offers a button for it.
     *
     * @returns {boolean}
     */
    HasStoredPlan: () => {
        if (RebuildGuide.Plan) return true;
        try { return !!localStorage.getItem(RebuildGuide.StorageKey()); } catch (e) { return false; }
    },


    /**
     * The variant the City Builder shows for our own city when it is not the
     * stored plan. The plan is only replaced on request, so after a new search
     * the guide would otherwise keep walking the old one without a word.
     *
     * @returns {string|null} escaped label of that variant, null when there is none
     */
    NewerShown: () => {
        if (typeof CityBuilder === 'undefined' || !RebuildGuide.Plan) return null;
        // Stats is only set by a search - a plan drawn on its own has none
        if (!CityBuilder.Stats || CityBuilder.SearchMap !== 'main') return null;
        const shown = CityBuilder.Data || [];
        if (!shown.length || RebuildGuide.Signature(shown) === RebuildGuide.Plan.sig) return null;
        return (CityBuilder.VariantLabel && CityBuilder.VariantLabel(CityBuilder.VariantIndex))
            || i18n('Boxes.RebuildGuide.NewerShownPlain');
    },


    /**
     * Forgets the plan - after the rebuild, or when it turned out to be the
     * wrong one.
     */
    Drop: () => {
        RebuildGuide.Plan = null;
        RebuildGuide.Steps = [];
        RebuildGuide.OffPlan = null;
        RebuildGuide.Seek = null;
        if (RebuildGuide.SeekMarked && typeof BuildingMarker !== 'undefined') BuildingMarker.hide();
        RebuildGuide.SeekMarked = false;
        try { localStorage.removeItem(RebuildGuide.StorageKey()); } catch (e) { /* nothing to clean up */ }
        RebuildGuide.Render();
        if (typeof CityBuilder !== 'undefined' && $('#city-builder-canvas').length) CityBuilder.Renderer.render();
    },


    /**
     * Turns the plan into the ordered walk: back to front, and inside one stripe
     * from left to right across the screen. Ties on depth cannot overlap on
     * screen, so their order is free - x decides, which reads as left to right.
     */
    Prepare: () => {
        if (!RebuildGuide.Plan) { RebuildGuide.Steps = []; return; }

        // computed, not stored: it has to match a layout the City Builder shows
        // today, and the item order is the one it was handed over in
        RebuildGuide.Plan.sig = RebuildGuide.Signature(RebuildGuide.Plan.items);

        // read the mode once: four hundred items mean thousands of comparisons,
        // and every one of them would otherwise hit localStorage
        const rows = RebuildGuide.Order() === 'rows';
        const depth = (s) => rows ? s.y : s.x + s.y;

        const steps = RebuildGuide.Plan.items.map(it => ({ ...it, state: 'todo', blocker: null }));
        steps.sort((a, b) => depth(a) - depth(b)
            || a.x - b.x
            || a.y - b.y);

        // bands are counted from the first tile the plan uses, not from zero:
        // the unlocked area rarely starts at the map origin and an empty first
        // band is a step that cannot be done
        const size = RebuildGuide.BandSize();
        const base = steps.length ? depth(steps[0]) : 0;
        for (const s of steps) s.band = Math.floor((depth(s) - base) / size);

        RebuildGuide.Steps = steps;
        RebuildGuide.Evaluate();
    },


    /**
     * Every tile the city currently occupies, mapped to the entity standing on
     * it. The draft wins while the game is in reconstruction mode, because that
     * is where the buildings really are; outside it the city map is the truth.
     *
     * @returns {Map<string, Object>} "x,y" -> {id, a, t, x, y, w, h, n}
     */
    /**
     * Street requirement of a building, read exactly as the layout search reads
     * it (see MergeData) - both sides have to agree on which buildings need a
     * road, or a spot planned without one would accept a building that needs one.
     *
     * @param {Object} meta - entity metadata
     * @param {string} type - the instance's type
     * @returns {number} required street level
     */
    StreetLevel: (meta, type) => {
        let req = meta.requirements?.street_connection_level;
        if (req === undefined) {
            if (Array.isArray(meta.abilities)
                && meta.abilities.some(a => a.__class__ === 'StreetConnectionRequirementComponent')) req = 1;
            if (meta.components?.AllAge?.streetConnectionRequirement !== undefined) {
                req = meta.components.AllAge.streetConnectionRequirement.requiredLevel;
            } else if (meta.components?.streetConnectionRequirement !== undefined) {
                req = meta.components.streetConnectionRequirement.requiredLevel;
            }
        }
        req = req === undefined ? 0 : parseInt(req);
        if (['greatbuilding', 'main_building'].includes(type) && req === 0) req = 1;
        if (type === 'decoration') req = 0;
        return req;
    },


    /**
     * Footprint, name and street requirement of one asset, or null when the
     * building is one the layout never plans for.
     *
     * @param {string} assetId
     * @param {string} [instType] - the instance's type, which beats the meta's
     * @returns {Object|null} {n, w, h, t, s}
     */
    Meta: (assetId, instType) => {
        const meta = ((typeof MainParser !== 'undefined' && MainParser.CityEntities) || {})[assetId];
        if (!meta) return null;
        const type = instType || meta.type;
        if (['hub_main', 'hub_part', 'off_grid', 'outpost_ship', 'friends_tavern'].includes(meta.type)) return null;
        return {
            n: meta.name || '',
            w: parseInt(meta.components?.AllAge?.placement?.size?.x || meta.width || 1),
            h: parseInt(meta.components?.AllAge?.placement?.size?.y || meta.length || 1),
            t: type,
            s: RebuildGuide.StreetLevel(meta, type)
        };
    },


    Occupancy: () => {
        const tiles = new Map();
        const cityMap = (typeof MainParser !== 'undefined' && MainParser.CityMapData) || {};

        const add = (id, inst, px, py, placed) => {
            const assetId = inst.cityentity_id || inst.entityId;
            const m = RebuildGuide.Meta(assetId, inst.type);
            if (!m) return;
            const rec = { id: id, a: assetId, t: m.t, x: px, y: py, w: m.w, h: m.h, n: m.n, s: m.s, placed: !!placed };
            for (let i = 0; i < m.w; i++) {
                for (let j = 0; j < m.h; j++) tiles.set((px + i) + ',' + (py + j), rec);
            }
        };

        // The draft only holds the buildings touched in reconstruction mode -
        // everything else still stands where the city map has it. Reading the
        // draft alone made every untouched building invisible, and its tiles
        // were offered as free spots. So: the city first, the draft on top
        // (a draft entry without a position is a building put away).
        const draft = RebuildGuide.Draft || {};
        for (const [id, inst] of Object.entries(cityMap)) {
            if (!inst) continue;
            const d = draft[id];
            if (d) {
                if (!d.position) continue;
                // the game leaves out a coordinate that is zero
                add(id, inst, parseInt(d.position.x) || 0, parseInt(d.position.y) || 0, true);
                continue;
            }
            const rx = inst.x !== undefined ? inst.x : inst.coords?.x;
            const ry = inst.y !== undefined ? inst.y : inst.coords?.y;
            if (rx === undefined && ry === undefined) continue;
            add(id, inst, parseInt(rx) || 0, parseInt(ry) || 0);
        }

        return tiles;
    },


    /**
     * Whether what stands on a tile is something the plan can live with there.
     *
     * A spot is a footprint with a road next to it, not a named building: any
     * building of the same size fits, as long as it does not need more road than
     * the spot was planned for. A roadless building may take a spot with a road
     * - it wastes the connection, nothing more - but a building that needs one
     * cannot take a spot planned without it, because there is no road to touch.
     *
     * @param {Object} rec - the entity standing there
     * @param {Object} step - the plan item
     * @returns {boolean}
     */
    Fits: (rec, step) => rec.w === step.w && rec.h === step.h && (
        step.t === 'street'
            ? rec.t === 'street'
            : (rec.t !== 'street' && (rec.s || 0) <= (step.s || 0))
    ),


    /**
     * How much road a building leaves unused on a spot: a roadless building on
     * a spot planned with a road. It fits, but it takes the spot from a
     * building that needs the road - so every choice of spot prefers zero.
     *
     * @param {Object} rec - the building
     * @param {Object} step - the plan item
     * @returns {number}
     */
    RoadWaste: (rec, step) => Math.max(0, (step.s || 0) - (rec.s || 0)),


    /**
     * Spots the looked-up building could have, held by a building that needs
     * less road than the spot gives - typically a roadless building on a spot
     * at the road. Moving that one out is the only way left to place a
     * building that needs the road once every free spot of its size is gone.
     *
     * @returns {Array<Object>} plan steps, each with .blocker set
     */
    SeekReclaim: () => {
        const k = RebuildGuide.Seek;
        if (!k || !(k.s > 0)) return [];
        return RebuildGuide.Steps.filter(s => s.stolen && s.blocker && RebuildGuide.Fits(k, s));
    },


    /**
     * Marks every step done / blocked / still to do against the current city,
     * and moves the guide on to the first band that has work left.
     */
    Evaluate: () => {
        const tiles = RebuildGuide.Occupancy();

        for (const s of RebuildGuide.Steps) {
            s.state = 'todo';
            s.blocker = null;
            s.swap = null;
            s.occ = null;
            s.stolen = false;

            const at = tiles.get(s.x + ',' + s.y);
            // a spot at a road is reserved for a building that needs the road:
            // a roadless one fits the footprint, but standing there it leaves a
            // building that needs the road without a place - so it is not done,
            // it is in the way, and shown in red like anything else in the way
            if (at && at.x === s.x && at.y === s.y && RebuildGuide.Fits(at, s) && RebuildGuide.RoadWaste(at, s) > 0) {
                s.state = 'blocked';
                s.blocker = at;
                s.stolen = true;
                continue;
            }
            if (at && at.x === s.x && at.y === s.y && RebuildGuide.Fits(at, s)) {
                s.state = 'done';
                s.occ = at;
                // a spot filled by a different building of the same size is done,
                // but the player still has to know it happened: the building the
                // plan meant for it now needs one of the other spots
                if (at.a !== s.a && s.t !== 'street') s.swap = at.n;
                continue;
            }

            // anything standing in the way has to be taken down first - naming it
            // is the difference between "place this here" and "why can't I"
            for (let i = 0; i < s.w && !s.blocker; i++) {
                for (let j = 0; j < s.h; j++) {
                    const rec = tiles.get((s.x + i) + ',' + (s.y + j));
                    if (rec) { s.blocker = rec; break; }
                }
            }
            if (s.blocker) s.state = 'blocked';
        }

        RebuildGuide.Misplaced = RebuildGuide.FindMisplaced(tiles);

        if (!RebuildGuide.ManualBand) {
            const first = RebuildGuide.FirstOpenBand();
            if (first !== null) RebuildGuide.Band = first;
        }
    },


    /**
     * Buildings the player put down in reconstruction mode that stand on no
     * spot of the plan - a tile off, crooked across two spots, or a roadless
     * one on a spot at a road - each paired with the nearest open spot it
     * fits. Only what was moved counts: the untouched city is not wrong, it
     * is simply not rebuilt yet.
     *
     * @param {Map<string, Object>} tiles - Occupancy()
     * @returns {Array<{rec: Object, target: Object|null}>}
     */
    FindMisplaced: (tiles) => {
        const seen = new Set(), out = [];
        for (const rec of tiles.values()) {
            if (seen.has(rec) || !rec.placed || rec.t === 'street') continue;
            seen.add(rec);
            const onSpot = RebuildGuide.Steps.some(st => st.x === rec.x && st.y === rec.y
                && RebuildGuide.Fits(rec, st) && RebuildGuide.RoadWaste(rec, st) === 0);
            if (!onSpot) out.push({ rec: rec, target: null });
        }
        if (!out.length) return out;

        // the nearest open spot it fits - a spot it covers itself counts as open
        const taken = new Set();
        for (const m of out) {
            const r = m.rec;
            const open = RebuildGuide.Steps.filter(st => st.t !== 'street' && !taken.has(st)
                && (st.state === 'todo' || (st.state === 'blocked' && st.blocker && st.blocker.id === r.id))
                && RebuildGuide.Fits(r, st));
            const own = open.filter(st => RebuildGuide.RoadWaste(r, st) === 0);
            const pool = own.length ? own : open;
            let best = null, bestD = Infinity;
            for (const st of pool) {
                const d = Math.abs(st.x - r.x) + Math.abs(st.y - r.y);
                if (d < bestD) { best = st; bestD = d; }
            }
            if (best) taken.add(best);
            m.target = best;
        }
        return out;
    },


    /**
     * Crooked buildings on a map: the building where it lies in red, the spot
     * it belongs on in green, a line from one to the other.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} u - pixels per tile
     */
    PaintMisplaced: (ctx, u) => {
        for (const m of RebuildGuide.Misplaced) {
            const r = m.rec, t = m.target;
            if (t) {
                ctx.fillStyle = 'rgba(70, 235, 70, 0.35)';
                ctx.fillRect(t.x * u, t.y * u, t.w * u, t.h * u);
                ctx.lineWidth = Math.max(2, Math.round(u / 4));
                ctx.strokeStyle = '#46eb46';
                ctx.strokeRect(t.x * u, t.y * u, t.w * u, t.h * u);
            }
            ctx.fillStyle = 'rgba(255, 42, 42, 0.55)';
            ctx.fillRect(r.x * u, r.y * u, r.w * u, r.h * u);
            ctx.lineWidth = Math.max(2, Math.round(u / 4));
            ctx.strokeStyle = '#ff2a2a';
            ctx.strokeRect(r.x * u, r.y * u, r.w * u, r.h * u);
            if (t) {
                ctx.beginPath();
                ctx.moveTo((r.x + r.w / 2) * u, (r.y + r.h / 2) * u);
                ctx.lineTo((t.x + t.w / 2) * u, (t.y + t.h / 2) * u);
                ctx.lineWidth = Math.max(1.5, u / 6);
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
            }
        }
    },


    /**
     * The building on top of each tab of the game's reconstruction menu, and
     * the spot it belongs on. The game says nothing when a building is lifted,
     * but the size list already mirrors the menu's order (`reconstruction.pages`,
     * newest stored first) - and the top of a tab is what the player takes.
     *
     * @returns {Array<Object>|null} [{page, n, w, h, spot}], null when the size list is off
     */
    TopOfList: () => {
        if (typeof reconstruction === 'undefined' || !reconstruction.pages) return null;

        const open = RebuildGuide.Steps.filter(s => s.state !== 'done' && s.t !== 'street');
        const taken = new Set();
        const out = [];
        for (const page of ['prod', 'happ', 'greatbuilding']) {
            const id = (reconstruction.pages[page] || [])[0];
            if (!id) continue;
            const asset = id.split('#')[0];
            const m = RebuildGuide.Meta(asset);
            if (!m || m.t === 'street') continue;
            const rec = { a: asset, t: m.t, w: m.w, h: m.h, s: m.s };
            // two tabs can top out with the same footprint - each gets its own spot
            const fit = open.filter(s => !taken.has(s) && RebuildGuide.Fits(rec, s));
            // the spot with the road level it needs before one with a road to spare
            const waste = Math.min(...fit.map(s => RebuildGuide.RoadWaste(rec, s)), 99);
            const best = fit.filter(s => RebuildGuide.RoadWaste(rec, s) === waste);
            fit.splice(0, fit.length, ...best);
            const spot = fit.find(s => s.band === RebuildGuide.Band && s.state === 'todo')
                || fit.find(s => s.state === 'todo')
                || fit[0]
                || null;
            if (spot) taken.add(spot);
            out.push({ page: page, a: asset, n: m.n, w: m.w, h: m.h, spot: spot });
        }
        return out;
    },


    /**
     * Squares around the spots of the buildings on top of the game's list: a
     * thick outline in a colour no stripe state uses, half a tile wider than
     * the spot so a 1x1 still shows.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} u - pixels per tile
     */
    PaintTop: (ctx, u) => {
        const top = RebuildGuide.TopOfList();
        if (!top) return;
        const pad = Math.max(3, Math.round(u * 0.5));
        for (const t of top) {
            const s = t.spot;
            if (!s) continue;
            const bx = s.x * u, by = s.y * u, bw = s.w * u, bh = s.h * u;
            ctx.fillStyle = 'rgba(64, 200, 255, 0.45)';
            ctx.fillRect(bx, by, bw, bh);
            ctx.lineWidth = Math.max(2, Math.round(u / 4));
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.strokeRect(bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad);
            ctx.lineWidth = Math.max(1.5, Math.round(u / 6));
            ctx.strokeStyle = '#40c8ff';
            ctx.strokeRect(bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad);
        }
    },


    /**
     * Every building the player can pick up in reconstruction mode, once per
     * name and size, for the suggestions of the search box. Read from the city,
     * not from the plan: a building without a spot in the plan is lifted just
     * the same, and the answer for it is "no spot".
     *
     * @returns {Array<Object>} [{key, a, n, w, h, s, t}] sorted by name
     */
    SeekOptions: () => {
        const seen = new Map();
        const cityMap = (typeof MainParser !== 'undefined' && MainParser.CityMapData) || {};
        for (const inst of Object.values(cityMap)) {
            if (!inst) continue;
            const a = inst.cityentity_id || inst.entityId;
            const m = RebuildGuide.Meta(a, inst.type);
            if (!m || m.t === 'street' || !m.n) continue;
            const key = m.n + ' (' + m.h + '×' + m.w + ')';
            if (!seen.has(key)) seen.set(key, { key: key, a: a, n: m.n, w: m.w, h: m.h, s: m.s, t: m.t });
        }
        return [...seen.values()].sort((x, y) => x.n.localeCompare(y.n));
    },


    /**
     * The open spots of the plan the looked-up building fits, best first: the
     * current band, then the guide's order, spots with something still standing
     * on them last - those have to be cleared before they can be used.
     *
     * @returns {Array<Object>} plan steps
     */
    SeekSpots: () => {
        const k = RebuildGuide.Seek;
        if (!k) return [];
        let fit = RebuildGuide.Steps.filter(s => s.state !== 'done' && s.t !== 'street' && RebuildGuide.Fits(k, s));
        // spots at a road are reserved for the buildings that need it
        const own = fit.filter(s => RebuildGuide.RoadWaste(k, s) === 0);
        if (own.length) fit = own;
        // a spot at a road comes last for a building that needs none: taking it
        // leaves a building that needs the road without a place
        const rank = (s) => RebuildGuide.RoadWaste(k, s) * 4 + (s.state === 'blocked' ? 2 : 0) + (s.band === RebuildGuide.Band ? 0 : 1);
        // Steps are already in the guide's order, and the sort is stable
        return fit.slice().sort((x, y) => rank(x) - rank(y));
    },


    /**
     * Looks a building up: remembers it, outlines its spots on the game map and
     * redraws the guide.
     *
     * @param {Object|null} rec - {a, n, w, h, s, t}, null clears the search
     */
    SeekSet: (rec) => {
        RebuildGuide.Seek = rec ? { a: rec.a, n: rec.n, w: rec.w, h: rec.h, s: rec.s || 0, t: rec.t } : null;
        RebuildGuide.MapScroll = null;
        RebuildGuide.MarkSeek();
        RebuildGuide.Render();
        if (typeof CityBuilder !== 'undefined' && $('#city-builder-canvas').length) CityBuilder.Renderer.render();
    },


    /**
     * Same as SeekSet, for a building known only by its asset id - the lines of
     * the guide that name a building pass that on.
     *
     * @param {string} assetId
     */
    SeekAsset: (assetId) => {
        const m = RebuildGuide.Meta(assetId);
        if (!m || m.t === 'street') return;
        RebuildGuide.SeekSet({ a: assetId, n: m.n, w: m.w, h: m.h, s: m.s, t: m.t });
    },


    /**
     * Outlines the spots of the looked-up building on the game map: the first
     * one pulses and gets the arrow, up to seven more are drawn quieter. The
     * map projection needs the engine capture of BuildingMarker, which Firefox
     * does not have - there only the coordinates and the plan map remain.
     */
    MarkSeek: () => {
        if (typeof BuildingMarker === 'undefined' || !BuildingMarker.supported) return;
        // crooked buildings are shown right away, before anything looked up:
        // red where the building lies, green with the arrow where it belongs
        const wrong = [];
        for (const m of RebuildGuide.Misplaced.slice(0, 4)) {
            wrong.push({ x: m.rec.x, y: m.rec.y, width: m.rec.w, length: m.rec.h, arrow: false, kind: 'wrong' });
            if (m.target) wrong.push({ x: m.target.x, y: m.target.y, width: m.target.w, length: m.target.h, arrow: true, kind: 'good' });
        }
        // free spots only, as long as there are any: a spot with a building
        // still on it is no answer to "where can I put this down now"
        const all = RebuildGuide.SeekSpots();
        const free = all.filter(s => s.state !== 'blocked');
        // nothing open at all: the spots a roadless building holds at a road
        const spots = (free.length ? free : (all.length ? all : RebuildGuide.SeekReclaim())).slice(0, 8);
        if (!spots.length && wrong.length) {
            RebuildGuide.SeekMarked = true;
            BuildingMarker.showAreas(wrong);
            return;
        }
        if (!spots.length) {
            if (RebuildGuide.SeekMarked) BuildingMarker.hide();
            RebuildGuide.SeekMarked = false;
            return;
        }
        RebuildGuide.SeekMarked = true;
        BuildingMarker.showAreas(wrong.concat(spots.map((s, i) => ({
            x: s.x, y: s.y, width: s.w, length: s.h,
            arrow: i === 0 && !wrong.length,
            kind: (i === 0 ? '' : 'alt') + (s.state !== 'todo' ? ' blocked' : '')
        }))));
    },


    /**
     * The spots of the looked-up building on the plan map and the overlay, in
     * the same colours as on the game map: red for the first, yellow for the rest.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} u - pixels per tile
     */
    PaintSeek: (ctx, u) => {
        const spots = RebuildGuide.SeekSpots();
        if (!spots.length) return;
        const pad = Math.max(2, Math.round(u * 0.35));
        spots.forEach((s, i) => {
            const bx = s.x * u, by = s.y * u, bw = s.w * u, bh = s.h * u;
            ctx.fillStyle = i === 0 ? 'rgba(255, 42, 42, 0.5)' : 'rgba(255, 200, 61, 0.35)';
            ctx.fillRect(bx, by, bw, bh);
            ctx.lineWidth = Math.max(2, Math.round(u / (i === 0 ? 3 : 5)));
            ctx.strokeStyle = i === 0 ? '#ff2a2a' : '#ffc83d';
            ctx.strokeRect(bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad);
        });
    },


    /**
     * @returns {number|null} the first band that is not finished yet
     */
    FirstOpenBand: () => {
        for (const s of RebuildGuide.Steps) {
            if (s.state === 'done') continue;
            if (s.t === 'street' && !RebuildGuide.ShowRoads()) continue;
            return s.band;
        }
        return null;
    },


    /**
     * @returns {number} number of bands the plan is split into
     */
    BandCount: () => RebuildGuide.Steps.length ? RebuildGuide.Steps[RebuildGuide.Steps.length - 1].band + 1 : 0,


    /**
     * @returns {Array<Object>} the steps of the band on screen
     */
    CurrentSteps: () => RebuildGuide.Steps.filter(s => s.band === RebuildGuide.Band
        && (s.t !== 'street' || RebuildGuide.ShowRoads())),


    /**
     * Counts for the progress line: buildings and road tiles separately, because
     * a road tile is a drag and a building is a decision. Buildings that already
     * stand where the plan wants them count as done from the start - that is
     * usually most of the city, and it is the number that says how big the job
     * really is.
     *
     * @returns {Object} {done, total, roadsDone, roadsTotal}
     */
    Progress: () => {
        let done = 0, total = 0, roadsDone = 0, roadsTotal = 0;
        for (const s of RebuildGuide.Steps) {
            if (s.t === 'street') {
                roadsTotal++;
                if (s.state === 'done') roadsDone++;
            } else {
                total++;
                if (s.state === 'done') done++;
            }
        }
        return { done, total, roadsDone, roadsTotal };
    },


    /**
     * Buildings the city has more of than the plan has spots for. A plan is a
     * snapshot: everything bought, won or unpacked since was never part of it,
     * and finding that out at the last unplaceable building is a wasted evening.
     *
     * @returns {Array<Object>} [{name, count}] worst first
     */
    Extra: () => {
        // per footprint, because that is what a spot is: how many spots offer at
        // least road level k, and how many buildings need at least k. A building
        // needing k fits any spot offering k or more, so the plan holds exactly
        // when no threshold has more buildings than spots.
        const slots = new Map();
        for (const s of RebuildGuide.Steps) {
            if (s.t === 'street') continue;
            const key = s.w + 'x' + s.h;
            if (!slots.has(key)) slots.set(key, [0, 0, 0]);
            const c = slots.get(key);
            for (let k = 0; k <= (s.s || 0) && k < 3; k++) c[k]++;
        }

        const have = new Map();
        const cityMap = (typeof MainParser !== 'undefined' && MainParser.CityMapData) || {};
        for (const inst of Object.values(cityMap)) {
            if (!inst) continue;
            const asset = inst.cityentity_id || inst.entityId;
            // the same exclusions the layout search makes - counting what it
            // never planned for would report every harbour as a problem
            const m = RebuildGuide.Meta(asset, inst.type);
            if (!m || m.t === 'street') continue;
            const key = m.w + 'x' + m.h;
            if (!have.has(key)) have.set(key, [0, 0, 0]);
            const c = have.get(key);
            for (let k = 0; k <= (m.s || 0) && k < 3; k++) c[k]++;
        }

        // reported as footprints, not as names: any building of that size can be
        // the one left over, so naming one of them would point at the wrong door
        const out = [];
        for (const [key, c] of have) {
            const s = slots.get(key) || [0, 0, 0];
            const missing = Math.max(c[0] - s[0], c[1] - s[1], c[2] - s[2]);
            if (missing > 0) out.push({ name: key.replace('x', '×'), count: missing });
        }
        return out.sort((a, b) => b.count - a.count);
    },


    /**
     * Opens the guide box (and brings it up to date if it is already open).
     */
    Open: () => {
        if (!RebuildGuide.Plan && !RebuildGuide.Load()) return;

        HTML.AddCssFile('city-builder');

        if ($('#RebuildGuideBox').length === 0) {
            HTML.Box({
                id: 'RebuildGuideBox',
                title: i18n('Boxes.RebuildGuide.Title'),
                auto_close: true,
                dragdrop: true,
                minimize: true,
                resize: true,
                active_maps: 'main'
            });
        }

        // reopened days later the city has moved on - never show a state that
        // was measured in a previous session
        RebuildGuide.Evaluate();
        RebuildGuide.Render();
        RebuildGuide.AnnotateList();
    },


    /**
     * Lays the plan over the live city. Coordinates in a list answer "which
     * building next" but never "where is that on my screen" - the skewed overlay
     * does, and it is the view the player actually places into.
     *
     * Works without a search: the plan carries every item it needs, so this
     * still comes up days later when nothing but the stored plan is left.
     */
    ShowOnCity: () => {
        if (!RebuildGuide.Plan && !RebuildGuide.Load()) return;
        if (typeof CityBuilder === 'undefined') return;

        HTML.AddCssFile('city-builder');
        if ($('#CityBuilderBox').length === 0) {
            HTML.Box({
                id: 'CityBuilderBox',
                title: i18n('Boxes.CityBuilder.Title'),
                auto_close: true,
                dragdrop: true,
                minimize: true,
                popout: () => CityBuilder.PopOut(),
                resize: true
            });
        }

        if (!RebuildGuide.MatchesShown()) {
            // the plan is one of the variants of the last search whenever there
            // was one - switching to it keeps stats, report and export intact
            const i = (CityBuilder.Variants || []).findIndex(v => v && v.layout
                && RebuildGuide.Signature(v.layout) === RebuildGuide.Plan.sig);
            if (i >= 0) {
                CityBuilder.SelectVariant(i);
            } else {
                // nothing left of the search - draw the plan on its own
                CityBuilder.Data = RebuildGuide.Plan.items.map(it => ({
                    x: it.x, y: it.y, width: it.w, height: it.h,
                    asset_id: it.a, name: it.n, type: it.t,
                    street_level: it.s, level: it.l
                }));
                CityBuilder.Unplaced = [];
                CityBuilder.Stats = null;
            }
        }

        // the view stays the player's choice - "top-down" is a checkbox of its
        // own, switching it behind their back left them with a skewed map
        CityBuilder.showMap();
    },


    /**
     * Recomputes the state against the city and redraws everything that shows
     * it - the guide box, the plan overlay, and the size list of the
     * reconstruction menu.
     */
    Refresh: () => {
        if (!RebuildGuide.Steps.length) return;
        RebuildGuide.Evaluate();
        // a spot just filled is no longer free - the outline moves on to the next
        if (RebuildGuide.Seek || RebuildGuide.Misplaced.length || RebuildGuide.SeekMarked) RebuildGuide.MarkSeek();
        RebuildGuide.Render();
        RebuildGuide.AnnotateList();
        // the plan overlay paints the same states, so it has to follow along
        if (typeof CityBuilder !== 'undefined' && $('#city-builder-canvas').length) CityBuilder.Renderer.render();
    },


    Escape: (t) => String(t == null ? '' : t).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])),


    /**
     * When the plan was handed over, in the player's own date format.
     *
     * @returns {string} empty when the plan carries no timestamp
     */
    PlanAge: () => {
        const t = RebuildGuide.Plan && RebuildGuide.Plan.created;
        if (!t) return '';
        try {
            return typeof moment !== 'undefined' ? moment(t).format('L LT') : new Date(t).toLocaleString();
        } catch (e) {
            return '';
        }
    },


    /**
     * What to call a step in the interface. Road pieces have no name worth
     * printing, buildings carry theirs from the plan.
     *
     * @param {Object} s - plan step
     * @returns {string} escaped label
     */
    Label: (s) => s.t === 'street'
        ? i18n(s.l >= 2 ? 'Boxes.RebuildGuide.RoadTwoLane' : 'Boxes.RebuildGuide.Road')
        : RebuildGuide.Escape(s.n),


    /**
     * The guide box: how far the rebuild has come, which stripe is next, and
     * every spot in that stripe with the building that belongs on it.
     */
    Render: () => {
        if ($('#RebuildGuideBox').length === 0) return;

        if (!RebuildGuide.Plan || !RebuildGuide.Steps.length) {
            $('#RebuildGuideBoxBody').html(`<div class="rg-empty">${i18n('Boxes.RebuildGuide.NoPlan')}</div>`);
            return;
        }

        const p = RebuildGuide.Progress();
        const bands = RebuildGuide.BandCount();
        const steps = RebuildGuide.CurrentSteps();
        const open = steps.filter(s => s.state !== 'done').length;
        const pct = p.total ? Math.round(100 * p.done / p.total) : 0;

        const h = [];

        h.push('<div class="rg-head">');
        h.push(`<div class="rg-plan">${RebuildGuide.Escape(RebuildGuide.Plan.label || i18n('Boxes.RebuildGuide.Title'))}`
            // when the plan was made: after a reload this line is what says the
            // guide is showing the remembered plan and not a fresh, empty one
            + `<span class="rg-age">${RebuildGuide.Escape(RebuildGuide.PlanAge())}</span></div>`);
        h.push('<div class="rg-progress">');
        h.push(`<div class="rg-bar"><div class="rg-bar-fill" style="width:${pct}%"></div></div>`);
        h.push(`<span>${i18n('Boxes.RebuildGuide.Buildings')}: <b>${p.done}</b> / ${p.total}`);
        if (p.roadsTotal) h.push(` &middot; ${i18n('Boxes.RebuildGuide.Roads')}: <b>${p.roadsDone}</b> / ${p.roadsTotal}`);
        h.push('</span>');
        h.push('</div>');
        // what is left to the end, spelled out - the bar alone does not say it
        h.push('<div class="rg-left">');
        h.push(`<span>${i18n('Boxes.RebuildGuide.LeftToEnd')}: <b>${p.total - p.done}</b> ${i18n('Boxes.RebuildGuide.LeftBuildings')}`
            + (p.roadsTotal ? `, <b>${p.roadsTotal - p.roadsDone}</b> ${i18n('Boxes.RebuildGuide.LeftRoads')}` : '') + '</span>');
        h.push(`<label class="rg-compact-toggle" title="${i18n('Boxes.RebuildGuide.CompactHint')}"><input type="checkbox" class="rg-compact"${RebuildGuide.Compact() ? ' checked' : ''}> ${i18n('Boxes.RebuildGuide.CompactView')}</label>`);
        h.push('</div>');
        h.push('</div>');

        // The town hall is the one building the reconstruction mode cannot put
        // away. Whoever stores the whole city first has an empty map with the
        // town hall in it - so it goes to its planned spot before anything else
        const hall = RebuildGuide.Steps.find(st => st.t === 'main_building');
        if (hall && hall.state !== 'done') {
            h.push(`<div class="rg-townhall rg-seekable" data-asset="${RebuildGuide.Escape(hall.a)}" title="${i18n('Boxes.RebuildGuide.SeekClick')}">`);
            h.push(`<div class="rg-townhall-title">${i18n('Boxes.RebuildGuide.TownHallFirst')}`
                + ` <span class="rg-townhall-pos">&rarr; ${hall.x}, ${hall.y}</span></div>`);
            h.push(`<div class="rg-townhall-hint">${i18n('Boxes.RebuildGuide.TownHallHint')}</div>`);
            if (hall.state === 'blocked' && hall.blocker) {
                h.push(`<div class="rg-now-blocked">${i18n('Boxes.RebuildGuide.Blocked')}: <b>${RebuildGuide.Escape(hall.blocker.n)}</b></div>`);
            }
            h.push('</div>');
        }

        // crooked buildings first: they are what to fix before going on
        if (RebuildGuide.Misplaced.length) {
            h.push('<div class="rg-misplaced">');
            h.push(`<div class="rg-misplaced-title">${i18n('Boxes.RebuildGuide.Misplaced')}</div>`);
            for (const m of RebuildGuide.Misplaced.slice(0, 5)) {
                h.push(`<div class="rg-misplaced-line rg-seekable" data-asset="${RebuildGuide.Escape(m.rec.a)}">`
                    + `<b>${RebuildGuide.Escape(m.rec.n)}</b> <span class="rg-mis-at">(${m.rec.x}, ${m.rec.y})</span> `
                    + (m.target
                        ? `&rarr; <span class="rg-mis-to">${m.target.x}, ${m.target.y}</span>`
                        : `<span class="rg-top-none">${i18n('Boxes.RebuildGuide.TopNoSpot')}</span>`)
                    + '</div>');
            }
            if (RebuildGuide.Misplaced.length > 5) h.push(`<div class="rg-seek-more">+${RebuildGuide.Misplaced.length - 5}</div>`);
            h.push('</div>');
        }

        // the plan is picked here as well, not only in the City Builder: its
        // buttons are where a player looks for "which plan does this follow"
        const vrows = RebuildGuide.VariantRows();
        h.push('<details class="rg-variants"' + (RebuildGuide.VariantsOpen ? ' open' : '') + '>');
        h.push(`<summary>${i18n('Boxes.RebuildGuide.Variants')}${vrows.length ? ' (' + vrows.length + ')' : ''}</summary>`);
        if (!vrows.length) {
            h.push(`<div class="rg-variants-none">${i18n('Boxes.RebuildGuide.VariantsNone')}</div>`);
        } else {
            // one compact row per variant: the label on its own line, the numbers
            // under it, the action on the right - as table cells the label was
            // squeezed into a column a word wide
            h.push('<div class="rg-variants-list">');
            for (const r of vrows) {
                const facts = [];
                if (r.moved !== null) facts.push(i18n('Boxes.RebuildGuide.MovedN').replace('__n__', r.moved));
                if (r.shared !== null) facts.push(i18n('Boxes.RebuildGuide.SharedN').replace('__n__', r.shared).replace('__total__', r.count));
                h.push(`<div class="rg-v-row${r.current ? ' rg-v-current' : ''}${r.recommended ? ' rg-v-best' : ''}">`);
                h.push('<div class="rg-v-text">');
                h.push(`<div class="rg-v-label">${r.label}`
                    + (r.recommended ? ` <span class="rg-v-tag">${i18n('Boxes.RebuildGuide.Recommended')}</span>` : '') + '</div>');
                h.push(`<div class="rg-v-facts">${facts.join(' &middot; ')}</div>`);
                h.push('</div>');
                h.push('<div class="rg-v-act">' + (r.current
                    ? `<span class="rg-v-now">${i18n('Boxes.RebuildGuide.CurrentPlan')}</span>`
                    : `<button class="btn btn-slim rg-v-use" data-i="${r.i}">${i18n('Boxes.RebuildGuide.UseVariant')}</button>`) + '</div>');
                h.push('</div>');
            }
            h.push('</div>');
        }
        h.push('</details>');

        const newer = RebuildGuide.NewerShown();
        if (newer) {
            h.push(`<div class="rg-newer"><span>${i18n('Boxes.RebuildGuide.NewerShown')}: <b>${newer}</b></span>`
                + `<button class="btn btn-slim rg-take">${i18n('Boxes.RebuildGuide.TakeShown')}</button></div>`);
        }

        const extra = RebuildGuide.Extra();
        if (extra.length) {
            const total = extra.reduce((a, e) => a + e.count, 0);
            const names = extra.slice(0, 3).map(e => RebuildGuide.Escape(e.name) + (e.count > 1 ? ' &times;' + e.count : '')).join(', ');
            h.push(`<div class="rg-warn">${i18n('Boxes.RebuildGuide.NoSpot')}: <b>${total}</b> &ndash; ${names}`
                + `${extra.length > 3 ? ' &hellip;' : ''}</div>`);
        }

        if (RebuildGuide.OffPlan) {
            h.push(`<div class="rg-warn">${i18n(RebuildGuide.OffPlan.stolen ? 'Boxes.RebuildGuide.OffPlanRoad' : 'Boxes.RebuildGuide.OffPlan')}: `
                + `<b>${RebuildGuide.Escape(RebuildGuide.OffPlan.name)}</b> `
                + `(${RebuildGuide.OffPlan.x}, ${RebuildGuide.OffPlan.y})</div>`);
        }

        h.push('<div class="rg-bandbar">');
        h.push(`<button class="btn btn-slim rg-prev"${RebuildGuide.Band <= 0 ? ' disabled' : ''}>&lsaquo;</button>`);
        h.push(`<span class="rg-bandno">${i18n('Boxes.RebuildGuide.Band')} <b>${RebuildGuide.Band + 1}</b> / ${bands}</span>`);
        h.push(`<button class="btn btn-slim rg-next"${RebuildGuide.Band >= bands - 1 ? ' disabled' : ''}>&rsaquo;</button>`);
        h.push(`<button class="btn btn-slim rg-jump" title="${i18n('Boxes.RebuildGuide.JumpHint')}">${i18n('Boxes.RebuildGuide.Jump')}</button>`);
        h.push(`<button class="btn btn-slim rg-oncity" title="${i18n('Boxes.RebuildGuide.OnCityHint')}">${i18n('Boxes.RebuildGuide.OnCity')}</button>`);
        h.push(`<span class="rg-open">${open ? open + ' ' + i18n('Boxes.RebuildGuide.Left') : i18n('Boxes.RebuildGuide.BandDone')}</span>`);
        h.push('</div>');

        // "where does this one go?": the game says nothing when a building is
        // picked up, so the player names it - typed with suggestions, or by
        // clicking a building the guide shows - and its spots get outlined
        const seek = RebuildGuide.Seek;
        h.push('<div class="rg-seek">');
        h.push(`<label class="rg-seek-label" for="rg-seek-input">${i18n('Boxes.RebuildGuide.Seek')}</label>`);
        h.push(`<input type="text" id="rg-seek-input" class="rg-seek-input" list="rg-seek-list" autocomplete="off"`
            + ` placeholder="${RebuildGuide.Escape(i18n('Boxes.RebuildGuide.SeekPlaceholder'))}"`
            + ` value="${seek ? RebuildGuide.Escape(seek.n + ' (' + seek.h + '×' + seek.w + ')') : ''}">`);
        h.push('<datalist id="rg-seek-list">');
        for (const o of RebuildGuide.SeekOptions()) h.push(`<option value="${RebuildGuide.Escape(o.key)}"></option>`);
        h.push('</datalist>');
        if (seek) h.push(`<button class="btn btn-slim rg-seek-clear" title="${i18n('Boxes.RebuildGuide.SeekClear')}">&times;</button>`);
        h.push('</div>');
        if (seek) {
            const spots = RebuildGuide.SeekSpots();
            if (!spots.length) {
                const reclaim = RebuildGuide.SeekReclaim();
                h.push('<div class="rg-seek-result rg-seek-none">');
                h.push(`<div>${i18n('Boxes.RebuildGuide.SeekNone')}</div>`);
                if (reclaim.length) {
                    h.push(`<div class="rg-seek-reclaim-title">${i18n('Boxes.RebuildGuide.SeekReclaim')}</div>`);
                    for (const r of reclaim.slice(0, 5)) {
                        h.push(`<div class="rg-seek-reclaim">&rarr; <b>${r.x}, ${r.y}</b>: ${i18n('Boxes.RebuildGuide.SeekReclaimLine')
                            .replace('__name__', '<b>' + RebuildGuide.Escape(r.blocker.n) + '</b>')}</div>`);
                    }
                    if (reclaim.length > 5) h.push(`<div class="rg-seek-more">+${reclaim.length - 5}</div>`);
                }
                h.push('</div>');
            } else {
                const first = spots[0];
                h.push('<div class="rg-seek-result">');
                h.push(`<span class="rg-seek-pos">&rarr; ${first.x}, ${first.y}</span>`);
                if (first.state === 'blocked' && first.blocker) {
                    h.push(` <span class="rg-seek-blocked">${i18n(first.stolen ? 'Boxes.RebuildGuide.Stolen' : 'Boxes.RebuildGuide.Blocked')}: <b>${RebuildGuide.Escape(first.blocker.n)}</b></span>`);
                }
                if (spots.length > 1) {
                    h.push(` <span class="rg-seek-more">${i18n('Boxes.RebuildGuide.SeekMore').replace('__n__', spots.length - 1)}</span>`);
                }
                h.push(`<div class="rg-seek-count">${i18n('Boxes.RebuildGuide.SeekCount').replace('__n__', spots.length)}</div>`);
                if (typeof BuildingMarker === 'undefined' || !BuildingMarker.supported) {
                    h.push(`<div class="rg-seek-nomark">${i18n('Boxes.RebuildGuide.SeekNoMarker')}</div>`);
                }
                h.push('</div>');
            }
        }

        // the one building to pick up now, spelled out: a number on the map
        // says where, it never says what to carry there
        const next = (hall && hall.state !== 'done') ? hall : steps.find(s => s.state !== 'done');
        if (next) {
            h.push(next.t === 'street'
                ? '<div class="rg-now">'
                : `<div class="rg-now rg-seekable" data-asset="${RebuildGuide.Escape(next.a)}" title="${i18n('Boxes.RebuildGuide.SeekClick')}">`);
            h.push(`<span class="rg-now-no">1</span>`);
            h.push(`<span class="rg-now-size">${next.h}&times;${next.w}</span>`);
            h.push(`<span class="rg-now-name">${RebuildGuide.Label(next)}</span>`);
            h.push(`<span class="rg-now-pos">${next.x}, ${next.y}</span>`);
            h.push('</div>');
            if (next.state === 'blocked' && next.blocker) {
                h.push(`<div class="rg-now-blocked">${i18n(next.stolen ? 'Boxes.RebuildGuide.Stolen' : 'Boxes.RebuildGuide.Blocked')}: `
                    + `<b>${RebuildGuide.Escape(next.blocker.n)}</b></div>`);
            }
        }

        // what the game's menu offers right now, and where each of those goes -
        // the same blue as their squares on the map
        const top = RebuildGuide.TopOfList();
        if (top === null) {
            h.push(`<div class="rg-top-off">${i18n('Boxes.RebuildGuide.TopOfListOff')}</div>`);
        } else if (top.length) {
            h.push('<div class="rg-top">');
            h.push(`<div class="rg-top-title">${i18n('Boxes.RebuildGuide.TopOfList')}</div>`);
            for (const t of top) {
                const icon = reconstruction.rcIcons && reconstruction.rcIcons[t.page];
                h.push(`<div class="rg-top-line rg-seekable" data-asset="${RebuildGuide.Escape(t.a)}" title="${i18n('Boxes.RebuildGuide.SeekClick')}">`);
                if (icon) h.push(`<img class="rg-top-icon" src="${icon}" alt="">`);
                h.push(`<span class="rg-now-size">${t.h}&times;${t.w}</span>`);
                h.push(`<span class="rg-now-name">${RebuildGuide.Escape(t.n)}</span>`);
                h.push(t.spot
                    ? `<span class="rg-top-pos">&rarr; ${t.spot.x}, ${t.spot.y}</span>`
                    : `<span class="rg-top-none">${i18n('Boxes.RebuildGuide.TopNoSpot')}</span>`);
                h.push('</div>');
            }
            h.push('</div>');
        }

        // the list before the map: it is the part that says what to place, and
        // a full-height map used to push it out of the box entirely
        h.push('<div class="rg-steps-wrap"><table class="foe-table rg-steps"><tbody>');
        let no = 0;
        for (const s of steps) {
            if (s.state !== 'done') no++;
            const cls = 'rg-' + s.state + (s === next ? ' rg-current' : '');
            h.push(`<tr class="${cls}">`);
            h.push(`<td class="rg-no">${s.state === 'done' ? '&#10003;' : no}</td>`);
            h.push(`<td class="rg-size">${s.h}&times;${s.w}</td>`);
            // same tooltip wiring as the list of unplaced buildings, so a step
            // shows what the building actually is
            h.push(s.t === 'street'
                ? `<td class="rg-name">${RebuildGuide.Label(s)}</td>`
                : `<td class="rg-name fh-tooltip" data-callback_tt="Tooltips.buildingTT" data-meta_id="${RebuildGuide.Escape(s.a)}">${RebuildGuide.Label(s)}</td>`);
            h.push(`<td class="rg-pos">${s.x}, ${s.y}</td>`);
            h.push(`<td class="rg-state">${s.state === 'blocked' && s.blocker
                ? (s.stolen ? i18n('Boxes.RebuildGuide.Stolen') : i18n('Boxes.RebuildGuide.Blocked')) + ': ' + RebuildGuide.Escape(s.blocker.n)
                : (s.swap ? '<span class="rg-swap">' + RebuildGuide.Escape(s.swap) + '</span>' : '')}</td>`);
            h.push('</tr>');
        }
        h.push('</tbody></table></div>');

        // the map keeps its natural size and the frame scrolls: stretched to the
        // width of the box a 4x4 building was drawn as a rectangle, and the zoom
        // did nothing at all because the picture was scaled back to fit anyway
        h.push('<div class="rg-mapwrap"><canvas class="rg-map"></canvas></div>');
        h.push('<div class="rg-read"></div>');

        h.push('<div class="rg-foot">');
        h.push(`<label>${i18n('Boxes.RebuildGuide.Order')}: <select class="rg-order">`);
        h.push(`<option value="screen"${RebuildGuide.Order() === 'screen' ? ' selected' : ''}>${i18n('Boxes.RebuildGuide.OrderScreen')}</option>`);
        h.push(`<option value="rows"${RebuildGuide.Order() === 'rows' ? ' selected' : ''}>${i18n('Boxes.RebuildGuide.OrderRows')}</option>`);
        h.push('</select></label>');
        h.push(`<label>${i18n('Boxes.RebuildGuide.BandWidth')}: <input type="number" class="rg-bandsize" min="1" max="20" value="${RebuildGuide.BandSize()}"></label>`);
        h.push(`<label><input type="checkbox" class="rg-roads"${RebuildGuide.ShowRoads() ? ' checked' : ''}> ${i18n('Boxes.RebuildGuide.Roads')}</label>`);
        h.push(`<label title="${i18n('Boxes.RebuildGuide.OverlayHint')}"><input type="checkbox" class="rg-overlay"${localStorage.getItem('RebuildGuideOverlay') === '0' ? '' : ' checked'}> ${i18n('Boxes.RebuildGuide.Overlay')}</label>`);
        h.push(`<label>${i18n('Boxes.CityBuilder.Zoom')}: <input type="range" class="rg-scale" min="4" max="36" value="${RebuildGuide.Scale()}"></label>`);
        h.push(`<button class="btn btn-slim rg-drop">${i18n('Boxes.RebuildGuide.Drop')}</button>`);
        h.push('</div>');

        h.push(`<div class="rg-hint">${i18n('Boxes.RebuildGuide.Hint')}</div>`);

        $('#RebuildGuideBoxBody').toggleClass('rg-compact-mode', RebuildGuide.Compact())
            .html(h.join('')).promise().done(function () {
            RebuildGuide.DrawMap();

            // hovering a rectangle says which building it is - a number alone is
            // a position without an answer. Written into a line of its own under
            // the map, not only into the native tooltip: that one needs the mouse
            // to rest, and rewriting it while the mouse moves keeps it hidden
            const map = $('#RebuildGuideBoxBody .rg-map')[0];
            const read = $('#RebuildGuideBoxBody .rg-read')[0];
            if (map) {
                map.addEventListener('mousemove', (e) => {
                    const hit = RebuildGuide.HoverAt(map, e);
                    const text = hit ? RebuildGuide.HoverText(hit) : '';
                    if (map.title !== text) map.title = text;
                    if (read) read.textContent = text;
                });
                map.addEventListener('mouseleave', () => { if (read) read.textContent = ''; });

                // grab and drag the plan like the game map - the scrollbars
                // alone were the only way to move it, and fiddly at that
                const wrap = map.parentElement;
                let drag = null;
                wrap.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    drag = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop };
                    wrap.classList.add('rg-dragging');
                    e.preventDefault();
                });
                const move = (e) => {
                    if (!drag) return;
                    wrap.scrollLeft = drag.l - (e.clientX - drag.x);
                    wrap.scrollTop = drag.t - (e.clientY - drag.y);
                    RebuildGuide.MapScroll = { l: wrap.scrollLeft, t: wrap.scrollTop };
                };
                const end = () => {
                    if (!drag) return;
                    drag = null;
                    wrap.classList.remove('rg-dragging');
                };
                // on the document: a drag that leaves the map keeps going
                const doc = wrap.ownerDocument;
                doc.addEventListener('mousemove', move);
                doc.addEventListener('mouseup', end);
                // the box is redrawn often - drop the listeners of the old map
                const gone = setInterval(() => {
                    if (wrap.isConnected) return;
                    clearInterval(gone);
                    doc.removeEventListener('mousemove', move);
                    doc.removeEventListener('mouseup', end);
                }, 2000);

                // wheel zooms around the cursor, the tile under it stays put
                wrap.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    const old = RebuildGuide.Scale();
                    const next = Math.max(4, Math.min(36, old + (e.deltaY < 0 ? 2 : -2)));
                    if (next === old) return;
                    const r = wrap.getBoundingClientRect();
                    const mx = e.clientX - r.left, my = e.clientY - r.top;
                    const tx = (wrap.scrollLeft + mx) / old, ty = (wrap.scrollTop + my) / old;
                    localStorage.setItem('RebuildGuideScale', next);
                    $('#RebuildGuideBoxBody .rg-scale').val(next);
                    RebuildGuide.MapScroll = { l: tx * next - mx, t: ty * next - my };
                    RebuildGuide.DrawMap();
                    RebuildGuide.MapScroll = { l: wrap.scrollLeft, t: wrap.scrollTop };
                }, { passive: false });
            }

            // a suggestion picked from the list arrives as an input event with
            // the full text - typing by hand counts once it names one building
            $('#RebuildGuideBoxBody .rg-seek-input').on('input change', function () {
                const v = String($(this).val() || '').trim();
                const opts = RebuildGuide.SeekOptions();
                let hit = opts.find(o => o.key === v) || null;
                if (!hit && v.length >= 3) {
                    const low = v.toLowerCase();
                    const named = opts.filter(o => o.n.toLowerCase() === low);
                    if (named.length === 1) hit = named[0];
                }
                const cur = RebuildGuide.Seek;
                if (hit && (!cur || cur.a !== hit.a || cur.w !== hit.w || cur.h !== hit.h)) {
                    RebuildGuide.SeekSet(hit);
                }
            }).on('keydown', function (e) {
                if (e.key === 'Escape') RebuildGuide.SeekSet(null);
            });
            $('#RebuildGuideBoxBody .rg-seek-clear').on('click', () => RebuildGuide.SeekSet(null));
            $('#RebuildGuideBoxBody .rg-compact').on('change', function () {
                localStorage.setItem('RebuildGuideCompact', this.checked ? '1' : '0');
                RebuildGuide.Render();
            });
            $('#RebuildGuideBoxBody .rg-seekable').on('click', function () {
                RebuildGuide.SeekAsset(String($(this).attr('data-asset')));
            });

            $('#RebuildGuideBoxBody .rg-prev').on('click', () => RebuildGuide.GoTo(RebuildGuide.Band - 1));
            $('#RebuildGuideBoxBody .rg-next').on('click', () => RebuildGuide.GoTo(RebuildGuide.Band + 1));
            $('#RebuildGuideBoxBody .rg-jump').on('click', () => {
                RebuildGuide.ManualBand = false;
                const first = RebuildGuide.FirstOpenBand();
                if (first !== null) RebuildGuide.Band = first;
                RebuildGuide.Render();
            });
            $('#RebuildGuideBoxBody .rg-oncity').on('click', () => RebuildGuide.ShowOnCity());
            $('#RebuildGuideBoxBody .rg-drop').on('click', () => RebuildGuide.Drop());
            $('#RebuildGuideBoxBody .rg-take').on('click', () => RebuildGuide.UsePlan());
            $('#RebuildGuideBoxBody .rg-variants').on('toggle', function () {
                RebuildGuide.VariantsOpen = this.open;
            });
            $('#RebuildGuideBoxBody .rg-v-use').on('click', function () {
                RebuildGuide.UseVariant(parseInt($(this).attr('data-i')));
            });

            $('#RebuildGuideBoxBody .rg-order').on('change', function () {
                localStorage.setItem('RebuildGuideOrder', $(this).val());
                RebuildGuide.ManualBand = false;
                RebuildGuide.Prepare();
                RebuildGuide.Render();
                if (typeof CityBuilder !== 'undefined' && $('#city-builder-canvas').length) CityBuilder.Renderer.render();
            });
            $('#RebuildGuideBoxBody .rg-bandsize').on('change', function () {
                localStorage.setItem('RebuildGuideBand', parseInt($(this).val()) || 4);
                RebuildGuide.ManualBand = false;
                RebuildGuide.Prepare();
                RebuildGuide.Render();
                if (typeof CityBuilder !== 'undefined' && $('#city-builder-canvas').length) CityBuilder.Renderer.render();
            });
            $('#RebuildGuideBoxBody .rg-roads').on('change', function () {
                localStorage.setItem('RebuildGuideRoads', $(this).is(':checked') ? '1' : '0');
                RebuildGuide.Render();
            });
            $('#RebuildGuideBoxBody .rg-overlay').on('change', function () {
                localStorage.setItem('RebuildGuideOverlay', $(this).is(':checked') ? '1' : '0');
                if (typeof CityBuilder !== 'undefined' && $('#city-builder-canvas').length) CityBuilder.Renderer.render();
            });
            $('#RebuildGuideBoxBody .rg-scale').on('input', function () {
                localStorage.setItem('RebuildGuideScale', parseInt($(this).val()) || 10);
                RebuildGuide.DrawMap();
            });
        });
    },


    /**
     * Pages to another band by hand. From then on the guide stays where it was
     * put until the player asks for the next open one again.
     *
     * @param {number} band
     */
    GoTo: (band) => {
        const bands = RebuildGuide.BandCount();
        RebuildGuide.Band = Math.max(0, Math.min(bands - 1, band));
        RebuildGuide.ManualBand = true;
        RebuildGuide.MapScroll = null;
        RebuildGuide.Render();
    },


    /**
     * Top-down picture of the plan: what stands already, what is next, and what
     * is still waiting. Top-down and not skewed on purpose - it is a map to read
     * next to the game, the overlay on the live city is the other view.
     */
    DrawMap: () => {
        const canvas = $('#RebuildGuideBoxBody .rg-map')[0];
        if (!canvas || !RebuildGuide.Steps.length) return;

        const u = RebuildGuide.Scale();
        let maxX = 0, maxY = 0, minX = 999, minY = 999;
        let areas = [];
        try {
            if (typeof CityMap !== 'undefined' && CityMap.Main && CityMap.Main.unlockedAreas) areas = CityMap.Main.unlockedAreas;
        } catch (e) { areas = []; }

        for (const a of areas) {
            maxX = Math.max(maxX, (parseInt(a.x) || 0) + parseInt(a.width || 16));
            maxY = Math.max(maxY, (parseInt(a.y) || 0) + parseInt(a.length || a.height || 16));
            minX = Math.min(minX, parseInt(a.x) || 0);
            minY = Math.min(minY, parseInt(a.y) || 0);
        }
        for (const s of RebuildGuide.Steps) {
            maxX = Math.max(maxX, s.x + s.w);
            maxY = Math.max(maxY, s.y + s.h);
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
        }
        if (minX > maxX) { minX = 0; minY = 0; }

        const w = (maxX - minX) * u, h = (maxY - minY) * u;
        canvas.width = w;
        canvas.height = h;
        // kept for the hover readout: the canvas is scaled down by CSS, so a
        // mouse position has to be translated back through both the fit and the
        // origin the drawing was shifted by
        RebuildGuide.MapView = { minX, minY, u };
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.translate(-minX * u, -minY * u);

        ctx.fillStyle = '#2c3e36';
        for (const a of areas) {
            ctx.fillRect((parseInt(a.x) || 0) * u, (parseInt(a.y) || 0) * u,
                parseInt(a.width || 16) * u, parseInt(a.length || a.height || 16) * u);
        }

        // the stripe being worked on, shaded across the whole map so its
        // direction is visible - diagonal in the game view, straight in row mode
        const size = RebuildGuide.BandSize();
        const rows = RebuildGuide.Order() === 'rows';
        const base = RebuildGuide.Depth(RebuildGuide.Steps[0]);
        const lo = base + RebuildGuide.Band * size, hi = lo + size;
        ctx.fillStyle = 'rgba(255, 214, 102, 0.13)';
        for (let x = minX; x < maxX; x++) {
            for (let y = minY; y < maxY; y++) {
                const d = rows ? y : x + y;
                if (d >= lo && d < hi) ctx.fillRect(x * u, y * u, u, u);
            }
        }

        let no = 0;
        for (const s of RebuildGuide.Steps) {
            if (s.t === 'street' && !RebuildGuide.ShowRoads()) continue;
            const cur = s.band === RebuildGuide.Band;
            const bx = s.x * u, by = s.y * u, bw = s.w * u, bh = s.h * u;

            if (s.state === 'done') ctx.fillStyle = s.t === 'street' ? 'rgba(60, 90, 70, 0.85)' : 'rgba(93, 173, 116, 0.85)';
            // a road spot taken by a roadless building is red in every band
            else if (s.stolen || (cur && s.state === 'blocked')) ctx.fillStyle = 'rgba(214, 84, 84, 0.9)';
            else if (cur) ctx.fillStyle = 'rgba(255, 196, 61, 0.95)';
            else ctx.fillStyle = s.t === 'street' ? 'rgba(120, 120, 120, 0.25)' : 'rgba(200, 200, 200, 0.22)';
            ctx.fillRect(bx, by, bw, bh);

            ctx.strokeStyle = cur ? 'rgba(0, 0, 0, 0.65)' : 'rgba(0, 0, 0, 0.3)';
            ctx.lineWidth = cur ? 1.5 : 1;
            ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);

            // the order inside the stripe, written into the spot itself - with
            // the footprint under it wherever it fits, because the reconstruction
            // menu is sorted by size and that is what the player picks by
            if (cur && s.state !== 'done') {
                no++;
                if (bw >= 14 && bh >= 12) {
                    ctx.fillStyle = '#20160a';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    const room = bh >= 26 && bw >= 26 && s.t !== 'street';
                    ctx.font = 'bold ' + Math.min(12, Math.floor(bh * (room ? 0.4 : 0.7))) + 'px sans-serif';
                    ctx.fillText(String(no), bx + bw / 2, by + bh / 2 - (room ? bh * 0.16 : 0));
                    if (room) {
                        ctx.font = Math.min(10, Math.floor(bh * 0.28)) + 'px sans-serif';
                        ctx.fillText(s.h + '×' + s.w, bx + bw / 2, by + bh / 2 + bh * 0.22);
                    }
                }
            }
        }

        RebuildGuide.PaintTop(ctx, u);
        RebuildGuide.PaintSeek(ctx, u);
        RebuildGuide.PaintMisplaced(ctx, u);
        const wrap = canvas.parentElement;
        if (RebuildGuide.MapScroll && wrap) {
            wrap.scrollLeft = RebuildGuide.MapScroll.l;
            wrap.scrollTop = RebuildGuide.MapScroll.t;
        } else {
            RebuildGuide.ScrollToStep(canvas);
        }
    },


    /**
     * Brings the spot to fill next into view. Zoomed in, the map is bigger than
     * its frame - a plan you have to hunt for on a scrollbar is no better than
     * no plan. Only scrolls when the target is actually off screen, so it does
     * not yank the view away after every placement.
     *
     * @param {HTMLCanvasElement} canvas
     */
    ScrollToStep: (canvas) => {
        const wrap = canvas.parentElement;
        const view = RebuildGuide.MapView;
        if (!wrap || !view || !wrap.clientWidth) return;

        // a looked-up building wins: its spot is what the player is after
        const sought = RebuildGuide.Seek ? RebuildGuide.SeekSpots()[0] : null;
        const s = sought || RebuildGuide.Steps.find(o => o.band === RebuildGuide.Band && o.state !== 'done'
            && (o.t !== 'street' || RebuildGuide.ShowRoads()));
        if (!s) return;

        const x = (s.x - view.minX) * view.u, y = (s.y - view.minY) * view.u;
        const w = s.w * view.u, h = s.h * view.u;
        const visible = x >= wrap.scrollLeft && x + w <= wrap.scrollLeft + wrap.clientWidth
            && y >= wrap.scrollTop && y + h <= wrap.scrollTop + wrap.clientHeight;
        if (visible) return;

        wrap.scrollLeft = Math.max(0, x + w / 2 - wrap.clientWidth / 2);
        wrap.scrollTop = Math.max(0, y + h / 2 - wrap.clientHeight / 2);
    },


    /**
     * The plan step under the mouse. Reading a plan off numbered rectangles only
     * works if the numbers can be asked what they stand for.
     *
     * @param {HTMLCanvasElement} canvas
     * @param {MouseEvent} e
     * @returns {Object|null} the step, or null on open ground
     */
    HoverAt: (canvas, e) => {
        const view = RebuildGuide.MapView;
        if (!view || !canvas.width) return null;
        const box = canvas.getBoundingClientRect();
        if (!box.width || !box.height) return null;
        // the canvas is drawn at its natural size, but stay honest about any
        // scaling the layout still applies to it
        const gx = view.minX + Math.floor((e.clientX - box.left) * (canvas.width / box.width) / view.u);
        const gy = view.minY + Math.floor((e.clientY - box.top) * (canvas.height / box.height) / view.u);

        for (const s of RebuildGuide.Steps) {
            if (s.t === 'street' && !RebuildGuide.ShowRoads()) continue;
            if (gx < s.x || gx >= s.x + s.w || gy < s.y || gy >= s.y + s.h) continue;
            return s;
        }
        return null;
    },


    /**
     * One line describing a step: what it is, how big, where, and what is wrong
     * with it right now.
     *
     * @param {Object} s - plan step
     * @returns {string} plain text, for the readout and the native tooltip
     */
    HoverText: (s) => {
        const name = s.t === 'street'
            ? i18n(s.l >= 2 ? 'Boxes.RebuildGuide.RoadTwoLane' : 'Boxes.RebuildGuide.Road')
            : (s.n || '');
        return name + '  ' + s.h + '×' + s.w + '  → ' + s.x + ', ' + s.y
            + (s.state === 'done' ? '  ✓' + (s.swap ? ' ' + s.swap : '') : '')
            + (s.state === 'blocked' && s.blocker ? '  (' + i18n(s.stolen ? 'Boxes.RebuildGuide.Stolen' : 'Boxes.RebuildGuide.Blocked') + ': ' + s.blocker.n + ')' : '');
    },


    /**
     * Fingerprint of a layout: how many items and where they sit. Two variants
     * of the same city differ in both, which is all this has to tell apart.
     *
     * @param {Array<Object>} items - plan items or CityBuilder.Data
     * @returns {string}
     */
    Signature: (items) => {
        let acc = 0;
        for (const b of items) {
            const x = parseInt(b.x) || 0, y = parseInt(b.y) || 0;
            acc = (acc * 31 + x * 131 + y * 17) % 2147483647;
        }
        return items.length + ':' + acc;
    },


    /**
     * Whether the layout the City Builder currently shows is the one being
     * carried out. Painting the guide's progress over a different variant would
     * mark spots that plan never had.
     *
     * @returns {boolean}
     */
    MatchesShown: () => {
        if (!RebuildGuide.Plan || !RebuildGuide.Steps.length) return false;
        if (localStorage.getItem('RebuildGuideOverlay') === '0') return false;
        const shown = (typeof CityBuilder !== 'undefined' && CityBuilder.Data) || [];
        if (!shown.length) return false;
        return RebuildGuide.Signature(shown) === RebuildGuide.Plan.sig;
    },


    /**
     * Paints the plan states into the City Builder map, which can be laid over
     * the live city. That view is the one that answers "where is that on my
     * screen" - the coordinates in the list never will.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} unit - pixels per tile of that canvas
     */
    PaintOverlay: (ctx, unit) => {
        if (!RebuildGuide.Steps.length) return;

        for (const s of RebuildGuide.Steps) {
            const bx = s.x * unit, by = s.y * unit, bw = s.w * unit, bh = s.h * unit;
            if (s.stolen) {
                // a road spot taken by a roadless building, wherever it is
                ctx.fillStyle = 'rgba(214, 60, 60, 0.45)';
                ctx.fillRect(bx, by, bw, bh);
                ctx.strokeStyle = 'rgba(214, 60, 60, 0.95)';
                ctx.lineWidth = 3;
                ctx.strokeRect(bx + 1.5, by + 1.5, bw - 3, bh - 3);
            } else if (s.band === RebuildGuide.Band && s.state !== 'done') {
                // the stripe to fill next: everything else is dimmed away
                ctx.strokeStyle = s.state === 'blocked' ? 'rgba(214, 60, 60, 0.95)' : 'rgba(255, 196, 61, 0.95)';
                ctx.lineWidth = 3;
                ctx.strokeRect(bx + 1.5, by + 1.5, bw - 3, bh - 3);
            } else if (s.state === 'done') {
                ctx.fillStyle = 'rgba(40, 90, 55, 0.35)';
                ctx.fillRect(bx, by, bw, bh);
            } else {
                ctx.fillStyle = 'rgba(20, 20, 20, 0.45)';
                ctx.fillRect(bx, by, bw, bh);
            }
        }

        RebuildGuide.PaintTop(ctx, unit);
        RebuildGuide.PaintSeek(ctx, unit);
        RebuildGuide.PaintMisplaced(ctx, unit);
    },


    /**
     * Writes the next planned spot of every building into the size list of the
     * reconstruction menu - that list is where the player picks the building up,
     * so that is where the coordinates belong. Done from here instead of from
     * the reconstruction module so the guide stays a City Builder feature.
     */
    AnnotateList: () => {
        const $rows = $('#ReconstructionListBody .reconstructionLine');
        if (!$rows.length || !RebuildGuide.Steps.length) return;

        // spots are keyed by what they can hold, not by the building the plan
        // originally put there - any building of the same size fits
        const open = RebuildGuide.Steps.filter(s => s.state !== 'done' && s.t !== 'street');

        $rows.each(function () {
            const $row = $(this);
            $row.find('.rg-target').remove();
            const m = RebuildGuide.Meta(String($row.attr('data-meta_id')));
            if (!m) return;
            const fit = open.filter(o => o.w === m.w && o.h === m.h && (m.s || 0) <= (o.s || 0));
            const s = fit.find(o => RebuildGuide.RoadWaste(m, o) === 0) || fit[0];
            if (!s) return;
            const cur = s.band === RebuildGuide.Band ? ' rg-target-now' : '';
            $row.children('td').first().append(
                `<span class="rg-target${cur}" title="${i18n('Boxes.RebuildGuide.NextSpotHint')}">&rarr; ${s.x}, ${s.y}</span>`
            );
        });
    }
};


// Reconstruction mode opens: the game sends the draft, which is the only place
// the moved-but-not-saved positions exist. A stored plan turns the guide on
// right there - that is the moment the player needs it.
FoEproxy.addHandler('CityReconstructionService', 'getDraft', (data) => {
    const list = data?.responseData;
    RebuildGuide.Draft = {};
    if (Array.isArray(list)) {
        for (const b of list) RebuildGuide.Draft[b.entityId] = b;
    }
    // an empty draft means nothing was moved yet - the city itself is the draft
    if (!Array.isArray(list) || !list.length) RebuildGuide.Draft = null;

    if (!RebuildGuide.Plan && !RebuildGuide.Load()) return;
    RebuildGuide.Open();
    RebuildGuide.Refresh();
    // the size list - and the menu order the squares are read from - is built
    // right after this handler
    setTimeout(RebuildGuide.Refresh, 400);
});


// every move inside reconstruction mode goes through saveDraft, so this is the
// tick that advances the guide
FoEproxy.addRequestHandler('CityReconstructionService', 'saveDraft', (data) => {
    if (!RebuildGuide.Steps.length) return;
    const moves = data?.requestData?.[0];
    if (!Array.isArray(moves)) return;

    if (!RebuildGuide.Draft) RebuildGuide.Draft = {};
    for (const m of moves) RebuildGuide.Draft[m.entityId] = m;

    // a building put somewhere the plan does not want it is worth saying out
    // loud once - silently marking it "still to do" reads like a bug
    RebuildGuide.OffPlan = null;
    for (const move of moves) {
        if (!move.position) continue;
        const inst = MainParser.CityMapData[move.entityId];
        if (!inst) continue;
        const asset = inst.cityentity_id || inst.entityId;
        const meta = RebuildGuide.Meta(asset, inst.type);
        // a road tile put down off the plan is not worth a warning
        if (!meta || meta.t === 'street') continue;
        const px = parseInt(move.position.x) || 0, py = parseInt(move.position.y) || 0;
        const rec = { a: asset, t: meta.t, w: meta.w, h: meta.h, s: meta.s };
        if (!RebuildGuide.Steps.some(s => s.x === px && s.y === py && RebuildGuide.Fits(rec, s))) {
            RebuildGuide.OffPlan = { name: meta.n || asset, x: px, y: py };
        } else if (!RebuildGuide.Steps.some(s => s.x === px && s.y === py && RebuildGuide.Fits(rec, s) && RebuildGuide.RoadWaste(rec, s) === 0)) {
            RebuildGuide.OffPlan = { name: meta.n || asset, x: px, y: py, stolen: true };
        }
    }

    RebuildGuide.Refresh();
    // the size list moves the menu order in its own handler for this request,
    // which may run after this one - read the top of the list once it has
    setTimeout(RebuildGuide.Refresh, 0);
});


// leaving reconstruction mode throws the draft away - from here on the city map
// is the truth again. Same two endpoints the reconstruction list watches.
FoEproxy.addHandler('AutoAidService', 'getStates', () => {
    if (RebuildGuide.Draft === null) return;
    RebuildGuide.Draft = null;
    RebuildGuide.Refresh();
});
FoEproxy.addHandler('InventoryService', 'getGreatBuildings', () => {
    if (RebuildGuide.Draft === null) return;
    RebuildGuide.Draft = null;
    RebuildGuide.Refresh();
});
