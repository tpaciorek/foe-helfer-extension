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
     * Forgets the plan - after the rebuild, or when it turned out to be the
     * wrong one.
     */
    Drop: () => {
        RebuildGuide.Plan = null;
        RebuildGuide.Steps = [];
        RebuildGuide.OffPlan = null;
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

        const add = (id, inst, px, py) => {
            const assetId = inst.cityentity_id || inst.entityId;
            const m = RebuildGuide.Meta(assetId, inst.type);
            if (!m) return;
            const rec = { id: id, a: assetId, t: m.t, x: px, y: py, w: m.w, h: m.h, n: m.n, s: m.s };
            for (let i = 0; i < m.w; i++) {
                for (let j = 0; j < m.h; j++) tiles.set((px + i) + ',' + (py + j), rec);
            }
        };

        if (RebuildGuide.Draft) {
            for (const [id, d] of Object.entries(RebuildGuide.Draft)) {
                if (!d || !d.position) continue;
                const inst = cityMap[id];
                if (!inst) continue;
                // the game leaves out a coordinate that is zero
                add(id, inst, parseInt(d.position.x) || 0, parseInt(d.position.y) || 0);
            }
        } else {
            for (const [id, inst] of Object.entries(cityMap)) {
                if (!inst) continue;
                const rx = inst.x !== undefined ? inst.x : inst.coords?.x;
                const ry = inst.y !== undefined ? inst.y : inst.coords?.y;
                if (rx === undefined && ry === undefined) continue;
                add(id, inst, parseInt(rx) || 0, parseInt(ry) || 0);
            }
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
     * Marks every step done / blocked / still to do against the current city,
     * and moves the guide on to the first band that has work left.
     */
    Evaluate: () => {
        const tiles = RebuildGuide.Occupancy();

        for (const s of RebuildGuide.Steps) {
            s.state = 'todo';
            s.blocker = null;
            s.swap = null;

            const at = tiles.get(s.x + ',' + s.y);
            if (at && at.x === s.x && at.y === s.y && RebuildGuide.Fits(at, s)) {
                s.state = 'done';
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

        if (!RebuildGuide.ManualBand) {
            const first = RebuildGuide.FirstOpenBand();
            if (first !== null) RebuildGuide.Band = first;
        }
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

        // the skewed overlay is the whole point here, not the top-down view
        localStorage.setItem('CityBuilderFlatView', '0');
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
        h.push('</div>');

        const extra = RebuildGuide.Extra();
        if (extra.length) {
            const total = extra.reduce((a, e) => a + e.count, 0);
            const names = extra.slice(0, 3).map(e => RebuildGuide.Escape(e.name) + (e.count > 1 ? ' &times;' + e.count : '')).join(', ');
            h.push(`<div class="rg-warn">${i18n('Boxes.RebuildGuide.NoSpot')}: <b>${total}</b> &ndash; ${names}`
                + `${extra.length > 3 ? ' &hellip;' : ''}</div>`);
        }

        if (RebuildGuide.OffPlan) {
            h.push(`<div class="rg-warn">${i18n('Boxes.RebuildGuide.OffPlan')}: `
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

        // the one building to pick up now, spelled out: a number on the map
        // says where, it never says what to carry there
        const next = steps.find(s => s.state !== 'done');
        if (next) {
            h.push('<div class="rg-now">');
            h.push(`<span class="rg-now-no">1</span>`);
            h.push(`<span class="rg-now-size">${next.h}&times;${next.w}</span>`);
            h.push(`<span class="rg-now-name">${RebuildGuide.Label(next)}</span>`);
            h.push(`<span class="rg-now-pos">${next.x}, ${next.y}</span>`);
            h.push('</div>');
            if (next.state === 'blocked' && next.blocker) {
                h.push(`<div class="rg-now-blocked">${i18n('Boxes.RebuildGuide.Blocked')}: `
                    + `<b>${RebuildGuide.Escape(next.blocker.n)}</b></div>`);
            }
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
                ? i18n('Boxes.RebuildGuide.Blocked') + ': ' + RebuildGuide.Escape(s.blocker.n)
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

        $('#RebuildGuideBoxBody').html(h.join('')).promise().done(function () {
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
            }

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
            else if (cur && s.state === 'blocked') ctx.fillStyle = 'rgba(214, 84, 84, 0.9)';
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

        RebuildGuide.ScrollToStep(canvas);
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

        const s = RebuildGuide.Steps.find(o => o.band === RebuildGuide.Band && o.state !== 'done'
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
            + (s.state === 'blocked' && s.blocker ? '  (' + i18n('Boxes.RebuildGuide.Blocked') + ': ' + s.blocker.n + ')' : '');
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
            if (s.band === RebuildGuide.Band && s.state !== 'done') {
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
            const s = open.find(o => o.w === m.w && o.h === m.h && (m.s || 0) <= (o.s || 0));
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
    // the size list is built right after this handler
    setTimeout(RebuildGuide.AnnotateList, 400);
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
        }
    }

    RebuildGuide.Refresh();
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
