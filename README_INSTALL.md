# Grid styling and automatic vehicle analysis — 2026-10-16

## Install

Keep your working metric grid/density site, including the small-area segment-limit fix. Extract this ZIP into a temporary folder.

Copy all four files in its js/ folder into your website's js/ folder:

- interactions.js (replace)
- grid-tools.js (replace)
- grid-colors.js (new)
- grid-auto.js (new)

Replace css/grid-tools.css with the included version. Keep js/grid-math.js, js/grid-worker.js, js/mbta.js, the tracking modules, vendor/, your public configuration and all other site files. No HTML edit, npm installation or Cloudflare Worker deployment is needed.

Restart your preview server and hard-refresh with Ctrl+Shift+R. Draw a grid before inspecting its new styles. If you added personal tools to interactions.js after the last update, merge those additions into the replacement before committing.

## Switches

Show heatmap is a sliding On/Off switch with aligned state text. It starts On. Off hides filled coloring and disables the measure/color-scale/opacity controls, while keeping the grid outlines and calculated cell values. Cell inspection works in both states.

Auto-update vehicles is a separate sliding On/Off switch. It starts Off. This means automatic refresh of the grid's vehicle-analysis snapshot, as requested; it is not camera following.

When enabled, it watches changes to the existing vehicle source and relevant layer choices. It coalesces the many feature events from one feed update, waits at least 800 ms for the event burst to settle, and starts at most one analysis job every 10 seconds. Only one automatic job can run at a time, and it waits for manual work instead of interrupting it. No frame-by-frame analysis or extra MBTA API fetch is added.

It recalculates the snapshot using the current weights and layer selections, retaining the selected metric/style. This recomputes the analysis consistently, not just a visual marker overlay. In network-union coverage it can update the occupied-cell footprint. In viewport/drawn coverage it uses the existing grid, not a new moving viewport boundary. It never changes the map center or zoom.

Turn it Off to stop future automatic jobs and abort any currently running automatic worker job. Existing results remain. Manual Recalculate still works. Clearing the grid leaves the auto switch On if selected, waiting for another grid; it does not recreate a cleared grid. Hidden tabs and paused live updates suspend automatic analysis; the status text explains the wait. A new feed/source event or resume notification wakes it again. Without new data it does not repeatedly run the same job on a fixed interval.

Displayed filtered vehicle positions are still used, with the existing smoothing delay. This does not turn the heatmap into GPS truth or change stale-vehicle exclusion. Local worker/script requests may occur normally; the MBTA request count does not increase.

## Grid-line appearance

Open Draw grid / choose area -> Grid line appearance.

- The color well opens the browser's native color picker. Its exact palette/wheel UI depends on your browser/OS.
- R, G and B number fields accept whole numbers from 0 to 255. Editing the fields or picker synchronizes the other representation.
- Line thickness has matching slider and numeric input, from 0 to 8 screen pixels in 0.1-pixel steps. Zero hides the outline.

Changes apply immediately to an existing grid; they do not recalculate or move it. Your chosen line color and width stay the same when toggling the heatmap or light/dark theme. Heatmap opacity controls only the cell fill, so it does not fade your custom outline. Appearance settings currently last for the page session; this update does not add preference persistence across reloads.

## Heatmap color sets

Open Cell heatmap / analysis -> Heatmap color ramp.

Presets:

- Yellow / orange / red
- Purple / teal / yellow
- Blue / white / red
- Light blue / dark blue

Choose two color stops for minimum/maximum, or three for minimum/middle/maximum. Each stop has its own color picker and R/G/B fields. Changing any stop selects Custom. Switching from three to two hides the middle editor; switching back retains its last value. Presets can reset the stops and stop-count together.

The ramp preview and legend update immediately. Seven display classes are sampled from the selected ramp, with exact minimum and maximum anchor colors and an exact middle anchor in three-color mode. Between anchors, RGB channels interpolate linearly. Each cell still has one computed value and a single fill color. Logarithmic scaling changes the value-to-color mapping; in that mode the middle color is halfway along the log1p scale, not necessarily half the maximum raw value. Zero-value cells remain transparent.

Colors are display choices, not new density measurements. Very similar custom colors can make differences hard to see. The preset with a white midpoint is a diverging palette; use it thoughtfully because these density measures have no inherent positive/negative reference point.

## Preview checklist

1. Draw a grid and open the heatmap panel. Verify the heatmap switch and aligned On/Off text.
2. Turn Auto-update vehicles On, wait for new vehicle data and watch its status/snapshot time. Turn it Off and confirm you can still recalculate manually.
3. Change line width with the number input and slider; confirm both agree.
4. Change a line RGB value, then use the picker; verify synchronization.
5. Try a preset, then a custom two-color and three-color ramp. Verify preview and legend.
6. Switch theme and inspect a cell. Keep the current map position and layer selections.

## Prepare Git commit and push

No commit, push or deployment has been performed for you. From your existing repository:

```bash
git status --short
git diff --check
```

If all previous updates are already committed, stage only this update:

```bash
git add js/interactions.js js/grid-tools.js js/grid-colors.js js/grid-auto.js css/grid-tools.css
```

If you have not committed the earlier website updates yet, stage the related current site files together instead:

```bash
git add index.html css/ js/ vendor/
```

Choose one staging command, then inspect the result:

```bash
git diff --cached --stat
git diff --cached
```

Do not stage the downloaded ZIP, backups, node_modules, or API secrets. Your js/config.js contains only the public Worker URL/refresh settings and is safe to include in this project as currently designed. To unstage an unintended file, use git restore --staged PATH.

When ready:

```bash
git commit -m "Add custom grid colors line styling and automatic vehicle analysis"
git push
```

Wait for your usual GitHub Pages deployment, then hard-refresh the published site. If Git reports an upstream or remote error, resolve that message using your actual branch/remote; do not force-push.

## Code and verification

- grid-colors.js: validated RGB/hex conversion, preset definitions, seven-color interpolation, and synchronized editor bindings.
- grid-auto.js: bounded event-driven scheduler, pause/readiness checks, one in-flight analysis, and abort on Off.
- grid-tools.js: configurable map styles, independent fill opacity, and abortable analysis jobs.
- interactions.js: UI controls and subscription to existing vehicle-source changes.
- css/grid-tools.css: scoped switches, RGB editors, paired slider/number fields and mobile layout.

Run the new dependency-free tests from this extracted folder with Node 18+:

```bash
node tests/color-auto.test.mjs
```

They verify RGB validation and exact palette anchors, opt-in/readiness behavior, 800 ms coalescing, the 10-second start limit, pause handling, waiting for manual work, one in-flight job, abort on Off and cleanup.

Existing metric/density/browser regressions still pass. Additional browser checks passed for actual paired thickness and color inputs, accessible sliding switch state, presets, two/three-color custom ramps, exact anchor colors in the legend, opacity/theme preservation of outlines, and opt-in automatic updates. The browser test coalesced 500 vehicle-source events into one refresh, verified no extra MBTA API calls and no camera movement, and confirmed no refresh after Off. Mobile width and no browser JavaScript exceptions were checked. API/basemap inputs were controlled fixtures; actual deployment/network/device performance still depends on your environment.
