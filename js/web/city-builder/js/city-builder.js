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

{
    // tick off the plan while rebuilding: stored and placed buildings update
    // the open side box without a reload; a debounce collapses message bursts
    let refreshTimer = null;
    FoEproxy.addFoeHelperHandler('CityMapUpdated', () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            if (CityBuilder.Planned && $('#CityBuilderUnplacedBox').length > 0) CityBuilder.showUnplaced();
        }, 250);
    });
}


let CityBuilder = {

    Data: [],
    Unplaced: [],
    // buildings the user took off the map by click, and their instance ids -
    // they stay out of the plan until they are restored from the unplaced box
    Removed: [],
    Excluded: new Set(),
    Stats: null,
    // the complete layouts nothing beats on roads and free square at once, plus
    // the one the ranking picked - the player switches between them instead of
    // the road tolerance deciding the trade for them
    Variants: [],
    VariantIndex: 0,
    // Facts about the search itself - how many variants it tried, how long it
    // took, what it made of the live city. They belong to the run, not to the
    // layout on screen: reading them off the selected variant made the report
    // claim "0 variants in 0 s" the moment the player switched to another plan,
    // and dropped the baseline note that says whether polishing found anything.
    SearchMeta: null,
    RoadsBefore: 0,
    RoadsBeforeTiles: [],
    // time box for the layout search - the worker reports progress and can be
    // stopped early, so a long budget only means "may take up to this long"
    BudgetMs: 90000,
    MapScale: 20,
    Worker: null,
    /** @type {function|null} stops the running worker and settles its promise */
    WorkerStop: null,
    PanX: 0,
    PanY: 0,
    EditMode: false,
    ShowNames: false,
    ShowTooltips: true,
    /** @type {boolean} hatch the build progress (planned spots done, near, wrong) */
    ShowProgress: true,
    Reserve: '',
    ReserveOn: false,
    Optimize: false,
    /** @type {boolean} keep the city as it stands and only place new buildings */
    KeepLayout: false,
    /** @type {{x: number, y: number, width: number, height: number}[]} street pieces of the live city */
    LiveRoads: [],
    /** @type {boolean} whether the options of the building optimization are unfolded */
    OptionsOpen: false,
    /** @type {{removed: Object[], added: Object[], gain: number}|null} swap plan of the building optimization */
    Planned: null,
    /** @type {number|null} timestamp of the plan loaded from the storage */
    SavedAt: null,


    /**
     * Opens the builder. A plan saved for this world and map is shown right
     * away, so a city can be rebuilt over several days; otherwise the layout
     * is calculated.
     */
    init: async () => {
        if ($('#CityBuilderBox').length > 0) {
            HTML.CloseOpenBox('CityBuilderBox');
            if ($('#CityBuilderUnplacedBox').length > 0) HTML.CloseOpenBox('CityBuilderUnplacedBox');
            if ($('#CityBuilderKeepBox').length > 0) HTML.CloseOpenBox('CityBuilderKeepBox');
            CityBuilder.stopWorker();
            return;
        }

        // reset all planning state on open
        CityBuilder.Data = [];
        CityBuilder.Removed = [];
        CityBuilder.Excluded = new Set();
        CityBuilder.Variants = [];
        CityBuilder.VariantIndex = 0;
        CityBuilder.EditMode = false;
        CityBuilder.Planned = null;
        CityBuilder.SavedAt = null;
        CityBuilder.Renderer.Highlight = null;
        CityBuilder.Interaction.Hover = null;
        HTML.AddCssFile('city-builder');

        // the city planner shows the live city on top of the plan - out of the way
        if ($('#citymap-main').length > 0) HTML.CloseOpenBox('citymap-main');

        HTML.Box({
            id: 'CityBuilderBox',
            title: i18n('Boxes.CityBuilder.Title'),
            auto_close: true,
            dragdrop: true,
            minimize: true,
            popout: () => CityBuilder.PopOut(),
            resize: true
        });

        const saved = CityBuilder.readPlan();
        if (saved) {
            CityBuilder.applyPlan(saved);
            return;
        }

        CityBuilder.showLoading();
        await CityBuilder.MergeData();
    },


    /**
     * Unlocked areas of the map the builder works on.
     *
     * @returns {Object[]} Areas as the game sends them (zero coordinates left out).
     */
    liveAreas: () => {
        let areas = CityMap.Main.unlockedAreas;
        if (ActiveMap === 'era_outpost') areas = CityMap.EraOutpost.areas;
        else if (ActiveMap === 'guild_raids') areas = CityMap.QI.areas;
        else if (ActiveMap === 'cultural_outpost') areas = CityMap.CulturalOutpost.areas;
        return Object.values(areas || {});
    },


    /**
     * Storage key of the saved plan: one plan per world and map.
     *
     * @returns {string} localStorage key.
     */
    planKey: () => 'CityBuilderPlan_' + ExtWorld + (ActiveMap && ActiveMap !== 'main' ? '_' + ActiveMap : ''),


    /**
     * Reads the saved plan of this world and map.
     *
     * @returns {Object|null} Saved plan or null.
     */
    readPlan: () => {
        try {
            const plan = JSON.parse(localStorage.getItem(CityBuilder.planKey()) || 'null');
            return (plan?.variants?.[0]?.layout?.length || plan?.variant?.layout?.length) ? plan : null;
        } catch (e) {
            return null;
        }
    },


    /**
     * Saves all layout variants with the shown one selected, together with the
     * removed and planned buildings, so the plan survives a reload, can be
     * rebuilt step by step and the variants stay switchable. If the storage is
     * too small for all of them, only the shown variant is kept.
     */
    savePlan: () => {
        if (!CityBuilder.Variants[CityBuilder.VariantIndex]) return;

        // the per-run search log is only needed right after a calculation
        const strip = (v) => ({ layout: v.layout, unplaced: v.unplaced || [], stats: Object.assign({}, v.stats, { tried: undefined }), planned: v.planned });
        const plan = {
            version: 2,
            savedAt: Date.now(),
            variants: CityBuilder.Variants.map(strip),
            variantIndex: CityBuilder.VariantIndex,
            removed: CityBuilder.Removed,
            planned: CityBuilder.Planned,
            roadsBefore: CityBuilder.RoadsBefore
        };
        try {
            try {
                localStorage.setItem(CityBuilder.planKey(), JSON.stringify(plan));
            } catch (e) {
                plan.variants = [plan.variants[plan.variantIndex]];
                plan.variantIndex = 0;
                localStorage.setItem(CityBuilder.planKey(), JSON.stringify(plan));
            }
            CityBuilder.SavedAt = plan.savedAt;
            HTML.ShowToastMsg({
                head: i18n('Boxes.CityBuilder.Title'),
                text: i18n('Boxes.CityBuilder.PlanSaved'),
                type: 'success',
                hideAfter: 4000
            });
        } catch (e) {
            console.error('CityBuilder: plan could not be saved', e);
        }
        CityBuilder.showMap();
    },


    /**
     * Shows a saved plan instead of calculating a new layout.
     *
     * @param {Object} plan - Plan from readPlan().
     */
    applyPlan: (plan) => {
        CityBuilder.Variants = plan.variants || [plan.variant];
        CityBuilder.Removed = plan.removed || [];
        CityBuilder.Excluded = new Set(CityBuilder.Removed.map(b => b.id));
        CityBuilder.Planned = plan.planned || null;
        CityBuilder.RoadsBefore = plan.roadsBefore || 0;
        CityBuilder.SavedAt = plan.savedAt || null;
        CityBuilder.applyVariant(Math.min(plan.variantIndex || 0, CityBuilder.Variants.length - 1));
    },


    /**
     * Lets the user pick a plan file and shows it as template. The file must
     * be picked by a click, the browser allows no other way.
     */
    importFile: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                let plan = null;
                try {
                    plan = CityBuilder.planFromFile(JSON.parse(reader.result));
                } catch (e) {
                    console.error('CityBuilder: plan file could not be read', e);
                }
                if (!plan) {
                    HTML.ShowToastMsg({ head: i18n('Boxes.CityBuilder.Title'), text: i18n('Boxes.CityBuilder.ImportFailed'), type: 'error', hideAfter: 6000 });
                    return;
                }
                CityBuilder.applyPlan(plan);
                HTML.ShowToastMsg({ head: i18n('Boxes.CityBuilder.Title'), text: i18n('Boxes.CityBuilder.ImportDone'), type: 'success', hideAfter: 6000 });
            };
            reader.readAsText(file);
        });
        input.click();
    },


    /**
     * Turns an imported file into a plan. Accepts building lists like the ones
     * of the city planner on foe-helper.com - an array or an object with
     * buildings/entities/data - of objects with cityentity_id, x and y
     * (isUsed === false means not placed).
     * The template is compared with the live city: buildings the city lacks and
     * buildings the template does not use are listed in the side box.
     *
     * @param {Object|Object[]} data - Parsed file content.
     * @returns {Object|null} Plan for applyPlan() or null if nothing usable was found.
     */
    planFromFile: (data) => {
        let list = Array.isArray(data) ? data : (data?.buildings || data?.entities || data?.data || null);
        if (typeof list === 'string') list = JSON.parse(list);
        if (!Array.isArray(list)) return null;

        const CE = MainParser.CityEntities;
        const layout = [];
        list.forEach((b, i) => {
            if (!b || b.isUsed === false) return;
            // the game leaves out coordinates that are 0
            const x = parseInt(b.x ?? 0), y = parseInt(b.y ?? 0);
            if (isNaN(x) || isNaN(y)) return;

            const entityId = b.cityentity_id || null;
            const meta = entityId ? CE[entityId] : null;
            const isStreet = b.type === 'street' || meta?.type === 'street';
            const size = meta?.components?.AllAge?.placement?.size;
            const street = b.street_level ?? meta?.components?.AllAge?.streetConnectionRequirement?.requiredLevel ?? 0;
            layout.push({
                id: 'tpl_' + i,
                asset_id: isStreet ? undefined : entityId,
                name: isStreet ? 'Road' : (meta?.name || b.name || entityId || '?'),
                type: isStreet ? 'street' : (b.type || meta?.type || 'generic_building'),
                x: x,
                y: y,
                width: parseInt(size?.x || b.width) || 1,
                height: parseInt(size?.y || b.height || b.length) || 1,
                street_level: isStreet ? 0 : street,
                // two-lane road pieces are the 2x2 ones
                level: isStreet ? (b.level || ((parseInt(size?.x || b.width) || 1) >= 2 ? 2 : 1)) : undefined
            });
        });
        if (!layout.some(b => b.type !== 'street')) return null;

        // compare with the live city: what is missing, what is left over
        const count = (ids) => ids.reduce((m, id) => { m[id] = (m[id] || 0) + 1; return m; }, {});
        const want = count(layout.filter(b => b.asset_id && b.type !== 'reserved').map(b => b.asset_id));
        const city = Object.values(MainParser.CityMapData).filter(i => i && (i.x || 0) >= 0 && (i.y || 0) >= 0
            && !['street', 'off_grid', 'hub_main', 'hub_part'].includes(i.type));
        const have = count(city.map(i => i.cityentity_id));
        const entry = (id, extra) => {
            const size = CE[id]?.components?.AllAge?.placement?.size || {};
            return Object.assign({ entityId: id, name: CE[id]?.name || id, w: parseInt(size.x) || 1, h: parseInt(size.y) || 1, score: '' }, extra);
        };
        const added = [], removed = [];
        for (const [id, n] of Object.entries(want)) {
            for (let i = (have[id] || 0); i < n; i++) added.push(entry(id));
        }

        // star the copies the city lacks, like the new buildings of the optimization
        const lacking = count(added.map(a => a.entityId));
        for (let i = layout.length - 1; i >= 0; i--) {
            const b = layout[i];
            if (lacking[b.asset_id] > 0) {
                b.name = '★ ' + b.name;
                lacking[b.asset_id]--;
            }
        }
        const left = Object.assign({}, want);
        for (const inst of city) {
            if (left[inst.cityentity_id] > 0) left[inst.cityentity_id]--;
            else removed.push(entry(inst.cityentity_id, { id: inst.id }));
        }

        const tiles = (list) => list.reduce((s, b) => s + b.width * b.height, 0);
        const liveRoads = Object.values(MainParser.CityMapData).filter(i => i?.type === 'street').map(i => {
            const size = CE[i.cityentity_id]?.components?.AllAge?.placement?.size || {};
            return { width: parseInt(size.x) || 1, height: parseInt(size.y) || 1 };
        });
        return {
            version: 1,
            savedAt: null,
            variant: { layout: layout, unplaced: [], stats: { roads: tiles(layout.filter(b => b.type === 'street')), missing: 0 } },
            removed: [],
            planned: { source: 'template', removed: removed, added: added, gain: null, known: Object.keys(MainParser.CityMapData) },
            roadsBefore: tiles(liveRoads)
        };
    },


    /**
     * Deletes the saved plan of this world and map.
     */
    deletePlan: () => {
        localStorage.removeItem(CityBuilder.planKey());
        CityBuilder.SavedAt = null;
        CityBuilder.showMap();
    },


    /**
     * Downloads the plan as a top-down picture: every building with its name,
     * roads dark, the free space green - handy as a template next to the game.
     */
    exportImage: () => {
        const layout = CityBuilder.Data;
        if (!layout.length) return;

        const cell = 24;
        const areas = CityBuilder.liveAreas();
        let maxX = 0, maxY = 0;
        for (const a of areas) {
            maxX = Math.max(maxX, (a.x || 0) + a.width);
            maxY = Math.max(maxY, (a.y || 0) + (a.length || a.height));
        }
        const canvas = document.createElement('canvas');
        canvas.width = maxX * cell;
        canvas.height = maxY * cell;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#1b1b1b';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // buildable area
        ctx.fillStyle = '#3d5a2a';
        for (const a of areas) {
            ctx.fillRect((a.x || 0) * cell, (a.y || 0) * cell, a.width * cell, (a.length || a.height) * cell);
        }

        const cssCache = new Map();
        for (const b of layout) {
            const isStreet = (b.type || '').includes('street') || b.name === 'Road';
            ctx.fillStyle = CityBuilder.Renderer.buildingColor(b, cssCache);
            ctx.fillRect(b.x * cell, b.y * cell, b.width * cell, b.height * cell);
            if (isStreet) continue;
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.strokeRect(b.x * cell + 0.5, b.y * cell + 0.5, b.width * cell - 1, b.height * cell - 1);

            // name, wrapped into the footprint
            ctx.fillStyle = '#ffffff';
            ctx.font = '10px sans-serif';
            ctx.textBaseline = 'top';
            const maxW = b.width * cell - 4;
            const lines = [];
            let line = '';
            for (const word of (b.name || '').split(' ')) {
                const test = line ? line + ' ' + word : word;
                if (ctx.measureText(test).width > maxW && line) {
                    lines.push(line);
                    line = word;
                } else {
                    line = test;
                }
            }
            if (line) lines.push(line);
            const maxLines = Math.max(1, Math.floor((b.height * cell - 4) / 11));
            lines.slice(0, maxLines).forEach((l, i) => ctx.fillText(l, b.x * cell + 2, b.y * cell + 2 + i * 11, maxW));
        }

        canvas.toBlob((blob) => download(blob, 'city-plan-' + ExtWorld + '-' + moment().format('YYMMDD-HHmm') + '.png', 'image/png'), 'image/png');
    },


    /**
     * Shows the loading panel with the progress bar fed by the worker's
     * percentage pings - solid background so it stays readable on top of
     * the live city. Also used when the layout is recalculated.
     */
    showLoading: () => {
        $('#CityBuilderBoxBody').addClass('msg-state').html(CityBuilder.LoadingHtml());
    },


    /**
     * Progress panel shown while the worker searches. The search runs for
     * minutes, so it reports more than a percentage: the current phase, the
     * remaining time, the best layout found so far and a button that stops
     * the search early and keeps that best layout.
     */
    LoadingHtml: () => {
        return `<div class="city-builder-loading">
            <div class="message">
                <div class="loading-title">${i18n('Boxes.CityBuilder.Calculating')}</div>
                <div class="loading-bar"><div class="loading-bar-fill"></div></div>
                <div class="calc-progress">0%</div>
                <div class="calc-phase">${i18n('Boxes.CityBuilder.PhaseBase')}</div>
                <div class="calc-detail"></div>
                <button class="btn calc-stop" onclick="CityBuilder.StopSearch(this)">${i18n('Boxes.CityBuilder.StopSearch')}</button>
            </div>
        </div>`;
    },


    /**
     * Ends the running search early - the worker answers with the best layout it
     * has found so far.
     */
    StopSearch: (btn) => {
        if (!CityBuilder.Worker) return;
        $(btn).prop('disabled', true).text(i18n('Boxes.CityBuilder.Stopping'));
        CityBuilder.Worker.postMessage({ cmd: 'stop' });
    },


    /**
     * Recalculates the layout with the current city data. Buildings the user
     * removed from the map stay excluded and are not planned in again until
     * they are restored from the unplaced-buildings box. Works in the game
     * overlay and in the pop-out window.
     */
    Recalculate: async () => {
        CityBuilder.Renderer.Highlight = null;
        CityBuilder.Interaction.Hover = null;
        if (typeof Tooltips !== 'undefined') Tooltips.deactivate();

        CityBuilder.SavedAt = null;
        CityBuilder.showLoading();
        await CityBuilder.MergeData();
    },


    /**
     * Switches the map to one of the computed layout variants. The variants
     * come pre-ranked from the worker; switching is instant because every
     * layout was already calculated. Buildings the user removed stay hidden
     * in every variant.
     *
     * @param {number} idx - Index into CityBuilder.Variants.
     */
    applyVariant: (idx) => {
        const v = CityBuilder.Variants[idx];
        if (!v) return;

        CityBuilder.VariantIndex = idx;
        // the building optimization plugs the gaps of every variant differently
        if (v.planned) CityBuilder.Planned = v.planned;
        CityBuilder.Data = v.layout.filter(b => !(b.id !== undefined && b.id !== null && CityBuilder.Excluded.has(b.id)));
        CityBuilder.Unplaced = v.unplaced || [];
        CityBuilder.Stats = v.stats || null;

        CityBuilder.Renderer.Highlight = null;
        CityBuilder.Interaction.Hover = null;
        if (typeof Tooltips !== 'undefined') Tooltips.deactivate();

        CityBuilder.showMap();
    },


    /**
     * Switches the shown plan to another of the layouts the search kept.
     *
     * Everything downstream - the map, the report, the HTML export - reads
     * Data/Unplaced/Stats, so swapping those three is the whole switch. The
     * swap itself is applyVariant's job, so that a switch from the variant
     * buttons drops the removed buildings just like every other switch.
     *
     * @param {number} i - index into CityBuilder.Variants
     */
    SelectVariant: (i) => {
        CityBuilder.applyVariant(i);
    },


    /**
     * Label of one variant button: the two numbers the choice is actually
     * about, plus a tag for the ends of the front so the trade is readable
     * without comparing the numbers by hand.
     *
     * @param {number} i - index into CityBuilder.Variants
     * @returns {string} escaped button label
     */
    VariantLabel: (i) => {
        const list = CityBuilder.Variants;
        const s = list[i] && list[i].stats;
        if (!s) return '';
        // where the town hall stands says more about a plan at a glance than
        // any of the numbers - it is what the player recognises the layout by
        const tag = s.baseline
            ? i18n('Boxes.CityBuilder.VariantOwn')
            : (s.tunedBaseline
                ? i18n('Boxes.CityBuilder.VariantTuned')
                : (s.cheapestRoads
                    ? i18n('Boxes.CityBuilder.VariantFewestRoads')
                    : i18n('Boxes.CityBuilder.Placement.' + (s.placement || 'top-left'))));
        const text = s.roads + ' ' + i18n('Boxes.CityBuilder.RoadsShort')
            + ' · ' + s.square + '×' + s.square + (tag ? ' · ' + tag : '');
        return text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    },


    /**
     * Whose city the plan is for: another player's when the map box shows a
     * visited city, our own otherwise. A report without an owner is useless the
     * moment two of them sit next to each other.
     *
     * @returns {string} player name and world
     */
    CityOwner: () => {
        const other = (typeof ActiveMap !== 'undefined' && ActiveMap === 'OtherPlayer')
            ? (CityMap.OtherPlayer && CityMap.OtherPlayer.name)
            : null;
        const name = other || (typeof ExtPlayerName !== 'undefined' && ExtPlayerName) || '?';
        const world = (typeof ExtWorld !== 'undefined' && ExtWorld) ? ' @ ' + ExtWorld : '';
        return name + world + (other ? ' (' + i18n('Boxes.CityBuilder.OtherPlayer') + ')' : '');
    },


    /**
     * Compact diagnostic report of the last run: map, the building list with
     * sizes and street requirements, the resulting layout, the statistics and
     * everything the optimizer could not place. Arrays instead of objects keep
     * it small enough to paste somewhere.
     *
     * @returns {Object|null} the report, or null when nothing has been calculated
     */
    BuildReport: (compact) => {
        if (!CityBuilder.LastInput) return null;

        const input = CityBuilder.LastInput;
        const areas = Array.isArray(input.mapData) ? input.mapData : Object.values(input.mapData || {});

        let mapTiles = 0;
        const areaRows = areas.map(a => {
            const w = a.width || 0, l = a.length || 0;
            mapTiles += w * l;
            return [a.x || 0, a.y || 0, w, l];
        });

        // how many buildings really need a road - the number that decides
        // whether the layout has any chance of beating a hand-built city
        const byStreet = { 0: 0, 1: 0, 2: 0 };
        const byType = {};
        let buildTiles = 0;
        for (const b of input.buildingsData) {
            const lvl = b.street_level || 0;
            byStreet[lvl] = (byStreet[lvl] || 0) + 1;
            byType[b.type] = (byType[b.type] || 0) + 1;
            buildTiles += b.width * b.height;
        }

        const s = CityBuilder.Stats || {};

        return {
            v: 1,
            note: 'FoE Helper City Builder diagnostic report',
            city: CityBuilder.CityOwner(),
            date: new Date().toISOString(),
            map: { areas: areaRows, tiles: mapTiles },
            input: {
                buildings: input.buildingsData.length,
                tiles: buildTiles,
                byStreetLevel: byStreet,
                byType: byType
            },
            result: {
                roadsBefore: CityBuilder.RoadsBefore,
                roadsAfter: s.roads,
                twoLaneTiles: s.l2,
                freeSquare: s.square,
                freeTotal: s.freeTotal,
                freeOutsideMainBlock: s.freeOutside,
                fragments: s.fragments,
                missing: s.missing,
                unconnected: s.unconnected,
                strategy: s.strategy,
                sortMode: s.sortMode,
                // of the search, not of the variant currently on screen
                runs: (CityBuilder.SearchMeta || s).runs,
                elapsedMs: (CityBuilder.SearchMeta || s).elapsedMs,
                stoppedEarly: (CityBuilder.SearchMeta || s).stopped
            },
            // Compact form groups identical buildings into counts: a pasted
            // report used to carry 400 near-duplicate rows, which is what made
            // the conversation around it unmanageable.
            // [count, name, width, height, streetLevel, type]
            buildings: compact
                ? (() => {
                    const seen = new Map();
                    for (const b of input.buildingsData) {
                        const key = [b.name, b.width, b.height, b.street_level || 0, b.type].join('|');
                        seen.set(key, (seen.get(key) || 0) + 1);
                    }
                    return [...seen.entries()]
                        .map(([key, n]) => {
                            const p = key.split('|');
                            return [n, p[0], +p[1], +p[2], +p[3], p[4]];
                        })
                        .sort((a, b) => b[0] - a[0]);
                })()
                : input.buildingsData.map(b => [b.name, b.width, b.height, b.street_level || 0, b.type]),
            // [x, y, width, height, type, streetLevel] - a rejected incomplete
            // layout is reported too, that is exactly what needs analysing
            layout: compact ? 'omitted - use Save report for the full layout' : ((CityBuilder.Data && CityBuilder.Data.length)
                ? CityBuilder.Data
                : ((CityBuilder.LastFailed && CityBuilder.LastFailed.layout) || [])
            ).map(b => [b.x, b.y, b.width, b.height, b.type, b.street_level || 0]),
            layoutTiles: (CityBuilder.Data || []).length,
            // [name, width, height, streetLevel]
            unplaced: (CityBuilder.Unplaced || []).map(b => [b.name, b.width, b.height, b.street_level || 0])
        };
    },


    /**
     * Failure panel. Every error path ends here, because the log and the report
     * are needed most when the run did not produce a layout - a bare red line
     * left no way to hand anything over.
     *
     * @param {string} message - what went wrong
     */
    ShowFailure: (message) => {
        CityBuilder.LastError = message;
        console.error('CityBuilder:', message);

        $('#CityBuilderBoxBody').addClass('msg-state').html(`<div class="city-builder-incomplete">
            <div class="incomplete-title">${i18n('Boxes.CityBuilder.Failed')}</div>
            <p class="incomplete-count">${String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
            <button class="btn btn-slim" onclick="CityBuilder.CopyReport(false)">${i18n('Boxes.CityBuilder.CopyReport')}</button>
            <button class="btn btn-slim" onclick="CityBuilder.SaveReport()">${i18n('Boxes.CityBuilder.SaveReport')}</button>
            <button class="btn btn-slim" onclick="CityBuilder.DumpInput()">${i18n('Boxes.CityBuilder.SaveInput')}</button>
        </div>`);
    },


    /**
     * Colours of the export, matching the city map: the plan has to be
     * recognisable at a glance next to the city it replaces.
     */
    ExportColors: {
        main_building: '#f2a30f',
        greatbuilding: '#e2552b',
        residential: '#63b3ed',
        production: '#2b6cb0',
        goods: '#9f7aea',
        culture: '#4fa3a3',
        military: '#c05621',
        decoration: '#48885a',
        street: '#4a4a4a',
        generic_building: '#63b3ed'
    },


    /**
     * Draws one city as an SVG: every building a rectangle, roads dark grey.
     *
     * @param {Array} items - objects with x, y, width, height and type
     * @param {Object} bounds - {minX, minY, maxX, maxY} of the map
     * @param {number} unit - pixels per tile
     * @returns {string} the SVG markup
     */
    ExportSvg: (items, bounds, unit, validTiles) => {
        const w = (bounds.maxX - bounds.minX) * unit;
        const h = (bounds.maxY - bounds.minY) * unit;
        const parts = [`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">`];
        parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#120d07" />`);

        // free space is the point of the whole plan, so it gets its own colour
        // instead of being "whatever the background happens to be"
        if (validTiles) {
            const used = new Set();
            for (const it of items) {
                for (let i = it.x; i < it.x + it.width; i++) {
                    for (let j = it.y; j < it.y + it.height; j++) used.add(i + ',' + j);
                }
            }
            for (const key of validTiles) {
                if (used.has(key)) continue;
                const p = key.split(',');
                const fx = (+p[0] - bounds.minX) * unit;
                const fy = (+p[1] - bounds.minY) * unit;
                parts.push(`<rect x="${fx}" y="${fy}" width="${unit}" height="${unit}" fill="#7ee081"><title>${p[0]},${p[1]}</title></rect>`);
            }
        }

        for (const it of items) {
            const type = it.type === 'street' ? 'street' : (it.type || 'generic_building');
            const fill = CityBuilder.ExportColors[type] || CityBuilder.ExportColors.generic_building;
            const x = (it.x - bounds.minX) * unit;
            const y = (it.y - bounds.minY) * unit;
            const bw = Math.max(1, it.width * unit - 1);
            const bh = Math.max(1, it.height * unit - 1);
            // hovering names the building, the same way the map in the game does
            const esc2 = (t) => String(t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
            const road = type === 'street' ? 'road'
                : (it.street_level >= 2 ? 'two-lane road' : (it.street_level === 1 ? 'road' : 'no road'));
            const label = esc2(it.name || type) + '  ·  ' + it.width + '×' + it.height
                + '  ·  ' + esc2(type) + '  ·  ' + road + '  ·  ' + it.x + ',' + it.y;
            // the id ties the same building in both maps together, so hovering
            // one of them marks the other as well
            const bid = it.id ? ` data-b="${String(it.id).replace(/"/g, '')}"` : '';
            parts.push(`<rect${bid} x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${fill}" stroke="#0e0a05" stroke-width="0.5"><title>${label}</title></rect>`);
        }
        parts.push('</svg>');
        return parts.join('');
    },


    /**
     * Exports a self-contained HTML page comparing the current city with the
     * planned one, side by side, with the numbers underneath. Nothing is loaded
     * from the network, so the file can simply be sent on.
     */
    ExportHtml: () => {
        const input = CityBuilder.LastInput;
        const stats = CityBuilder.Stats;
        const plan = CityBuilder.Data && CityBuilder.Data.length
            ? CityBuilder.Data
            : ((CityBuilder.LastFailed && CityBuilder.LastFailed.layout) || []);

        if (!input || !plan.length) {
            HTML.ShowToastMsg({
                head: i18n('Boxes.CityBuilder.ToastHeadCopyFailed'),
                text: i18n('Boxes.CityBuilder.NoData'),
                type: 'error',
                hideAfter: 5000
            });
            return;
        }

        // one shared frame, so both maps are drawn at the same scale
        const areas = Array.isArray(input.mapData) ? input.mapData : Object.values(input.mapData || {});
        const bounds = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
        for (const a of areas) {
            bounds.minX = Math.min(bounds.minX, a.x || 0);
            bounds.minY = Math.min(bounds.minY, a.y || 0);
            bounds.maxX = Math.max(bounds.maxX, (a.x || 0) + (a.width || 0));
            bounds.maxY = Math.max(bounds.maxY, (a.y || 0) + (a.length || 0));
        }

        // a rect with x="NaN" silently draws nothing, which turns the whole
        // "before" map into empty ground - only finite coordinates get through
        const before = input.buildingsData
            .filter(b => Number.isFinite(b.x) && Number.isFinite(b.y))
            .concat(CityBuilder.RoadsBeforeTiles.map(r => Object.assign({ type: 'street' }, r)));

        const validTiles = new Set();
        for (const a of areas) {
            for (let i = a.x || 0; i < (a.x || 0) + (a.width || 0); i++) {
                for (let j = a.y || 0; j < (a.y || 0) + (a.length || 0); j++) validTiles.add(i + ',' + j);
            }
        }

        const unit = 14;
        const esc = (t) => String(t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

        // every alternative goes into the same file, so the trade can be seen
        // by clicking rather than by exporting twice and holding two windows
        // side by side. Without a real choice this is the one shown plan.
        const variants = CityBuilder.Variants.length > 1
            ? CityBuilder.Variants
            : [{ layout: plan, unplaced: CityBuilder.Unplaced || [], stats: stats }];
        const shown = CityBuilder.Variants.length > 1 ? CityBuilder.VariantIndex : 0;

        const panel = (v, i) => {
            const s = v.stats;
            const rect = s && s.rectW ? s.rectW + '×' + s.rectH : '-';
            const saved = CityBuilder.RoadsBefore - (s ? s.roads : 0);
            const rows = [
                [i18n('Boxes.CityBuilder.ExportRoads'), CityBuilder.RoadsBefore, s ? s.roads : '-'],
                [i18n('Boxes.CityBuilder.FreeSquare'), '-', s ? s.square + '×' + s.square : '-'],
                [i18n('Boxes.CityBuilder.FreeRect'), '-', rect],
                [i18n('Boxes.CityBuilder.FreeScattered'), '-', s ? s.freeOutside : '-'],
                [i18n('Boxes.CityBuilder.Unplaced'), '-', (v.unplaced || []).length]
            ];
            return `<div class="variant" data-v="${i}"${i === shown ? '' : ' hidden'}>
<div class="maps">
 <div class="map"><h2>${esc(i18n('Boxes.CityBuilder.ExportBefore'))}</h2>${CityBuilder.ExportSvg(before, bounds, unit, validTiles)}</div>
 <div class="map"><h2>${esc(i18n('Boxes.CityBuilder.ExportAfter'))}</h2>${CityBuilder.ExportSvg(v.layout || [], bounds, unit, validTiles)}</div>
</div>
<table>
 <tr><th></th><th>${esc(i18n('Boxes.CityBuilder.ExportBefore'))}</th><th>${esc(i18n('Boxes.CityBuilder.ExportAfter'))}</th></tr>
 ${rows.map(r => `<tr><th>${esc(r[0])}</th><td class="num">${esc(r[1])}</td><td class="num">${esc(r[2])}</td></tr>`).join('\n ')}
 <tr><th>${esc(i18n('Boxes.CityBuilder.Savings'))}</th><td class="num"></td><td class="num ${saved >= 0 ? 'good' : 'bad'}">${saved >= 0 ? '-' : '+'}${Math.abs(saved)}</td></tr>
</table></div>`;
        };

        const tabs = variants.length > 1
            ? `<div class="tabs"><span>${esc(i18n('Boxes.CityBuilder.Variant'))}:</span>` + variants.map((v, i) =>
                // VariantLabel escapes its own output, the fallback needs it here
                `<button data-t="${i}"${i === shown ? ' class="on"' : ''}>${CityBuilder.VariantLabel(i)
                    || esc((v.stats ? v.stats.roads : '?') + ' ' + i18n('Boxes.CityBuilder.RoadsShort'))}</button>`).join('') + '</div>'
            : '';

        const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>FoE Helper - City Builder - ${esc(CityBuilder.CityOwner())}</title>
<style>
 /* the palette of the helper's own windows: head gradient, beige text, gold */
 body { margin:0; padding:0; color:#ffe7ba; font-size:0.9rem;
   font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
   background:#2a1608;
   background-image:repeating-linear-gradient(90deg,rgba(0,0,0,.16) 0 2px,rgba(255,255,255,.03) 2px 5px),
     linear-gradient(180deg,#3a2010,#2a1608 60%,#201006); }
 .window { max-width:1500px; margin:0 auto; border:1px solid #1a0d05; border-radius:4px; overflow:hidden;
   box-shadow:0 6px 24px rgba(0,0,0,.6); }
 .head { display:flex; justify-content:space-between; align-items:center; padding:6px 10px;
   background:linear-gradient(0deg,#44150a,#48170c,#4c190e,#501b10,#541d12,#581f13,#5d2115,#612316);
   box-shadow:inset 0 1px 0 #652518, inset 0 2px 0 #853427; }
 .head h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.3px; }
 .head .when { font-size:12px; color:#c9a98a; }
 .body { padding:16px; background:linear-gradient(180deg,#4a2a14,#3a2010); }
 .maps { display:flex; gap:16px; flex-wrap:wrap; }
 .map { flex:1 1 520px; min-width:420px; }
 .map h2 { font-size:13px; margin:0 0 6px; font-weight:600; color:#fedc00; text-transform:uppercase; letter-spacing:.6px; }
 .map svg { display:block; width:100%; height:auto; border:1px solid #1a0d05; border-radius:3px; }
 table { border-collapse:collapse; margin-top:18px; font-size:13px; background:rgba(0,0,0,.22); border-radius:3px; }
 th,td { padding:6px 16px; text-align:left; border-bottom:1px solid rgba(0,0,0,.35); }
 th { color:#c9a98a; font-weight:600; }
 td.num { text-align:right; font-variant-numeric:tabular-nums; color:#ffe7ba; }
 .good { color:#8be28b; } .bad { color:#ff8d8d; }
 .legend { margin-top:16px; font-size:12px; color:#c9a98a; }
 .legend span { display:inline-block; margin-right:14px; }
 .legend i { display:inline-block; width:11px; height:11px; margin-right:5px; vertical-align:-1px;
   border-radius:2px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.5); }
 rect.hl { stroke:#fff !important; stroke-width:2 !important; }
 .tabs { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; font-size:12px; color:#c9a98a; }
 .tabs button { font:inherit; color:#ffe7ba; cursor:pointer; padding:4px 10px; border-radius:3px;
   border:1px solid #1a0d05; background:linear-gradient(180deg,#5d2115,#44150a); }
 .tabs button.on { color:#2a1608; font-weight:600; border-color:#fedc00;
   background:linear-gradient(180deg,#ffe87a,#fedc00); }
 .variant[hidden] { display:none; }
</style></head><body>
<div class="window">
<div class="head"><h1>FoE Helper &mdash; City Builder &middot; ${esc(CityBuilder.CityOwner())}</h1>
 <span class="when">${esc(new Date().toLocaleString())} &middot; ${input.buildingsData.length} ${esc(i18n('Boxes.CityMap.BuildingsAmount'))}</span></div>
<div class="body">
${tabs}
${variants.map(panel).join('\n')}
<div class="legend"><span><i style="background:#7ee081"></i>${esc(i18n('Boxes.CityMap.FreeArea'))}</span>${Object.keys(CityBuilder.ExportColors)
    .filter(k => k !== 'generic_building')
    .map(k => `<span><i style="background:${CityBuilder.ExportColors[k]}"></i>${esc(k)}</span>`).join('')}</div>
</div></div>
<script>
(function () {
  var on = null;
  function mark(id, state) {
    if (!id) return;
    var all = document.querySelectorAll('[data-b="' + id + '"]');
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('hl', state);
  }
  document.addEventListener('mouseover', function (e) {
    var id = e.target && e.target.getAttribute && e.target.getAttribute('data-b');
    if (id === on) return;
    mark(on, false);
    on = id;
    mark(on, true);
  });

  // variant switch: every plan is already in the page, only one is shown
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.getAttribute && e.target.getAttribute('data-t');
    if (t === null || t === undefined) return;
    var tabs = document.querySelectorAll('.tabs button');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-t') === t);
    var panels = document.querySelectorAll('.variant');
    for (var j = 0; j < panels.length; j++) panels[j].hidden = panels[j].getAttribute('data-v') !== t;
  });
})();
</script>
</body></html>`;

        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'city-builder-'
            + CityBuilder.CityOwner().replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '')
            + '-' + new Date().toISOString().slice(0, 10) + '.html';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);

        HTML.ShowToastMsg({
            head: i18n('Boxes.CityBuilder.ToastHeadCopyData'),
            text: i18n('Boxes.CityBuilder.ToastBodyExportHtml'),
            type: 'info',
            hideAfter: 4000
        });
    },


    /**
     * Renders the rejected layout on explicit request. It is still not offered
     * as a proposal - but with a single small building missing it is worth a
     * look, so the decision is left to the user.
     */
    ShowAnyway: () => {
        CityBuilder.Data = (CityBuilder.LastFailed && CityBuilder.LastFailed.layout) || [];
        if (!CityBuilder.Data.length) return;
        CityBuilder.showMap();
    },


    /**
     * Human readable log of the last run: what every phase of the winning
     * variant did to the layout. Short enough to paste into a message.
     *
     * @returns {string} the log text
     */
    BuildLog: () => {
        const s = CityBuilder.Stats;
        const input = CityBuilder.LastInput;
        const out = [];

        out.push('=== FoE Helper City Builder log ===');
        out.push('city: ' + CityBuilder.CityOwner() + '  ·  ' + new Date().toLocaleString());

        if (input) {
            // hubs (harbour, oceanic terminal) live on their own maps - the
            // optimizer never places them, so they must not eat the road budget
            let tiles = 0, hubTiles = 0, need1 = 0, need2 = 0, free = 0;
            for (const b of input.buildingsData) {
                const area = b.width * b.height;
                if (['hub_main', 'hub_part', 'off_grid'].includes(b.type)) { hubTiles += area; continue; }
                tiles += area;
                const lvl = b.street_level || 0;
                if (lvl >= 2) need2++; else if (lvl === 1) need1++; else free++;
            }
            const areas = Array.isArray(input.mapData) ? input.mapData : Object.values(input.mapData || {});
            let mapTiles = 0;
            for (const a of areas) mapTiles += (a.width || 0) * (a.length || 0);
            out.push('map ' + mapTiles + ' tiles | placed buildings ' + (need1 + need2 + free) + ' = ' + tiles + ' tiles'
                + ' | need road: ' + need1 + ' (+' + need2 + ' two-lane), roadless: ' + free
                + (hubTiles ? ' | hubs skipped: ' + hubTiles + ' tiles' : ''));
            out.push('road budget = ' + (mapTiles - tiles) + ' tiles (everything left after the buildings)');

            // without usable coordinates the before/after comparison has no
            // "before" - worth knowing before staring at an empty map
            let placed = 0;
            for (const b of input.buildingsData) {
                if (Number.isFinite(b.x) && Number.isFinite(b.y)) placed++;
            }
            if (placed < input.buildingsData.length) {
                out.push('WARNING: only ' + placed + ' of ' + input.buildingsData.length
                    + ' buildings carry usable coordinates - the "current city" map stays empty');
                if (CityBuilder.LastRawShape) {
                    out.push('  raw entity fields: ' + CityBuilder.LastRawShape);
                }
            }
        }

        if (!s) {
            out.push('no result yet');
            return out.join('\n');
        }

        // Translated summary on top: the numbers a player actually wants out of
        // a run, in their own language. Everything below it stays English on
        // purpose - it is the diagnostic trail, and a bug report is worth more
        // when the phase names read the same for everyone.
        {
            const before = CityBuilder.RoadsBefore || 0;
            const pct = before > 0 ? Math.round((1 - s.roads / before) * 100) : 0;
            const total = (s.buildings || 0) + (s.missing || 0);
            const row = (key, value) => out.push('  ' + (i18n(key) + ':').padEnd(30) + value);
            const meta = CityBuilder.SearchMeta || s;
            out.push('--- ' + i18n('Boxes.CityBuilder.Summary') + ' ---');
            row('Boxes.CityBuilder.RoadsBefore', before);
            row('Boxes.CityBuilder.RoadsAfter', s.roads + (before ? '  (' + (s.roads - before > 0 ? '+' : '') + (s.roads - before) + ')' : ''));
            row('Boxes.CityBuilder.Savings', pct + ' %');
            row('Boxes.CityBuilder.SumBuildings', (s.buildings || 0) + ' / ' + total);
            row('Boxes.CityBuilder.SumFree', s.freeTotal);
            row('Boxes.CityBuilder.FreeSquare', s.square + '×' + s.square);
            row('Boxes.CityBuilder.FreeRect', (s.rectW || 0) + '×' + (s.rectH || 0));
            row('Boxes.CityBuilder.FreeScattered', s.freeOutside);
            if (s.missing) row('Boxes.CityBuilder.Unplaced', s.missing);
            row('Boxes.CityBuilder.Variants', meta.runs || 0);
            row('Boxes.CityBuilder.SumTime', Math.round((meta.elapsedMs || 0) / 1000) + ' s');
            if (s.baseline) out.push('  → ' + i18n('Boxes.CityBuilder.SumKeepCity'));
            out.push('');
        }

        out.push('roads before ' + CityBuilder.RoadsBefore + ' -> after ' + s.roads
            + ' | free square ' + s.square + 'x' + s.square
            + ' | biggest free rectangle ' + (s.rectW || 0) + 'x' + (s.rectH || 0)
            + ' | free ' + s.freeTotal + ' (' + s.freeOutside + ' scattered)'
            + ' | missing ' + s.missing + ' | unconnected ' + s.unconnected);
        const meta = CityBuilder.SearchMeta || s;
        if (meta.baselineNote) out.push('current city as a candidate: ' + meta.baselineNote);
        out.push(s.baseline
            ? 'winner: THE CITY AS IT STANDS - none of the ' + (meta.runs || 0) + ' variants beat it'
                + ' in ' + Math.round((meta.elapsedMs || 0) / 1000) + ' s, so the plan is your own layout'
                + (meta.stopped ? ' (stopped early)' : '')
            : 'winner: ' + s.strategy + '/' + s.sortMode + '/' + (s.packMode || '?') + ' seed ' + s.seed
                + ' | town hall ' + (s.placement || 'top-left')
                + ' | reserve ' + (s.reserve || 0) + ' | runs ' + (meta.runs || 0)
                + ' in ' + Math.round((meta.elapsedMs || 0) / 1000) + ' s' + (meta.stopped ? ' (stopped early)' : ''));

        // what the switcher is offering, so a pasted log shows the whole choice
        // and not only the plan that happened to be on screen
        if (CityBuilder.Variants.length > 1) {
            out.push('--- variants on offer ---');
            CityBuilder.Variants.forEach((v, i) => {
                const vs = v.stats || {};
                out.push('  ' + (i === CityBuilder.VariantIndex ? '>' : ' ') + ' '
                    + String(vs.roads).padStart(4) + ' roads | square ' + vs.square + 'x' + vs.square
                    + ' | free ' + String(vs.freeTotal).padStart(3)
                    + ' (' + String(vs.freeOutside).padStart(3) + ' scattered) | '
                    + (vs.baseline ? 'your own layout' : ('town hall ' + (vs.placement || 'top-left'))));
            });
        }

        if (s.trace && s.trace.length) {
            out.push('--- phases of the winning variant ---');
            for (const t of s.trace) {
                out.push(String(t.ms).padStart(6) + ' ms  ' + t.phase.padEnd(18)
                    + ' roads=' + String(t.roads).padStart(4)
                    + ' placed=' + String(t.placed).padStart(4)
                    + (t.note ? '  ' + t.note : ''));
            }
        }

        // what every strategy actually achieved - without it a failed run only
        // shows the winner and never says why the others lost
        if (meta.tried && meta.tried.length) {
            const ok = meta.tried.filter(t => !t.error);
            ok.sort((a, b) => (a.missing + a.unconnected) - (b.missing + b.unconnected) || a.roads - b.roads);
            out.push('--- best variants of ' + ok.length + ' (missing, then roads) ---');
            for (const t of ok.slice(0, 8)) {
                out.push('  ' + (t.strategy + '/' + t.sortMode + '/' + (t.packMode || '?')).padEnd(32)
                    + ' seed ' + String(t.seed).padEnd(5)
                    + ' roads=' + String(t.roads).padStart(4)
                    + ' missing=' + String(t.missing).padStart(3)
                    + ' square=' + String(t.square).padStart(2)
                    + ' reserve=' + (t.reserve || 0));
            }
        }

        if (CityBuilder.Unplaced && CityBuilder.Unplaced.length) {
            out.push('--- unplaced (' + CityBuilder.Unplaced.length + ') ---');
            for (const b of CityBuilder.Unplaced) out.push('  ' + b.name + ' ' + b.width + 'x' + b.height + ' street=' + (b.street_level || 0));
        }

        return out.join('\n');
    },


    /**
     * Copies the diagnostic report to the clipboard, so it can be handed over
     * for analysis without digging through the console.
     */
    CopyReport: (asLog) => {
        const payload = asLog ? CityBuilder.BuildLog() : CityBuilder.BuildReport(true);

        if (!payload) {
            HTML.ShowToastMsg({
                head: i18n('Boxes.CityBuilder.ToastHeadCopyFailed'),
                text: i18n('Boxes.CityBuilder.NoData'),
                type: 'error',
                hideAfter: 5000
            });
            return;
        }

        const text = asLog
            ? payload
            : CityBuilder.BuildLog() + String.fromCharCode(10, 10) + JSON.stringify(payload);

        // the legacy route on purpose: helper.str.copyToClipboard bails out when
        // the document has no focus, and the game canvas holds it
        helper.str.copyToClipboardLegacy(text);

        HTML.ShowToastMsg({
            head: i18n('Boxes.CityBuilder.ToastHeadCopyData'),
            text: i18n(asLog ? 'Boxes.CityBuilder.ToastBodyCopyLog' : 'Boxes.CityBuilder.ToastBodyCopyReport'),
            type: 'info',
            hideAfter: 4000
        });
    },


    /**
     * Saves the diagnostic report as a file - for when the report is too big to
     * paste, or a file is simply easier to hand over than a clipboard buffer.
     */
    SaveReport: () => {
        const report = CityBuilder.BuildReport();
        if (!report) return;
        const blob = new Blob([CityBuilder.BuildLog() + String.fromCharCode(10, 10) + JSON.stringify(report, null, 1)], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'city-builder-report.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    },


    /**
     * Downloads the exact input of the last layout run as JSON: unlocked areas,
     * the building list with sizes and street requirements, and the road tiles
     * of the live city. That is everything the worker itself receives, so the
     * run can be reproduced outside the game - including the baseline phase,
     * which needs the existing roads to know what the layout has to beat.
     *
     * One file per city: collecting a folder of them turns into a bench corpus
     * for judging a heuristic on more than the one city at hand. Also reachable
     * from the console as CityBuilder.DumpInput().
     */
    DumpInput: () => {
        if (!CityBuilder.LastInput || !CityBuilder.LastInput.buildingsData.length) {
            HTML.ShowToastMsg({
                head: i18n('Boxes.CityBuilder.ToastHeadCopyFailed'),
                text: i18n('Boxes.CityBuilder.NoData'),
                type: 'error',
                hideAfter: 5000
            });
            return;
        }

        const b = CityBuilder.LastInput.buildingsData;
        const stats = { buildings: b.length, tiles: 0, needRoad: 0, needTwoLane: 0, roadless: 0 };
        for (const it of b) {
            stats.tiles += it.width * it.height;
            if ((it.street_level || 0) >= 2) stats.needTwoLane++;
            else if ((it.street_level || 0) === 1) stats.needRoad++;
            else stats.roadless++;
        }
        console.log('CityBuilder input:', stats);

        const payload = {
            v: 1,
            note: 'FoE Helper City Builder worker input',
            city: CityBuilder.CityOwner(),
            date: new Date().toISOString(),
            mapData: CityBuilder.LastInput.mapData,
            buildingsData: CityBuilder.LastInput.buildingsData,
            // the live city's roads - without them the reproduced run has no
            // floor to beat and reports a saving that does not exist
            roadTiles: CityBuilder.RoadsBeforeTiles,
            roadsBefore: CityBuilder.RoadsBefore
        };

        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // the city in the name, so a folder of these stays sortable and no two
        // cities collide into "input (1).json"
        a.download = 'city-builder-input-'
            + CityBuilder.CityOwner().replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '')
            + '-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);

        HTML.ShowToastMsg({
            head: i18n('Boxes.CityBuilder.ToastHeadCopyData'),
            text: i18n('Boxes.CityBuilder.ToastBodySaveInput'),
            type: 'info',
            hideAfter: 4000
        });
    },


    /**
     * Formats a millisecond duration as m:ss for the remaining-time display
     */
    FormatEta: (ms) => {
        const total = Math.max(0, Math.round(ms / 1000));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    },


    /**
     * Moves the box into its own pop-up window and centers the map there
     */
    PopOut: () => {
        Popup.PopOut('CityBuilderBox', {
            width: 1100,
            height: 580,
            onClose: () => {
                // back in the game: restore the overlay transform from the CSS
                const wrapper = $('#CityBuilderBoxBody .map-grid-wrapper')[0];
                if (wrapper) wrapper.style.transform = '';
            }
        });

        // the box is adopted by the pop-up asynchronously - center the map once it arrived
        let tries = 0;
        const waitForAdopt = setInterval(() => {
            const wrapper = $('#CityBuilderBoxBody .map-grid-wrapper')[0];
            if (wrapper && wrapper.ownerDocument.body.classList.contains('foe-helper-popup')) {
                clearInterval(waitForAdopt);
                CityBuilder.PanX = 0;
                CityBuilder.PanY = 0;
                CityBuilder.fitPopout();
                wrapper.ownerDocument.defaultView.addEventListener('resize', CityBuilder.fitPopout);
                CityBuilder.bindPopoutPan(wrapper.ownerDocument);
            }
            else if (++tries > 150) {
                clearInterval(waitForAdopt);
            }
        }, 100);
    },


    /**
     * Lets the user pan the map in the pop-up window by dragging it with the
     * mouse. The offsets feed into the centering math of fitPopout.
     *
     * @param {Document} doc - The pop-up window's document.
     */
    bindPopoutPan: (doc) => {
        const surface = doc.getElementById('CityBuilderBoxBody');
        if (!surface || surface.dataset.panBound) return;
        surface.dataset.panBound = '1';
        surface.style.cursor = 'grab';

        let dragging = false, lastX = 0, lastY = 0;

        surface.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // leave the zoom slider and other controls alone
            if (e.target.closest('.optimized-city-controls')) return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            surface.style.cursor = 'grabbing';
            e.preventDefault();
        });
        doc.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            CityBuilder.PanX += e.clientX - lastX;
            CityBuilder.PanY += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            CityBuilder.fitPopout();
        });
        doc.addEventListener('mouseup', () => {
            dragging = false;
            surface.style.cursor = 'grab';
        });
    },


    /**
     * Centers the skewed map inside the pop-up window. The default transform
     * constants align the map with the live city behind the box instead, which
     * would leave most of the pop-up empty.
     */
    fitPopout: () => {
        const wrapper = $('#CityBuilderBoxBody .map-grid-wrapper')[0];
        if (!wrapper) return;

        // the top-down view is not skewed onto the game city, so none of the
        // isometric centering math applies - the CSS class does it all
        if (wrapper.classList.contains('flat-view')) {
            wrapper.style.transform = '';
            return;
        }

        if (!wrapper.ownerDocument.body.classList.contains('foe-helper-popup')) {
            wrapper.style.transform = '';
            return;
        }

        const canvas = wrapper.ownerDocument.getElementById('city-builder-canvas');
        const body = wrapper.parentElement;
        if (!canvas || !body) return;

        const scale = parseFloat(wrapper.style.getPropertyValue('--scale')) || 100;
        const sx = scale / 100;
        const sy = 0.25 * scale / 100;
        const tanX = Math.tan(-63.5 * Math.PI / 180);
        const tanY = Math.tan(14 * Math.PI / 180);

        // linear part of skewX(-63.5deg) skewY(14deg) scale(sx, sy), origin 0 0
        const a = (1 + tanX * tanY) * sx, c = tanX * sy;
        const b = tanY * sx, d = sy;

        // bounding box of the transformed canvas corners
        const xs = [], ys = [];
        for (const [px, py] of [[0, 0], [canvas.width, 0], [0, canvas.height], [canvas.width, canvas.height]]) {
            xs.push(a * px + c * py);
            ys.push(b * px + d * py);
        }
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);

        // the translate() runs before the linear part - solve for the offset that
        // centers the map, shifted by the user's drag panning
        const cx = (body.clientWidth - (maxX - minX)) / 2 - minX + CityBuilder.PanX;
        const cy = (body.clientHeight - (maxY - minY)) / 2 - minY + CityBuilder.PanY;
        const det = a * d - b * c;
        const tx = (d * cx - c * cy) / det;
        const ty = (a * cy - b * cx) / det;

        wrapper.style.transform = `skewX(-63.5deg) skewY(14deg) scale(${sx}, ${sy}) translate(${tx}px, ${ty}px)`;
    },


    /**
     * Displays the City Builder map within the container and applies interactive controls.
     *
     * - Retrieves and applies user preferences for scale, opacity and the names option from local storage.
     * - If the data for buildings (`CityBuilder.Data`) is empty, displays a "No Data" message.
     * - Builds the control bar (zoom, opacity, names toggle, remove mode, recalculate) and the map canvas.
     * - Renders the map through the modular canvas renderer and binds the pointer interaction.
     * - All controls are bound directly on their elements, so they keep working in the pop-out window,
     *   including after a recalculation replaced the box content there.
     */
    showMap: () => {

        let storedUnit = parseInt(localStorage.getItem('CityBuilderScale') || 80);
        let storedOpacity = parseFloat(localStorage.getItem('CityBuilderOpacity') || 0.9);
        // top-down view on an opaque background is the readable default: skewed
        // onto the live city the plan is hard to judge and blends into the map
        const flatView = localStorage.getItem('CityBuilderFlatView') !== '0';
        CityBuilder.ShowNames = localStorage.getItem('CityBuilderShowNames') === '1';
        CityBuilder.ShowTooltips = localStorage.getItem('CityBuilderTooltips') !== '0';
        CityBuilder.ShowProgress = localStorage.getItem('CityBuilderProgress') !== '0';
        CityBuilder.Reserve = localStorage.getItem('CityBuilderReserve') || '5x5';
        CityBuilder.ReserveOn = localStorage.getItem('CityBuilderReserveOn') === '1';
        CityBuilder.Optimize = localStorage.getItem('CityBuilderOptimize') === '1';
        CityBuilder.KeepLayout = localStorage.getItem('CityBuilderKeepLayout') === '1';

        if (!CityBuilder.Data || CityBuilder.Data.length === 0) {
            $('#CityBuilderBoxBody').html('<div style="padding:20px;">' + i18n('Boxes.CityBuilder.NoData') + '</div>');
            return;
        }

        let h = [];

        // Zoom Steuerungen oben rechts
        h.push(`<div class="optimized-city-controls">`);
        h.push(`<div class="controls-row">`);

        h.push(`<span>${i18n('Boxes.CityBuilder.Zoom')}: </span>`);
        h.push(`<input type="range" class="scale-slider" name="optimizedcityscale" min="50" max="200" step="1" value="${storedUnit}" />`);
        h.push(`<span class="scale-value">${storedUnit}</span>`);

        // opacity only matters for the in-game overlay - hidden in the pop-up via CSS
        h.push(`<span class="opacity-control">`);
        h.push(`<span style="margin-left:8px">${i18n('Boxes.CityBuilder.Opacity')}: </span>`);
        h.push(`<input type="range" class="opacity-slider" name="opacity" min="0.1" max="1" step="0.05" value="${storedOpacity}" />`);
        h.push(`</span>`);

        h.push(`<label class="flat-view-control"><input type="checkbox" class="flat-view-toggle"${flatView ? ' checked' : ''} /> ${i18n('Boxes.CityBuilder.TopView')}</label>`);

        // the alternatives: fewer roads or more room in one piece, never both
        if (CityBuilder.Variants.length > 1) {
            h.push(`<span class="variant-switch" title="${i18n('Boxes.CityBuilder.VariantHint')}">`);
            h.push(`<span class="variant-label">${i18n('Boxes.CityBuilder.Variant')}:</span>`);
            CityBuilder.Variants.forEach((v, i) => {
                h.push(`<button class="btn btn-slim${i === CityBuilder.VariantIndex ? ' variant-active' : ''}"`
                    + ` onclick="CityBuilder.SelectVariant(${i})">${CityBuilder.VariantLabel(i)}</button>`);
            });
            h.push(`</span>`);
        }

        // hands the plan on screen to the rebuild guide, which walks the player
        // through it band by band in reconstruction mode. Not offered on a
        // visited city: there is no rebuilding someone else's town, and the
        // guide keeps exactly one plan - our own
        if (typeof RebuildGuide !== 'undefined' && (typeof ActiveMap === 'undefined' || ActiveMap !== 'OtherPlayer')) {
            h.push(`<button class="btn btn-slim" onclick="RebuildGuide.UsePlan()" title="${i18n('Boxes.CityBuilder.RebuildGuideHint')}">${i18n('Boxes.CityBuilder.RebuildGuide')}</button>`);
        }

        // diagnostic export: everything needed to reproduce and judge this run
        h.push(`<button class="btn btn-slim" onclick="CityBuilder.ExportHtml()" title="${i18n('Boxes.CityBuilder.ExportHtmlHint')}">${i18n('Boxes.CityBuilder.ExportHtml')}</button>`);
        h.push(`<button class="btn btn-slim" onclick="CityBuilder.CopyReport(false)" title="${i18n('Boxes.CityBuilder.CopyReportHint')}">${i18n('Boxes.CityBuilder.CopyReport')}</button>`);
        h.push(`<button class="btn btn-slim" onclick="CityBuilder.SaveReport()" title="${i18n('Boxes.CityBuilder.SaveReportHint')}">${i18n('Boxes.CityBuilder.SaveReport')}</button>`);
        h.push(`<button class="btn btn-slim" onclick="CityBuilder.DumpInput()" title="${i18n('Boxes.CityBuilder.SaveInputHint')}">${i18n('Boxes.CityBuilder.SaveInput')}</button>`);

        // options: building names on the map, hover tooltips, click-to-remove mode, recalculation
        h.push(`<label class="control-toggle"><input type="checkbox" class="names-toggle"${CityBuilder.ShowNames ? ' checked' : ''} />${i18n('Boxes.CityBuilder.ShowNames')}</label>`);
        h.push(`<label class="control-toggle" title="${i18n('Boxes.CityBuilder.ShowTooltipsHint')}"><input type="checkbox" class="tooltips-toggle"${CityBuilder.ShowTooltips ? ' checked' : ''} />${i18n('Boxes.CityBuilder.ShowTooltips')}</label>`);
        h.push(`<label class="control-toggle" title="${i18n('Boxes.CityBuilder.ShowProgressHint')}"><input type="checkbox" class="progress-toggle"${CityBuilder.ShowProgress ? ' checked' : ''} />${i18n('Boxes.CityBuilder.ShowProgress')}</label>`);
        h.push(`<label class="control-toggle" title="${i18n('Boxes.CityBuilder.EditModeHint')}"><input type="checkbox" class="edit-toggle"${CityBuilder.EditMode ? ' checked' : ''} />${i18n('Boxes.CityBuilder.EditMode')}</label>`);
        h.push(`</div>`);

        // second row: planning options, recalculation and the saved plan
        h.push(`<div class="controls-row">`);
        h.push(`<label class="control-toggle" title="${i18n('Boxes.CityBuilder.ReserveHint')}"><input type="checkbox" class="reserve-toggle"${CityBuilder.ReserveOn ? ' checked' : ''} />${i18n('Boxes.CityBuilder.Reserve')}</label>`);
        h.push(`<input type="text" class="reserve-input" size="3" placeholder="5x5" value="${CityBuilder.Reserve}"${CityBuilder.ReserveOn ? '' : ' disabled'} />`);
        h.push(`<label class="control-toggle" title="${i18n('Boxes.CityBuilder.OptimizeHint')}"><input type="checkbox" class="optimize-toggle"${CityBuilder.Optimize ? ' checked' : ''} />${i18n('Boxes.CityBuilder.Optimize')}</label>`);
        h.push(`<button class="btn optimize-options-btn${CityBuilder.OptionsOpen ? ' open' : ''}" title="${i18n('Boxes.CityBuilder.OptimizeOptions')}">&#9881;</button>`);
        // "Adjust only" belonged to the previous layout engine; this one always plans the whole city
        // h.push(`<label class="control-toggle" title="${i18n('Boxes.CityBuilder.KeepLayoutHint')}"><input type="checkbox" class="keep-toggle"${CityBuilder.KeepLayout ? ' checked' : ''} />${i18n('Boxes.CityBuilder.KeepLayout')}</label>`);
        h.push(`<button class="btn recalc-btn">${i18n('Boxes.CityBuilder.Recalculate')}</button>`);
        h.push(`<button class="btn save-btn" title="${i18n('Boxes.CityBuilder.SavePlanHint')}">${i18n('Boxes.CityBuilder.SavePlan')}</button>`);
        h.push(`<button class="btn image-btn" title="${i18n('Boxes.CityBuilder.ExportImageHint')}">${i18n('Boxes.CityBuilder.ExportImage')}</button>`);
        h.push(`<button class="btn import-btn" title="${i18n('Boxes.CityBuilder.ImportFileHint')}">${i18n('Boxes.CityBuilder.ImportFile')}</button>`);
        if (CityBuilder.SavedAt) {
            h.push(`<span class="saved-plan">${i18n('Boxes.CityBuilder.SavedAt')} ${moment(CityBuilder.SavedAt).format('DD.MM.YY HH:mm')}`);
            h.push(`<span class="delete-plan" title="${i18n('Boxes.CityBuilder.DeletePlan')}">&times;</span></span>`);
        }
        h.push(`</div>`);

        h.push(CityBuilder.optimizeOptionsHtml());

        h.push(`</div>`);

        // road balance top-left: tiles in the live city vs the planned layout
        if (CityBuilder.Stats && CityBuilder.RoadsBefore > 0) {
            const before = CityBuilder.RoadsBefore;
            const after = CityBuilder.Stats.roads;
            const pct = Math.round((1 - after / before) * 100);
            const pctClass = pct >= 0 ? 'saving' : 'extra';
            h.push(`<div class="city-builder-stats">`);
            h.push(`<div>${i18n('Boxes.CityBuilder.RoadsBefore')}: <b>${before}</b></div>`);
            h.push(`<div>${i18n('Boxes.CityBuilder.RoadsAfter')}: <b>${after}</b></div>`);
            h.push(`<div>${i18n('Boxes.CityBuilder.Savings')}: <b class="${pctClass}">${pct} %</b></div>`);
            if (typeof CityBuilder.Planned?.gain === 'number') {
                const gain = CityBuilder.Planned.gain;
                h.push(`<div>${i18n('Boxes.CityBuilder.RatingGain')}: <b class="${gain >= 0 ? 'saving' : 'extra'}">${gain >= 0 ? '+' : ''}${gain}</b></div>`);
            }
            // keep mode: standing buildings the plan moves to another spot
            if (typeof CityBuilder.Stats.moved === 'number') {
                h.push(`<div>${i18n('Boxes.CityBuilder.Moved')}: <b>${CityBuilder.Stats.moved}</b></div>`);
            }
            // spare space: the square the search kept free plus everything that
            // did not fit into one block
            if (CityBuilder.Stats.square) {
                const sq = CityBuilder.Stats.square;
                h.push(`<div>${i18n('Boxes.CityBuilder.FreeSquare')}: <b class="saving">${sq}×${sq}</b></div>`);
                // the block is often wider than it is square - show its real shape
                const rw = CityBuilder.Stats.rectW || 0, rh = CityBuilder.Stats.rectH || 0;
                if (rw * rh > sq * sq) {
                    h.push(`<div>${i18n('Boxes.CityBuilder.FreeRect')}: <b class="saving">${rw}×${rh}</b></div>`);
                }
                const outside = CityBuilder.Stats.freeOutside || 0;
                if (outside > 0) {
                    h.push(`<div>${i18n('Boxes.CityBuilder.FreeScattered')}: <b class="extra">${outside}</b></div>`);
                }
            }
            h.push(`</div>`);
        }

        h.push(`<div class="map-grid-wrapper${flatView ? ' flat-view' : ''}" style="--scale:${storedUnit}; opacity:${storedOpacity};">`);

        // the whole city is drawn onto this canvas, tooltips and clicks
        // included - there is no HTML building layer anymore
        h.push(`<canvas id="city-builder-canvas" class="map-grid-canvas${CityBuilder.EditMode ? ' edit-mode' : ''}"></canvas>`);

        h.push(`</div>`);

        $('#CityBuilderBoxBody').removeClass('msg-state').toggleClass('flat-mode', flatView)
            .html(h.join('')).promise().done(function() {

            CityBuilder.Renderer.render();
            CityBuilder.Interaction.bind($('#city-builder-canvas')[0]);
            CityBuilder.fitPopout();

            $('.scale-slider').on('input', function() {
                let unit = parseFloat($(this).val());
                localStorage.setItem('CityBuilderScale', unit);
                $('#CityBuilderBoxBody .map-grid-wrapper').css('--scale', unit);
                $('.scale-value').text(unit);
                CityBuilder.fitPopout();
            });

            $('.opacity-slider').on('input', function() {
                let val = $(this).val();
                localStorage.setItem('CityBuilderOpacity', val);
                $('#CityBuilderBoxBody .map-grid-wrapper').css('opacity', val);
            });

            // top-down vs. overlay: only a class, the canvas itself is always
            // drawn flat - the isometric look comes from the CSS transform
            $('.flat-view-toggle').on('change', function() {
                const on = $(this).is(':checked');
                localStorage.setItem('CityBuilderFlatView', on ? '1' : '0');
                $('#CityBuilderBoxBody .map-grid-wrapper').toggleClass('flat-view', on);
                $('#CityBuilderBoxBody').toggleClass('flat-mode', on);
                CityBuilder.PanX = 0;
                CityBuilder.PanY = 0;
                CityBuilder.fitPopout();
            });

            $('.names-toggle').on('change', function() {
                CityBuilder.ShowNames = this.checked;
                localStorage.setItem('CityBuilderShowNames', this.checked ? '1' : '0');
                CityBuilder.Renderer.render();
            });

            $('.progress-toggle').on('change', function() {
                CityBuilder.ShowProgress = this.checked;
                localStorage.setItem('CityBuilderProgress', this.checked ? '1' : '0');
                CityBuilder.Renderer.render();
            });

            $('.tooltips-toggle').on('change', function() {
                CityBuilder.ShowTooltips = this.checked;
                localStorage.setItem('CityBuilderTooltips', this.checked ? '1' : '0');
                if (!this.checked && typeof Tooltips !== 'undefined') Tooltips.deactivate();
            });

            $('.edit-toggle').on('change', function() {
                CityBuilder.EditMode = this.checked;
                $('#city-builder-canvas').toggleClass('edit-mode', this.checked);
                // recolor an already active highlight to the new mode
                CityBuilder.Interaction.setHighlight(CityBuilder.Interaction.Hover);
            });

            // free space, optimization and keep mode take effect with the next calculation
            $('.reserve-toggle').on('change', function() {
                CityBuilder.ReserveOn = this.checked;
                localStorage.setItem('CityBuilderReserveOn', this.checked ? '1' : '0');
                $('#CityBuilderBoxBody .reserve-input').prop('disabled', !this.checked);
            });

            $('.reserve-input').on('change', function() {
                const size = CityBuilder.parseReserve(this.value);
                CityBuilder.Reserve = size ? size.join('x') : '5x5';
                this.value = CityBuilder.Reserve;
                localStorage.setItem('CityBuilderReserve', CityBuilder.Reserve);
            });

            $('.optimize-toggle').on('change', function() {
                CityBuilder.Optimize = this.checked;
                localStorage.setItem('CityBuilderOptimize', this.checked ? '1' : '0');
            });

            $('.keep-toggle').on('change', function() {
                CityBuilder.KeepLayout = this.checked;
                localStorage.setItem('CityBuilderKeepLayout', this.checked ? '1' : '0');
            });

            $('.optimize-options-btn').on('click', function() {
                CityBuilder.OptionsOpen = !CityBuilder.OptionsOpen;
                $(this).toggleClass('open', CityBuilder.OptionsOpen);
                $('#CityBuilderBoxBody .optimize-options').toggleClass('closed', !CityBuilder.OptionsOpen);
            });

            $('.optimize-options [data-option]').on('change', function() {
                CityBuilder.Optimizer.setOption(this.dataset.option, this.type === 'checkbox' ? this.checked : this.value);
            });

            $('.keep-list-btn').on('click', () => CityBuilder.showKeepList());

            $('.recalc-btn').on('click', () => CityBuilder.Recalculate());
            $('.save-btn').on('click', () => CityBuilder.savePlan());
            $('.image-btn').on('click', () => CityBuilder.exportImage());
            $('.import-btn').on('click', () => CityBuilder.importFile());
            $('.delete-plan').on('click', () => CityBuilder.deletePlan());

            CityBuilder.showUnplaced();
        });
    },


    /**
     * Builds the options of the building optimization: what stays in the city
     * and what may be taken from the inventory. Every control carries its
     * option name in data-option and is stored on change.
     *
     * @returns {string} HTML of the options panel.
     */
    optimizeOptionsHtml: () => {
        const options = CityBuilder.Optimizer.options();
        const text = (key) => i18n('Boxes.CityBuilder.Option' + key);
        const toggle = (option, key) => `<label class="control-toggle" title="${text(key + 'Hint')}"><input type="checkbox" data-option="${option}"${options[option] ? ' checked' : ''} />${text(key)}</label>`;
        const modes = CityBuilder.Optimizer.LimitedModes
            .map(mode => `<option value="${mode}"${options.limited === mode ? ' selected' : ''}>${text('Limited_' + mode)}</option>`);

        return `<div class="optimize-options${CityBuilder.OptionsOpen ? '' : ' closed'}">`
            + `<div class="options-group"><b>${text('Keep')}</b>`
            + toggle('allies', 'Allies') + toggle('fiveMinutes', 'FiveMinutes') + toggle('happiness', 'Happiness') + toggle('population', 'Population')
            + `<label class="control-toggle" title="${text('LimitedHint')}">${text('Limited')}<select data-option="limited">${modes.join('')}</select></label>`
            + `<button class="btn keep-list-btn" title="${text('KeepListHint')}">${text('KeepList')} (<span class="keep-count">${options.keep.length}</span>)</button>`
            + `</div>`
            + `<div class="options-group"><b>${text('Use')}</b>`
            + toggle('useNeo', 'UseNeo') + toggle('useAscended', 'UseAscended') + toggle('useKits', 'UseKits') + toggle('fill', 'Fill')
            + `<span class="options-note">${text('Note')}</span>`
            + `</div>`
            + `</div>`;
    },


    /**
     * Opens the form for picking the buildings that always stay: one row per
     * building type of the city with a tick, weakest first, and a search
     * field. Ticks are stored right away as the option "keep"; picked types
     * that do not stand in this city stay stored untouched.
     */
    showKeepList: () => {
        if ($('#CityBuilderKeepBox').length > 0) {
            HTML.CloseOpenBox('CityBuilderKeepBox');
            return;
        }

        HTML.Box({
            id: 'CityBuilderKeepBox',
            title: i18n('Boxes.CityBuilder.KeepTitle'),
            auto_close: true,
            dragdrop: true,
            minimize: true,
            resize: true
        });

        const O = CityBuilder.Optimizer;
        const list = O.keepList();
        const shown = new Set(list.map(g => g.entityId));

        let h = [];
        h.push(`<div class="keep-hint">${i18n('Boxes.CityBuilder.KeepHint')}</div>`);
        h.push(`<input type="text" class="keep-search" placeholder="${i18n('Boxes.CityBuilder.KeepSearch')}" />`);
        h.push('<table class="foe-table keep-table"><thead><tr>');
        h.push(`<th></th><th>${i18n('Boxes.CityBuilder.KeepBuilding')}</th><th class="text-right">${i18n('Boxes.CityBuilder.KeepSize')}</th><th class="text-right">${i18n('Boxes.CityBuilder.RatingGain')}</th>`);
        h.push('</tr></thead><tbody>');
        for (const g of list) {
            h.push(`<tr${g.kept ? ' class="kept"' : ''}>`);
            h.push(`<td><input type="checkbox" data-entity="${g.entityId}"${g.kept ? ' checked' : ''} /></td>`);
            h.push(`<td class="fh-tooltip" data-callback_tt="Tooltips.buildingTT" data-meta_id="${g.entityId}">${g.count > 1 ? g.count + '&times; ' : ''}${g.name}</td>`);
            h.push(`<td class="text-right">${g.h}x${g.w}</td>`);
            h.push(`<td class="text-right">${g.score}</td>`);
            h.push('</tr>');
        }
        h.push('</tbody></table>');

        const body = $('#CityBuilderKeepBoxBody');
        body.html(h.join(''));

        // a click anywhere in the row ticks the building
        body.find('tbody tr').on('click', function(e) {
            const tick = $(this).find('input')[0];
            if (e.target !== tick) tick.checked = !tick.checked;
            $(this).toggleClass('kept', tick.checked);

            const picked = body.find('tbody input:checked').map((i, el) => el.dataset.entity).get();
            const keep = O.options().keep.filter(id => !shown.has(id)).concat(picked);
            O.setOption('keep', keep);
            $('.optimize-options .keep-count').text(keep.length);
        });

        body.find('.keep-search').on('input', function() {
            const query = this.value.trim().toLowerCase();
            body.find('tbody tr').each((i, row) => $(row).toggle(row.cells[1].textContent.toLowerCase().includes(query)));
        });
    },


    /**
     * Lists the buildings that are not part of the current layout in an own
     * draggable box: those the optimizer could not fit, and those the user
     * removed from the map by click. Removed buildings can be restored for
     * the next recalculation from here.
     */
    showUnplaced: () => {
        // finish a possibly still-running fade of the box synchronously:
        // HTML.CloseOpenBox removes asynchronously, and while old and new box
        // coexist under the same id, content and drag binding would go to the
        // dying element - the visible box stayed empty and undraggable
        $('#CityBuilderUnplacedBox').stop(true, true);

        const hasUnplaced = CityBuilder.Unplaced && CityBuilder.Unplaced.length > 0;
        const hasRemoved = CityBuilder.Removed && CityBuilder.Removed.length > 0;
        const planned = CityBuilder.Planned;
        const hasPlanned = planned && (planned.removed.length > 0 || planned.added.length > 0);

        if (!hasUnplaced && !hasRemoved && !hasPlanned) {
            if ($('#CityBuilderUnplacedBox').length > 0) HTML.CloseOpenBox('CityBuilderUnplacedBox');
            return;
        }

        // create the box once and reuse it afterward - updates only replace
        // the body content, so position and drag binding survive
        if ($('#CityBuilderUnplacedBox').length === 0) {
            HTML.Box({
                id: 'CityBuilderUnplacedBox',
                title: i18n('Boxes.CityBuilder.Unplaced'),
                auto_close: true,
                dragdrop: true,
                minimize: true,
                resize: true
            });

            // capped to the viewport until the user drags an own size
            const box = $('#CityBuilderUnplacedBox');
            if (localStorage.getItem('CityBuilderUnplacedBoxSize')) box.addClass('sized');
            box.on('resizestart', () => box.addClass('sized'));
        }

        // group identical buildings: name + size -> count (+ instance ids, done
        // copies); groups with open copies come first
        const groupList = (list) => {
            const groups = new Map();
            for (const b of list) {
                const key = b.name + '|' + b.width + 'x' + b.height;
                if (!groups.has(key)) groups.set(key, { ...b, count: 0, done: 0, ids: [] });
                const g = groups.get(key);
                g.count++;
                if (b.done) g.done++;
                g.ids.push(b.id);
            }
            const finished = (g) => g.done === g.count ? 1 : 0;
            return [...groups.values()].sort((a, b) => finished(a) - finished(b) || a.name.localeCompare(b.name));
        };

        // what a magnifier finds: copies standing in the city; buildings that
        // only come from the inventory get none, the map marks them with ★
        const finds = [];
        const findIcon = (g, withFind) => {
            if (!withFind || !BuildingMarker.supported) return '';
            const inCity = g.ids.filter(id => id !== undefined && MainParser.CityMapData?.[id]);
            if (!inCity.length) return '';
            finds.push(inCity);
            return `<span class="find-building" data-find="${finds.length - 1}" title="${i18n('Boxes.CityBuilder.FindInCity')}">${CityBuilder.FindIcon}</span>`;
        };

        // one collapsible section per list, the folded ones are remembered
        let collapsed = [];
        try {
            collapsed = JSON.parse(localStorage.getItem('CityBuilderUnplacedCollapsed') || '[]');
        } catch (e) {
            collapsed = [];
        }
        const section = (key, title, count, extra, rows) => {
            const closed = collapsed.includes(key);
            h.push(`<div class="unplaced-section${closed ? ' closed' : ''}" data-section="${key}">`);
            h.push(`<div class="unplaced-section-head"><span class="chevron"></span><span class="section-title">${title.replace(/:\s*$/, '')}</span><span class="section-count">${count}</span>${extra || ''}</div>`);
            h.push(`<div class="unplaced-section-body"><table class="foe-table unplaced-table"><tbody>${rows.join('')}</tbody></table></div>`);
            h.push('</div>');
        };
        const nameCell = (g, withFind) => `<td><span class="fh-tooltip" data-callback_tt="Tooltips.buildingTT" data-meta_id="${g.asset_id}">${g.name}</span>${findIcon(g, withFind)}</td>`;

        let h = [];

        if (hasUnplaced) {
            const rows = groupList(CityBuilder.Unplaced).map(g => `<tr><td>${g.count}&times;</td>${nameCell(g, true)}<td class="text-right">${g.height}x${g.width}</td></tr>`);
            section('unplaced', i18n('Boxes.CityBuilder.UnplacedHint'), CityBuilder.Unplaced.length, '', rows);
        }

        if (hasRemoved) {
            const rows = groupList(CityBuilder.Removed).map(g => `<tr><td>${g.count}&times;</td>${nameCell(g, true)}<td class="text-right">${g.height}x${g.width}</td>`
                + `<td class="text-right"><span class="removed-restore" title="${i18n('Boxes.CityBuilder.Restore')}" data-restore_id="${g.ids[g.ids.length - 1]}">&#8630;</span></td></tr>`);
            section('removed', i18n('Boxes.CityBuilder.RemovedHint'), CityBuilder.Removed.length, '', rows);
        }

        // building optimization: what leaves the city and what comes from the inventory
        if (hasPlanned) {
            const progress = CityBuilder.planProgress();
            const plannedList = (key, list, hint, isDone, withFind) => {
                if (!list.length) return;
                const asLayout = list.map(b => ({ id: b.id, asset_id: b.entityId, name: b.name, width: b.w, height: b.h, score: b.score, done: isDone(b) }));
                const finished = asLayout.filter(b => b.done).length;
                const rows = groupList(asLayout).map(g => {
                    const open = g.count - g.done;
                    return `<tr${open ? '' : ' class="done"'}>`
                        + `<td>${open ? open + '&times;' : '&#10003;'}${open && g.done ? ` <span class="done-count">&#10003;${g.done}</span>` : ''}</td>`
                        + nameCell(g, withFind)
                        + `<td class="text-right">${g.height}x${g.width}</td><td class="text-right">${g.score}</td></tr>`;
                });
                section(key, hint, asLayout.length - finished, finished ? `<span class="plan-progress">&#10003; ${finished}/${asLayout.length}</span>` : '', rows);
            };
            const template = planned.source === 'template';
            plannedList('planned-removed', planned.removed, i18n(template ? 'Boxes.CityBuilder.TemplateRemoved' : 'Boxes.CityBuilder.PlannedRemoved'), progress.removed, true);
            plannedList('planned-added', planned.added, i18n(template ? 'Boxes.CityBuilder.TemplateAdded' : 'Boxes.CityBuilder.PlannedAdded'), progress.added, false);
        }

        const body = $('#CityBuilderUnplacedBoxBody');
        body.html(h.join(''));

        // restore one instance of the group for the next recalculation
        body.find('.removed-restore').on('click', function() {
            CityBuilder.restoreRemoved($(this).data('restore_id'));
        });

        body.find('.unplaced-section-head').on('click', function() {
            const sec = $(this).parent().toggleClass('closed');
            const key = sec.data('section');
            collapsed = collapsed.filter(k => k !== key);
            if (sec.hasClass('closed')) collapsed.push(key);
            localStorage.setItem('CityBuilderUnplacedCollapsed', JSON.stringify(collapsed));
        });

        body.find('.find-building').on('click', function(e) {
            e.stopPropagation();
            CityBuilder.findBuilding(finds[this.dataset.find], this);
        });
    },


    /** @type {string} magnifier icon of the find buttons */
    FindIcon: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',


    /**
     * Points at the copies of a building standing in the city with the arrow
     * of the building marker. A second click on the same icon turns the
     * marking off again.
     *
     * @param {Array} ids - City ids of the copies.
     * @param {HTMLElement} icon - The clicked icon.
     */
    findBuilding: (ids, icon) => {
        if (!ids) return;
        const active = $(icon).hasClass('active');
        $('#CityBuilderUnplacedBoxBody .find-building.active').removeClass('active');
        BuildingMarker.hide();

        if (!active) {
            BuildingMarker.show(ids);
            $(icon).addClass('active');
        }
    },


    /**
     * Compares the planned swaps with the live city: a building to remove is
     * done once it left the city (stored or sold), a building to add once a
     * copy appeared that was not in the city when the plan was made.
     *
     * @returns {{removed: function(Object): boolean, added: function(Object): boolean}}
     *          Checks per plan entry; `added` consumes one new copy per call.
     */
    planProgress: () => {
        const planned = CityBuilder.Planned;
        const city = MainParser.CityMapData || {};

        // plans saved before the ids were stored: the layout and the removals
        // hold every building id of that time (template layouts have none)
        let known = planned.known;
        if (!known && planned.source !== 'template') {
            known = [...CityBuilder.Variants.flatMap(v => v.layout), ...planned.removed, ...CityBuilder.Removed].map(b => b.id);
        }

        const placed = {};
        if (known) {
            const before = new Set(known.map(String));
            for (const b of Object.values(city)) {
                if (b && !before.has(String(b.id))) placed[b.cityentity_id] = (placed[b.cityentity_id] || 0) + 1;
            }
        }

        return {
            removed: (b) => b.id !== undefined && !city[b.id],
            added: (b) => {
                if (!(placed[b.entityId] > 0)) return false;
                placed[b.entityId]--;
                return true;
            }
        };
    },


    /**
     * Takes a removed building off the exclusion list again. It reappears on
     * the map with the next recalculation, not immediately - its old spot may
     * already be taken by the current layout.
     *
     * @param {number|string} id - Map instance id of the removed building.
     */
    restoreRemoved: (id) => {
        const idx = CityBuilder.Removed.findIndex(b => String(b.id) === String(id));
        if (idx < 0) return;

        CityBuilder.Excluded.delete(CityBuilder.Removed[idx].id);
        CityBuilder.Removed.splice(idx, 1);
        CityBuilder.showUnplaced();
    },


    /**
     * Parses the size of the area to keep free, e.g. "5x5", "4x6" or "5".
     *
     * @param {string} value - User input.
     * @returns {number[]|null} [width, height] or null if empty or invalid.
     */
    parseReserve: (value) => {
        const m = String(value || '').trim().match(/^(\d{1,2})(?:\s*[x×*]\s*(\d{1,2}))?$/i);
        if (!m) return null;
        const w = parseInt(m[1]), h = parseInt(m[2] || m[1]);
        return w > 0 && h > 0 ? [w, h] : null;
    },


    /**
     * Asynchronously merges and processes city map data and entities to construct
     * a dataset for further city calculations in the CityBuilder module.
     *
     * This function dynamically identifies the correct map data based on the
     * active map and validates the existence and types of the required data
     * structures. It ensures invalid or missing data is logged and prevents
     * further processing if encountered.
     *
     * Process:
     * - Iterates through the city map data entries.
     * - Filters out unnecessary or invalid entries such as streets, off-grid, or
     *   out-of-bound instances.
     * - Calculates and validates building dimensions (width, height) and positions
     *   (x, y).
     * - Determines requirements such as street connection levels based on meta
     *   information and building type.
     * - Assembles the processed data into a structure compatible with
     *   CityBuilder.CalculateNewCity.
     *
     * If successful, the processed data is passed to `CityBuilder.CalculateNewCity`
     * for further calculations.
     *
     * Logs error details and displays a user-facing message in case of an issue,
     * such as missing or invalid data.
     *
     * @async
     */
    MergeData: async ()=> {
        let mapData = MainParser.CityMapData;
        const entities = MainParser.CityEntities;

        if (ActiveMap === 'era_outpost') mapData = CityMap.EraOutpost.data;
        else if (ActiveMap === 'guild_raids') mapData = CityMap.QI.data;
        else if (ActiveMap === 'cultural_outpost') mapData = CityMap.CulturalOutpost.data;
        // another player's city is the same kind of data, just not ours
        else if (ActiveMap === 'OtherPlayer') mapData = CityMap.OtherPlayer.mapData;

        if (!mapData || typeof mapData !== 'object' || !entities || typeof entities !== 'object') {
            console.error("Daten nicht gefunden oder ungültig!", {mapData, entities, ActiveMap});
            CityBuilder.ShowFailure(i18n('Boxes.CityBuilder.NoData'));
            return;
        }

        let buildingsInput = [];
        CityBuilder.RoadsBefore = 0;
        CityBuilder.LiveRoads = [];
        CityBuilder.RoadsBeforeTiles = [];
        CityBuilder.LastRawShape = null;

        for (const [id, instance] of Object.entries(mapData)) {
            if (!instance) continue;

            // Filter
            // Another player's entities arrive raw from the game and keep the
            // position in a nested object; our own city is normalised to flat
            // x/y beforehand. Without this the whole city lands on NaN.
            // Our own city is normalised to flat x/y; another player's entities
            // arrive raw from the game and keep the position in `coords`.
            const rawX = instance.x !== undefined ? instance.x : instance.coords?.x;
            const rawY = instance.y !== undefined ? instance.y : instance.coords?.y;
            // The game leaves a coordinate out when it is zero, so everything
            // standing in the first column arrives without an x and everything
            // in the first row without a y. Reading that as "no position" is
            // what kept those buildings out of the "current city" picture - a
            // missing axis is zero as long as the other one is there.
            const hasPos = rawX !== undefined || rawY !== undefined;
            const ix = rawX !== undefined ? rawX : (hasPos ? 0 : undefined);
            const iy = rawY !== undefined ? rawY : (hasPos ? 0 : undefined);
            // Guessing the field name for another player's raw entities cost two
            // wrong attempts - so the first instance without coordinates reports
            // its own shape into the log instead
            if (!hasPos && !CityBuilder.LastRawShape) {
                CityBuilder.LastRawShape = Object.keys(instance).map(k => {
                    const v = instance[k];
                    return k + ':' + (v && typeof v === 'object' ? '{' + Object.keys(v).join(',') + '}' : typeof v);
                }).join(' ');
            }
            // Only explicit negatives are rejected, exactly as before. Missing
            // coordinates must NOT drop the building: they are needed for the
            // "before" picture, never for the planning itself.
            if (ix < 0 || iy < 0) continue;
            if (instance.type === 'off_grid') continue;

            // buildings the user removed from the map stay out of the plan
            if (CityBuilder.Excluded.has(instance.id)) continue;

            // another player's instances carry entityId instead of
            // cityentity_id - without the fallback every single building is
            // dropped and the run starts on an empty city
            const assetId = instance.cityentity_id || instance.entityId;
            const meta = entities[assetId];
            if (!meta) continue;

            // current road tiles of the live city - baseline for the savings
            // display (two-lane pieces count with their full 2x2 footprint)
            if (instance.type === 'street') {
                const sw = parseInt(meta.components?.AllAge?.placement?.size?.x || meta.width || 1);
                const sh = parseInt(meta.components?.AllAge?.placement?.size?.y || meta.length || 1);
                CityBuilder.RoadsBefore += sw * sh;
                CityBuilder.LiveRoads.push({ x: parseInt(ix), y: parseInt(iy), width: sw, height: sh });
                // kept for the before/after export - the plan is only convincing
                // next to the roads it replaces
                CityBuilder.RoadsBeforeTiles.push({ x: parseInt(ix), y: parseInt(iy), width: sw, height: sh });
                continue;
            }

            // Größe ermitteln (Deep Check)
            let b_width = meta.width;
            let b_height = meta.length;

            if (meta.components?.AllAge?.placement?.size) {
                b_width = meta.components.AllAge.placement.size.x;
                b_height = meta.components.AllAge.placement.size.y;
            }

            // Fallback
            if (!b_width) b_width = 1;
            if (!b_height) b_height = 1;

            b_width = parseInt(b_width);
            b_height = parseInt(b_height);
            let b_x = parseInt(ix);
            let b_y = parseInt(iy);

            // Street requirement - same reading order as CityMap.needsStreet(),
            // so both modules agree on which buildings actually need a road.
            // The game data is the only authority here: modern residential and
            // production buildings very often need no road at all, and guessing
            // one from the building type made the layout connect hundreds of
            // buildings that need nothing, which wrecked the road count.
            let reqStreet = meta.requirements?.street_connection_level;

            if (reqStreet === undefined) {
                // legacy buildings carry the requirement as an ability only
                if (Array.isArray(meta.abilities)
                    && meta.abilities.some(a => a.__class__ === 'StreetConnectionRequirementComponent')) {
                    reqStreet = 1;
                }
                if (meta.components?.AllAge?.streetConnectionRequirement !== undefined) {
                    reqStreet = meta.components.AllAge.streetConnectionRequirement.requiredLevel;
                } else if (meta.components?.streetConnectionRequirement !== undefined) {
                    reqStreet = meta.components.streetConnectionRequirement.requiredLevel;
                }
            }

            reqStreet = reqStreet === undefined ? 0 : parseInt(reqStreet);

            // the two exceptions the game itself never leaves unconnected
            if (['greatbuilding', 'main_building'].includes(instance.type) && reqStreet === 0) reqStreet = 1;
            if (instance.type === 'decoration') reqStreet = 0;

            // Chain buildings: pass the chain id and the position inside the chain
            // so the worker can keep the members side by side, left to right
            let chainId = null;
            let chainPos = -1;
            const chainRef = meta.components?.AllAge?.chain?.chainId;
            if (chainRef && MainParser.BuildingChains) {
                const chainMeta = MainParser.BuildingChains[chainRef] || MainParser.BuildingChains[chainRef.toLowerCase()];
                if (chainMeta?.cityEntityIds) {
                    chainPos = chainMeta.cityEntityIds.indexOf(assetId);
                    if (chainPos >= 0) chainId = chainRef;
                }
            }

            buildingsInput.push({
                id: instance.id,
                asset_id: assetId,
                name: meta.name,
                type: instance.type,
                x: b_x,
                y: b_y,
                width: b_width,
                height: b_height,
                street_level: reqStreet,
                chain_id: chainId,
                chain_pos: chainPos,
                // stands in the live city - the keep mode leaves it on its spot
                standing: true
            });
        }

if (!buildingsInput.length) {
            CityBuilder.LastInput = { mapData: null, buildingsData: [] };
            CityBuilder.ShowFailure(i18n('Boxes.CityBuilder.NoBuildings'));
            return;
        }

        // an area kept free on purpose (e.g. for a quest building) is planned
        // like a roadless building and drawn as free space
        const reserve = localStorage.getItem('CityBuilderReserveOn') === '1'
            ? CityBuilder.parseReserve(localStorage.getItem('CityBuilderReserve') || '5x5')
            : null;
        if (reserve) {
            buildingsInput.push({
                id: 'reserved',
                asset_id: null,
                name: i18n('Boxes.CityBuilder.Reserve') + ' ' + reserve.join('x'),
                type: 'reserved',
                x: 0,
                y: 0,
                width: reserve[0],
                height: reserve[1],
                street_level: 0,
                chain_id: null,
                chain_pos: -1
            });
        }

        CityBuilder.Planned = null;

        // building optimization: several layout rounds with swapped buildings
        if (localStorage.getItem('CityBuilderOptimize') === '1' && ActiveMap === 'main') {
            let best = null;
            try {
                best = await CityBuilder.Optimizer.calculate(buildingsInput);
            } catch (e) {
                console.error('CityBuilder: optimization failed', e);
            }
            if (best === undefined || $('#CityBuilderBox').length === 0) return;
            if (best) {
                // city ids at planning time: later ids are new placements
                const known = Object.keys(MainParser.CityMapData);
                for (const v of best.result.variants) v.planned.known = known;
                CityBuilder.Planned = best.plan;
                CityBuilder.Variants = best.result.variants;
                CityBuilder.applyVariant(0);
                return;
            }
        }

        CityBuilder.CalculateNewCity(buildingsInput);
    },


    /**
     * Calculates the new city layout in a web worker and shows the best
     * variants. Errors end up in the box instead of a spinning loader.
     *
     * @param {Object[]} buildingsInput - Worker input of the buildings.
     */
    CalculateNewCity: async (buildingsInput) => {
        const result = await CityBuilder.runWorker(buildingsInput, 0, (pct, data) => {
            const box = $('#CityBuilderBoxBody');
            box.find('.calc-progress').text(pct + '%');
            box.find('.loading-bar-fill').css('width', pct + '%');
            if (!data) return;

            const phaseKey = data.phase === 'square' ? 'PhaseSquare'
                : (data.phase === 'roads' ? 'PhaseRoads' : 'PhaseBase');
            box.find('.calc-phase').text(i18n('Boxes.CityBuilder.' + phaseKey));

            const parts = [];
            parts.push(i18n('Boxes.CityBuilder.Remaining') + ': ' + CityBuilder.FormatEta(data.etaMs || 0));
            parts.push(i18n('Boxes.CityBuilder.Variants') + ': ' + (data.runs || 0));
            if (data.square) {
                parts.push(i18n('Boxes.CityBuilder.FreeSquare') + ': ' + data.square + '×' + data.square);
                parts.push(i18n('Boxes.CityBuilder.RoadsAfter') + ': ' + data.roads);
            }
            box.find('.calc-detail').text(parts.join(' · '));
        });
        // replaced by a newer run or the box was closed
        if (!result || $('#CityBuilderBox').length === 0) return;

        if (result.success) {
            console.log("✅ Fertig!", result.variants[0].stats);
            const stats = result.stats || result.variants[0].stats || null;
            CityBuilder.SearchMeta = {
                runs: stats ? stats.runs : 0,
                elapsedMs: stats ? stats.elapsedMs : 0,
                stopped: stats ? stats.stopped : false,
                baselineNote: stats ? stats.baselineNote : null,
                tried: stats ? stats.tried : null
            };
            // the worker returns the plans nothing beats on roads and free
            // square at once - the recommended one is shown, the others stay
            // switchable
            CityBuilder.Variants = result.variants;
            CityBuilder.applyVariant(result.variantIndex || 0);
            if (typeof RebuildGuide !== 'undefined' && $('#RebuildGuideBox').length) RebuildGuide.Render();
        }
        else if (result.incomplete) {
            // a layout missing buildings cannot be rebuilt in the game, so it
            // is not offered as a proposal - the run is reported as failed and
            // only kept for the diagnostic report
            console.warn("⚠️ Kein vollständiges Layout gefunden", result.stats);

            CityBuilder.Data = [];
            CityBuilder.Unplaced = result.unplaced || [];
            CityBuilder.Stats = result.stats || null;
            CityBuilder.LastFailed = result;
            // a failed run must not leave the previous run's switcher behind
            CityBuilder.Variants = [];
            CityBuilder.VariantIndex = 0;

            const list = (result.unplaced || [])
                .map(b => `<li>${b.name} (${b.width}×${b.height})</li>`)
                .join('');

            $('#CityBuilderBoxBody').addClass('msg-state').html(`<div class="city-builder-incomplete">
                <div class="incomplete-title">${i18n('Boxes.CityBuilder.NoCompleteLayout')}</div>
                <p>${i18n('Boxes.CityBuilder.NoCompleteLayoutHint')}</p>
                <p class="incomplete-count">${i18n('Boxes.CityBuilder.Unplaced')}: <b>${(result.unplaced || []).length}</b>
                    · ${i18n('Boxes.CityBuilder.Variants')}: <b>${result.runs || 0}</b></p>
                <ul class="incomplete-list">${list}</ul>
                <button class="btn btn-slim" onclick="CityBuilder.ShowAnyway()">${i18n('Boxes.CityBuilder.ShowAnyway')}</button>
                <button class="btn btn-slim" onclick="CityBuilder.CopyReport(false)">${i18n('Boxes.CityBuilder.CopyReport')}</button>
                <button class="btn btn-slim" onclick="CityBuilder.SaveReport()">${i18n('Boxes.CityBuilder.SaveReport')}</button>
                <button class="btn btn-slim" onclick="CityBuilder.DumpInput()">${i18n('Boxes.CityBuilder.SaveInput')}</button>
            </div>`);
        }
        else {
            CityBuilder.ShowFailure(result.error);
        }
    },


    /**
     * Stops a running layout search; its pending runWorker() promise resolves with null.
     * The stop button of the progress panel is different: it asks the worker
     * for its best layout so far (StopSearch).
     */
    stopWorker: () => {
        if (CityBuilder.WorkerStop) CityBuilder.WorkerStop();
        else if (CityBuilder.Worker) CityBuilder.Worker.terminate();
        CityBuilder.Worker = null;
        CityBuilder.WorkerStop = null;
    },


    /**
     * Runs one layout search in a web worker.
     *
     * The worker gets the roads of the live city as well: it rebuilds the
     * existing layout from them and refuses to propose anything worse.
     *
     * @param {Object[]} buildingsInput - Worker input of the buildings.
     * @param {number} budgetMs - Search time, 0 for CityBuilder.BudgetMs.
     * @param {function(number, Object)} onProgress - Receives the progress in percent and the full ping.
     * @returns {Promise<Object|null>} Worker result, null when the run was replaced by a newer one.
     */
    runWorker: (buildingsInput, budgetMs, onProgress) => new Promise((resolve) => {
        // stored before the first guard: a run that fails on the map data still
        // has to be reportable
        CityBuilder.LastInput = { mapData: null, buildingsData: buildingsInput };
        CityBuilder.LastError = null;

        const mapData = CityBuilder.liveAreas();

        if (mapData.length === 0) {
            resolve({ success: false, error: i18n('Boxes.CityBuilder.NoAreas') });
            return;
        }

        // a still-running worker from a closed and reopened box must not race
        // this run on the same DOM
        CityBuilder.stopWorker();

        const workerUrl = URL.createObjectURL(new Blob([CityBuilder.WorkerCode], { type: 'application/javascript' }));
        const worker = new Worker(workerUrl);
        CityBuilder.Worker = worker;

        // exact worker input, kept for debugging: CityBuilder.DumpInput()
        // writes it to a file so a layout problem can be reproduced offline
        CityBuilder.LastInput = { mapData: mapData, buildingsData: buildingsInput };

        const finish = (result) => {
            if (CityBuilder.Worker === worker) {
                CityBuilder.Worker = null;
                CityBuilder.WorkerStop = null;
            }
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve(result);
        };
        CityBuilder.WorkerStop = () => finish(null);

        worker.onmessage = (e) => {
            const data = e.data;
            // progress ping while the search is still running
            if (data.progress !== undefined) {
                if (onProgress) onProgress(data.progress, data);
                return;
            }
            // an incomplete layout still carries the one the optimization
            // rounds measure their missing buildings on
            if (data.incomplete && !data.variants && data.layout) {
                data.variants = [{ layout: data.layout, unplaced: data.unplaced, stats: data.stats }];
            }
            finish(data);
        };

        // a worker killed by the browser or failing outside its own try/catch
        // would otherwise leave the spinner spinning forever and leak the blob URL
        worker.onerror = (err) => finish({ success: false, error: (err && err.message) || 'Worker error' });

        worker.postMessage({
            mapData: mapData,
            buildingsData: buildingsInput,
            roadTiles: CityBuilder.RoadsBeforeTiles,
            budgetMs: budgetMs || CityBuilder.BudgetMs
        });
    }),

};
