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
    PanX: 0,
    PanY: 0,
    EditMode: false,
    ShowNames: false,
    ShowTooltips: true,


    /**
     * Initialisiert den Builder
     */
    init: async () => {
        if ($('#CityBuilderBox').length > 0) {
            HTML.CloseOpenBox('CityBuilderBox');
            if ($('#CityBuilderUnplacedBox').length > 0) HTML.CloseOpenBox('CityBuilderUnplacedBox');
            if (CityBuilder.Worker) {
                CityBuilder.Worker.terminate();
                CityBuilder.Worker = null;
            }
            return;
        }

        // reset all planning state on open
        CityBuilder.Data = [];
        CityBuilder.Removed = [];
        CityBuilder.Excluded = new Set();
        CityBuilder.Variants = [];
        CityBuilder.VariantIndex = 0;
        CityBuilder.EditMode = false;
        CityBuilder.Renderer.Highlight = null;
        CityBuilder.Interaction.Hover = null;
        HTML.AddCssFile('city-builder');

        HTML.Box({
            id: 'CityBuilderBox',
            title: i18n('Boxes.CityBuilder.Title'),
            auto_close: true,
            dragdrop: true,
            minimize: true,
            popout: () => CityBuilder.PopOut(),
            resize: true
        });

        CityBuilder.showLoading();

        // Daten sammeln und Berechnung starten
        await CityBuilder.MergeData();
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

        if (!CityBuilder.Data || CityBuilder.Data.length === 0) {
            $('#CityBuilderBoxBody').html('<div style="padding:20px;">' + i18n('Boxes.CityBuilder.NoData') + '</div>');
            return;
        }

        let h = [];

        // Zoom Steuerungen oben rechts
        h.push(`<div class="optimized-city-controls">`);

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
        h.push(`<label class="control-toggle" title="${i18n('Boxes.CityBuilder.EditModeHint')}"><input type="checkbox" class="edit-toggle"${CityBuilder.EditMode ? ' checked' : ''} />${i18n('Boxes.CityBuilder.EditMode')}</label>`);
        h.push(`<button class="btn recalc-btn">${i18n('Boxes.CityBuilder.Recalculate')}</button>`);

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

            $('.recalc-btn').on('click', () => CityBuilder.Recalculate());

            CityBuilder.showUnplaced();
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

        if (!hasUnplaced && !hasRemoved) {
            if ($('#CityBuilderUnplacedBox').length > 0) HTML.CloseOpenBox('CityBuilderUnplacedBox');
            return;
        }

        // create the box once and reuse it afterwards - updates only replace
        // the body content, so position and drag binding survive
        if ($('#CityBuilderUnplacedBox').length === 0) {
            HTML.Box({
                id: 'CityBuilderUnplacedBox',
                title: i18n('Boxes.CityBuilder.Unplaced'),
                auto_close: true,
                dragdrop: true,
                minimize: true
            });
        }

        // group identical buildings: name + size -> count (+ instance ids)
        const groupList = (list) => {
            const groups = new Map();
            for (const b of list) {
                const key = b.name + '|' + b.width + 'x' + b.height;
                if (!groups.has(key)) groups.set(key, { ...b, count: 0, ids: [] });
                const g = groups.get(key);
                g.count++;
                g.ids.push(b.id);
            }
            return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
        };

        let h = [];

        if (hasUnplaced) {
            h.push(`<div class="unplaced-hint">${i18n('Boxes.CityBuilder.UnplacedHint')}</div>`);
            h.push('<table class="foe-table unplaced-table"><tbody>');
            for (const g of groupList(CityBuilder.Unplaced)) {
                h.push('<tr>');
                h.push(`<td>${g.count}&times;</td>`);
                h.push(`<td class="fh-tooltip" data-callback_tt="Tooltips.buildingTT" data-meta_id="${g.asset_id}">${g.name}</td>`);
                h.push(`<td class="text-right">${g.height}x${g.width}</td>`);
                h.push('</tr>');
            }
            h.push('</tbody></table>');
        }

        if (hasRemoved) {
            h.push(`<div class="unplaced-hint">${i18n('Boxes.CityBuilder.RemovedHint')}</div>`);
            h.push('<table class="foe-table unplaced-table"><tbody>');
            for (const g of groupList(CityBuilder.Removed)) {
                h.push('<tr>');
                h.push(`<td>${g.count}&times;</td>`);
                h.push(`<td class="fh-tooltip" data-callback_tt="Tooltips.buildingTT" data-meta_id="${g.asset_id}">${g.name}</td>`);
                h.push(`<td class="text-right">${g.height}x${g.width}</td>`);
                h.push(`<td class="text-right"><span class="removed-restore" title="${i18n('Boxes.CityBuilder.Restore')}" data-restore_id="${g.ids[g.ids.length - 1]}">&#8630;</span></td>`);
                h.push('</tr>');
            }
            h.push('</tbody></table>');
        }

        $('#CityBuilderUnplacedBoxBody').html(h.join(''));

        // restore one instance of the group for the next recalculation
        $('#CityBuilderUnplacedBoxBody .removed-restore').on('click', function() {
            CityBuilder.restoreRemoved($(this).data('restore_id'));
        });
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

        if (ActiveMap === 'era_outpost') mapData = CityMap.EraOutpostData;
        else if (ActiveMap === 'guild_raids') mapData = CityMap.QIData;
        else if (ActiveMap === 'cultural_outpost') mapData = CityMap.CulturalOutpostData;
        // another player's city is the same kind of data, just not ours
        else if (ActiveMap === 'OtherPlayer') mapData = CityMap.OtherPlayer.mapData;

        if (!mapData || typeof mapData !== 'object' || !entities || typeof entities !== 'object') {
            console.error("Daten nicht gefunden oder ungültig!", {mapData, entities, ActiveMap});
            CityBuilder.ShowFailure(i18n('Boxes.CityBuilder.NoData'));
            return;
        }

        let buildingsInput = [];
        CityBuilder.RoadsBefore = 0;
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
                chain_pos: chainPos
            });
        }

        if (!buildingsInput.length) {
            CityBuilder.LastInput = { mapData: null, buildingsData: [] };
            CityBuilder.ShowFailure(i18n('Boxes.CityBuilder.NoBuildings'));
            return;
        }

        CityBuilder.CalculateNewCity(buildingsInput);
    },


    /**
     * Calculates and constructs a new city layout using web workers.
     *
     * This method takes a set of building inputs and processes the city layout based on the unlocked map areas.
     * It leverages a web worker to offload the computation for asynchronous processing. If successful, the
     * method updates the city data and renders the city map. In case of an error, it logs the message
     * and displays the error output in the UI.
     *
     * @param {Object} buildingsInput - The input data representing the buildings to be included in the city layout.
     */
    CalculateNewCity: (buildingsInput)=> {

        // stored before the first guard: a run that fails on the map data still
        // has to be reportable
        CityBuilder.LastInput = { mapData: null, buildingsData: buildingsInput };
        CityBuilder.LastError = null;

        const mapData = (ActiveMap === 'OtherPlayer' && CityMap.OtherPlayer.unlockedAreas)
            ? CityMap.OtherPlayer.unlockedAreas
            : CityMap.Main.unlockedAreas;

        if (!mapData || (Array.isArray(mapData) && mapData.length === 0) || (typeof mapData === 'object' && Object.keys(mapData).length === 0)) {
            console.error("Keine freigeschalteten Gebiete gefunden!", mapData);
            CityBuilder.ShowFailure(i18n('Boxes.CityBuilder.NoAreas'));
            return;
        }

        // a still-running worker from a closed and reopened box must not race
        // this run on the same DOM
        if (CityBuilder.Worker) {
            CityBuilder.Worker.terminate();
            CityBuilder.Worker = null;
        }

        const blob = new Blob([CityBuilder.WorkerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl);
        CityBuilder.Worker = worker;

        console.log("🚀 Starte Stadt-Erstellung mit Worker...");

        // exact worker input, kept for debugging: CityBuilder.DumpInput()
        // writes it to a file so a layout problem can be reproduced offline
        CityBuilder.LastInput = { mapData: mapData, buildingsData: buildingsInput };

        // the search is time-boxed; the user can cut it short with the stop
        // button, which makes the worker return its best layout so far
        worker.postMessage({
            mapData: mapData,
            buildingsData: buildingsInput,
            // the roads of the live city: the worker rebuilds the existing
            // layout from them and refuses to propose anything worse
            roadTiles: CityBuilder.RoadsBeforeTiles,
            budgetMs: CityBuilder.BudgetMs
        });

        const finish = () => {
            if (CityBuilder.Worker === worker) CityBuilder.Worker = null;
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
        };

        worker.onmessage = function(e) {
            const data = e.data;

            // progress ping while the search is still running
            if (data.progress !== undefined) {
                const box = $('#CityBuilderBoxBody');
                box.find('.calc-progress').text(data.progress + '%');
                box.find('.loading-bar-fill').css('width', data.progress + '%');

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
                return;
            }

            if (data.success) {
                console.log("✅ Fertig!", data.variants[0].stats);

                // Daten uebernehmen statt herunterladen
                CityBuilder.Data = data.layout;
                CityBuilder.Unplaced = data.unplaced || [];
                CityBuilder.Stats = data.stats || null;

                // the alternatives the search found: fewer roads or a bigger
                // free square, never both. Only worth a switcher when there is
                // really something to switch between.
                CityBuilder.Variants = (data.variants && data.variants.length > 1) ? data.variants : [];
                CityBuilder.VariantIndex = data.variantIndex || 0;
                CityBuilder.SearchMeta = {
                    runs: data.stats ? data.stats.runs : 0,
                    elapsedMs: data.stats ? data.stats.elapsedMs : 0,
                    stopped: data.stats ? data.stats.stopped : false,
                    baselineNote: data.stats ? data.stats.baselineNote : null,
                    tried: data.stats ? data.stats.tried : null
                };

                // Karte anzeigen - through applyVariant whenever there is a
                // list to switch between, so a variant switch and the first
                // draw take exactly the same path
                if (CityBuilder.Variants.length > 1) {
                    CityBuilder.applyVariant(CityBuilder.VariantIndex);
                } else {
                    CityBuilder.showMap();
                }

            } else if (data.incomplete) {
                // a layout missing buildings cannot be rebuilt in the game, so it
                // is not offered as a proposal - the run is reported as failed and
                // only kept for the diagnostic report
                console.warn("⚠️ Kein vollständiges Layout gefunden", data.stats);

                CityBuilder.Data = [];
                CityBuilder.Unplaced = data.unplaced || [];
                CityBuilder.Stats = data.stats || null;
                CityBuilder.LastFailed = data;
                // a failed run must not leave the previous run's switcher behind
                CityBuilder.Variants = [];
                CityBuilder.VariantIndex = 0;

                const list = (data.unplaced || [])
                    .map(b => `<li>${b.name} (${b.width}×${b.height})</li>`)
                    .join('');

                $('#CityBuilderBoxBody').addClass('msg-state').html(`<div class="city-builder-incomplete">
                    <div class="incomplete-title">${i18n('Boxes.CityBuilder.NoCompleteLayout')}</div>
                    <p>${i18n('Boxes.CityBuilder.NoCompleteLayoutHint')}</p>
                    <p class="incomplete-count">${i18n('Boxes.CityBuilder.Unplaced')}: <b>${(data.unplaced || []).length}</b>
                        · ${i18n('Boxes.CityBuilder.Variants')}: <b>${data.runs || 0}</b></p>
                    <ul class="incomplete-list">${list}</ul>
                    <button class="btn btn-slim" onclick="CityBuilder.ShowAnyway()">${i18n('Boxes.CityBuilder.ShowAnyway')}</button>
                    <button class="btn btn-slim" onclick="CityBuilder.CopyReport(false)">${i18n('Boxes.CityBuilder.CopyReport')}</button>
                    <button class="btn btn-slim" onclick="CityBuilder.SaveReport()">${i18n('Boxes.CityBuilder.SaveReport')}</button>
                    <button class="btn btn-slim" onclick="CityBuilder.DumpInput()">${i18n('Boxes.CityBuilder.SaveInput')}</button>
                </div>`);

            } else {
                CityBuilder.ShowFailure(data.error);
            }
            finish();
        };

        // a worker killed by the browser or failing outside its own try/catch
        // would otherwise leave the spinner spinning forever and leak the blob URL
        worker.onerror = function(err) {
            CityBuilder.ShowFailure((err && err.message) || 'Worker error');
            finish();
        };
    },

};
