# H3 grid update — 2026-10-19

This is a complete copy of your uploaded `mbta-before-h3.zip`, with H3 added alongside the four existing metric grids. S2 is not included in this update.

## Install and use

Unzip into a temporary folder. Copy these changed/new files into the matching locations in your existing project:

- `index.html`
- `css/mbta.css`
- `css/grid-tools.css`
- `js/config.js` (only explanatory comments changed; your public Worker URL is preserved)
- `js/grid-tools.js`
- `js/interactions.js`
- `js/grid-worker.js`
- `js/grid-h3.js` (new)
- `vendor/h3-js-4.5.0.es.js` (new, locally bundled dependency)
- `vendor/H3-LICENSE.txt` (new)
- `README_H3_UPDATE.md` (this document)
- `tests/h3-grid.test.mjs` (new, optional local verification)
- `README.md` (adds a link to this document)

Alternatively, copy the complete extracted folder into your working project. Keep your existing `.git` directory. No Worker deployment or API-key change is needed. No npm installation is required for the static website. Hard-refresh the page with Ctrl+Shift+R after copying.

Open **Interactions → Draw grid / choose area → Grid type → H3 hexagonal index**. Start at resolution **8**; choose a lower number for larger cells or a higher number for smaller cells. The supported UI range is 5–11. Choose the current view, draw a rectangle/polygon, or use visible-network coverage, then click **Draw grid**.

Your heatmap, outline thickness/color, custom color ramps, cell inspection, weights and automatic vehicle analysis also work with H3. Auto-update vehicles recalculates using existing reports; it does not follow the camera or issue additional MBTA requests. Recalculate retains the drawn grid and its resolution; visible-network mode regenerates the occupied footprint. Click Draw grid to apply changes to the grid controls.

Whole H3 cells intersecting the selected area are included, even if their centers are outside it. Enable clipping for strict view/drawn boundaries. In visible-network mode, cells containing shown lines/stops/vehicles are retained, including line crossings; the extent is not used as a strict clipping mask.

## What H3 changes

H3 supplies stable geographic cell IDs and a hierarchical hexagonal index. It is different from the existing local-meter hexagons. H3 cells do not have identical edge lengths or identical areas. Full-cell densities use `h3.cellArea(cellId, 'km2')`; clipped fragments use their geographic polygon area calculated by Turf. A clipped polygon retains the original H3 ID for reference, but it is only part of that cell.

The existing regional analyzer assigns points once, clips route segments against cells in local ENU meters, and applies the same weighted score. It does not use a separate H3 point-count cache. Route lengths remain regional local-meter approximations, not globally exact geodesic lengths. Cell analysis stays within 250 km of Boston, with a 5,000 candidate-cell limit and a conservative bounding-box preflight guard to prevent excessive allocation. Select a smaller area or lower resolution if the limit appears. No cells are silently discarded to satisfy that limit.

H3 generation and analysis run in a Web Worker. The local H3 module loads only for H3 work, outside the animation loop. Adding H3 does not itself improve vehicle animation or MBTA GPS reporting frequency.

## Why the page does not say “no backend”

The frontend now shows **Static frontend · browser-side analysis**, with an expandable explanation. GitHub Pages serves the files, and map/grid computation runs in the browser. A Cloudflare Worker is a small serverless backend that protects the API key and proxies MBTA requests. Thus the precise description is **no dedicated application server or database**, rather than no backend at all.

The bankruptcy map and vehicle-filter/animation code are unchanged.

## REFRESH_MS and animation

`export const REFRESH_MS = 15000;` in `js/config.js` means a default vehicle-data polling interval of 15,000 milliseconds, or 15 seconds. It is not a frame interval, a 15-second page reload, or a limit of one animation frame every 15 seconds.

- **Polling:** obtains new vehicle reports from the Worker/MBTA. Requests and pagination take time, so completion-to-completion spacing can be longer than the selected interval.
- **Animation:** `requestAnimationFrame(animate)` renders estimated positions between GPS updates, subject to screen refresh, browser scheduling and device performance. It does not fetch data each frame.
- **Saved preference:** the page's interval input/slider saves `mbta-refresh-seconds` in browser localStorage. That saved choice overrides the config default. Change the slider/input to change the active interval. Changing the config default alone will not replace an existing saved choice.
- **Accuracy:** requesting faster does not guarantee fresher MBTA reports. Duplicate report timestamps are ignored. Smoothing intentionally buffers filtered positions and may lag; animation is an estimate, not additional measured GPS data. Shorter polling can reduce the presentation delay, but does not remove upstream feed latency.
- **Visibility/pause:** polling pauses when the tab is hidden or live updates are off.

A 10–15 second interval is a reasonable starting point for this showcase. Use the existing controls to compare responsiveness and request load; do not lower it merely to increase animation FPS.

## Should you move to Vercel?

Not necessary for H3, S2, or smooth animation. GitHub Pages plus your existing Worker already supports this architecture. A hosting change alone does not reduce browser drawing work or increase MBTA report frequency.

Vercel is useful if you want automatic branch/pull-request preview deployments, or later want server-side functionality through Vercel Functions. You could use Vercel for previews while keeping the production GitHub Pages site and the existing Worker. There is no need to add a second proxy now. If you eventually replace the Worker with a Vercel Function, keep the MBTA key in server-side environment variables; never embed it in a frontend bundle or public build-time variable.

Official references:
- https://github.com/uber/h3-js
- https://h3geo.org/docs/api/regions/
- https://h3geo.org/docs/core-library/restable/
- https://vercel.com/docs/projects/deploy-from-cli
- https://vercel.com/docs/functions

## Validation

Run from the project folder with a recent Node.js version:

```bash
node tests/h3-grid.test.mjs
node tests/grid-analysis.test.mjs
node tests/color-auto.test.mjs
```

These passed: H3 IDs/rings/areas, stop and vehicle counts, route clipping, clipped-area conservation, tiny masks, occupied network coverage, stable IDs, density/regional guards, 12 existing metric-analysis suites, and color/scheduler suites. Node may print a module-type warning because the original package.json does not declare ESM; it does not indicate a test failure. The existing package setup has been preserved.

A Chromium browser check also passed using controlled MBTA fixtures: H3 module-worker loading, type/resolution controls, clipped and whole grids, visible-network scope, color ramps, auto analysis without extra API requests or camera movement, switching back to metric squares, dark/mobile layout, and no JavaScript errors. This verifies frontend behavior; it is not a validation of the live MBTA feed or production Worker. The local browser check used fixture basemap handling rather than testing live tile delivery.

## Review, commit and push yourself

First preview locally, for example:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 and try H3, your original grids, colors, vehicle toggles, and the bankruptcy map.

Then review and stage only the intended update:

```bash
git status --short
git diff --check
git add index.html css/mbta.css css/grid-tools.css js/config.js js/grid-tools.js js/interactions.js js/grid-worker.js js/grid-h3.js vendor/h3-js-4.5.0.es.js vendor/H3-LICENSE.txt tests/h3-grid.test.mjs README.md README_H3_UPDATE.md
git diff --cached --stat
git diff --cached
git commit -m "Add H3 analysis grids and explain static site architecture"
git push
```

No commit, push, hosting migration or deployment was performed while preparing this ZIP.
