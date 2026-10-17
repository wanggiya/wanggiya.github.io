# Vehicle visibility and missing Turf fix — 2026-10-16

This is a corrected copy of your uploaded mbta-current-debug(1).zip.

## Install into your existing repository

Extract this ZIP into a temporary folder. Copy these items into the matching places in your existing website repository, allowing replacement:

- index.html
- css/mbta.css
- vendor/ (the whole folder, including the Turf bundle and license)

Keep your other files. Your uploaded JavaScript, Worker configuration, interactions/grid template, logos, datasets and bankruptcy files are unchanged. You do not need to replace them or redeploy the Worker for this fix. This ZIP also contains the rest of your uploaded project if you want to open a complete corrected copy separately.

Restart VS Code Live Server, opening the index.html in the actual website repository folder. Hard-refresh the browser with Ctrl+Shift+R.

Check that this URL now returns JavaScript rather than a 404 page (adjust the port if needed):

http://127.0.0.1:5500/vendor/turf-7.4.0.min.js

In the console, `typeof window.turf` should be `"object"`. Turf is bundled locally, so no npm install or build is needed. Your existing Draw grid handler is still a placeholder, exactly as uploaded; making Turf available does not by itself implement grid drawing.

When the site works, review and commit the fix yourself:

```bash
git diff --check
git add index.html css/mbta.css vendor/
git diff --cached --stat
git commit -m "Fix MBTA vehicle canvas visibility and include Turf assets"
git push
```

Wait for GitHub Pages deployment and hard-refresh the published page too.

## Root cause of invisible vehicles

OpenLayers 10.8.0's stylesheet contains:

```css
.ol-viewport canvas {
  all: unset;
  overflow: hidden;
}
```

That selector has greater specificity than the old `.vehicle-halos` selector. It reset the vehicle canvas's position, stacking and pointer behavior. The animation was drawing vehicle pixels, but opaque basemap tiles covered them. The status counter could therefore report vehicles while none were visible.

The corrected selector is:

```css
.ol-viewport > canvas.vehicle-halos {
  display: block;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}
```

It outranks OpenLayers' reset. The existing DOM ordering then places the canvas above map layers and below popup/control overlays. Pointer events pass through to the map, and canvas-based vehicle picking works again. index.html references the CSS with a new query suffix to avoid reusing the old cached stylesheet.

## Other console messages

The upload referenced vendor/turf-7.4.0.min.js but did not contain a vendor directory. This fix includes Turf 7.4.0 and its MIT license. A 404 HTML error page had caused both the file-not-found message and the JavaScript MIME-type refusal.

index.html now references your existing light MBTA logo as the favicon, avoiding the automatic missing favicon.ico request.

The Canvas2D willReadFrequently message comes from OpenLayers stop hit detection, not our drawing canvas. It is an optimization warning, not a failure. Setting that option on the vehicle canvas would not address OpenLayers' internal readback canvas. No global canvas patches or warning suppression were added.

Browser Tracking Prevention messages can affect optional caching/storage. They do not explain the reproduced canvas-stacking failure, and no browser privacy settings need to be disabled for this fix.

## Verification

The failure was reproduced using your uploaded HTML, CSS and JavaScript with the actual OpenLayers 10.8.0 distribution. Controlled API responses supplied a red vehicle at the map center, and opaque solid-color OSM tile substitutes covered the full map.

Before the fix, the renderer counted one onscreen vehicle but the screenshot's marker-center pixel was the basemap color (180, 200, 205). Computed canvas styles were position: static, z-index: auto, pointer-events: auto.

After the fix, the same pixel was the vehicle's red body (218, 41, 28) in light, dark and reduced-motion modes. Computed styles were position: absolute, z-index: 0, pointer-events: none.

Browser checks also passed for clicking the animated marker, opening its popup, toggling the vehicle layer, opening your interaction and grid-settings panel, and generating a 121-cell test grid with the local Turf bundle. No HTTP 404 responses or JavaScript exceptions occurred during the corrected browser test.

Every uploaded file other than index.html and css/mbta.css was verified byte-for-byte unchanged. The only other project additions are this guide and the vendor files. Live Worker data could not be independently validated from the test environment (a direct probe received HTTP 403), so API-response tests used controlled fixtures. Your Worker URL and deployed service were not changed.

## Bundled Turf provenance

Version: 7.4.0
Bundle: https://cdn.jsdelivr.net/npm/@turf/turf@7.4.0/turf.min.js
License: https://cdn.jsdelivr.net/npm/@turf/turf@7.4.0/LICENSE
Documentation: https://turfjs.org/docs/getting-started
