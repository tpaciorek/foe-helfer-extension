# City Builder bench

Real cities to measure the City Builder layout search against, plus the harness
that runs it outside the browser. A heuristic that helps one city routinely hurts
another, so nothing here should be judged on a single city — several changes have
been reverted this way already.

Not loaded by the extension at runtime. Nothing in `js/` refers to it.

## Folders

### `reports/` — rebuilt from the **Copy report** button

Compact diagnostic reports. They carry the unlocked map areas and the building
list (grouped by name and size), which is enough to reconstruct the packing
problem — that is how every city here was made.

What they do **not** carry: the coordinates of the buildings and the road tiles of
the live city. So a run reproduced from a report has no baseline: the search
cannot rebuild "the city as it stands", cannot use it as the floor, and cannot
polish it. `roadsBefore` is only a number to compare against.

### `inputs/` — dumped with the **Save input** button (preferred)

The exact worker input: `{city, date, mapData, buildingsData, roadTiles,
roadsBefore}`, with `buildingsData` carrying `x`/`y`. This is strictly better than
a report — it reproduces the whole run including the baseline phases.

To add one: open the City Builder on a city, press **Zapisz wsad / Save input**,
drop the downloaded file here. The file name already carries the city and date.

## Tools

Both read a city from `reports/` or `inputs/` and figure out which shape it is.

    node tools/bench.js reports/xsenka.json          # variant sweep, ~1 run/1.5 s
    node tools/search.js reports/xsenka.json         # the real 90 s search

`bench.js` sweeps strategy x sort x pack x town-hall position for one city and
prints roads, square, scattered free tiles and missing buildings per variant.
Use it to judge a heuristic.

`search.js` runs the actual worker end to end and prints the variant list the
switcher would show. Use it to judge the search as a whole — a heuristic that
looks good in `bench.js` can still lose because the budget goes elsewhere.

Both work by extracting the `WorkerCode:` template literal from
`js/web/city-builder/js/city-builder.js` and evaluating it in a `vm` context, so
they always test the current source with no build step.

## The cities

| file | buildings | map | fill | road buildings | player's roads |
|---|---|---|---|---|---|
| `pacior.json` | 428 | 4240 | 95.4% | 55 | 119 |
| `rigunia.json` | 310 | 3632 | 94.5% | 57 | 125 |
| `ellihou.json` | 371 | 3792 | 93.2% | 86 | 176 |
| `xsenka.json` | 228 | 4240 | 94.7% | 78 | 152 |
| `pr0n.json` | 369 | 4224 | 96.8% | — | — |

They are deliberately different problems. `pacior` has 372 roadless buildings to
plug gaps with; `xsenka` has 150 against 78 road buildings, so its spare space
stays open and five 3x3 buildings end up homeless. `pr0n` is nearly full and only
fits at all with the town hall centred.
