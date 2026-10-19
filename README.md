# MBTA Transit Atlas — continuous valid-report playback

The default page is the MBTA interactive map. The bankruptcy map remains at `bankruptcy.html`, unchanged from the previous edition. The old `/pages/mbta.html` address redirects to the landing page.

## Update your working site

1. Extract this ZIP into your existing site repository root, replacing matching files. The ZIP deliberately omits `js/config.js`, preserving your configured Worker URL.
2. Your Worker can stay as it is if you deployed the previous Controls/Template edition: this update changes no Worker behavior. The included Worker is reformatted for readability and still supports bulk network data and a 1-second vehicle cache.
3. Preview the site, then commit and push yourself when ready. After Pages deployment, reload with Ctrl+Shift+R.

For a fresh install only, copy `js/config.example.js` to `js/config.js` and enter your public Worker base URL there. The old browser-specific Worker URL, if set in the first edition, is still recognized. The URL entry form has been removed from the map interface.

Preview locally: run `python3 -m http.server 8000` in the site directory, then open http://localhost:8000/ . Opening the HTML as a `file://` URL is not supported because it uses JavaScript modules. No npm build is necessary for GitHub Pages.

## What the controls mean

| Control | Behavior |
|---|---|
| Show all | Enables every mode, every route, and all three layer types. Renamed from “All modes.” |
| Hide all | Hides all transportation modes, while retaining individual route choices. Renamed from “Clear.” |
| Zoom to lines | Fits the view to the currently selected visible lines. It does not change selections. Renamed from “Fit network.” |
| Lines / Stops / Vehicles at the top | Changes that layer type in every mode simultaneously. A mixed state appears when individual modes differ. |
| Mode's Lines / Stops / Vehicles | Changes only that mode, and updates the top control's checked/mixed state. |
| Live updates On / Off | Starts or stops polling. Off retains the last displayed positions and disables manual refresh. Returning On fetches immediately. |
| Refresh interval | Enter a whole number or use the slider: 1–300 seconds (5 minutes). Both controls, the footer text, and countdown stay synchronized. Default 15; saved for this browser. |
| Refresh vehicles now | Fetches all vehicle positions together immediately, bypassing the browser's HTTP cache. It does not request the network geometry again. |
| Retry missing lines / stops | Retries only incomplete static route data after a failure. Nothing is requested when all routes loaded successfully. Useful after a timeout or temporary API failure; usually unnecessary once the network is complete. |
| Appearance: Light / Dark | Separate buttons near the top of the right panel, visible even when scrolling. Changes the MBTA interface and basemap together; saved for this browser. The bankruptcy map is unaffected. |
| Interactions | Temporarily logs `interaction template works fine`; no panel opens. |

The interval is the wait between completed fetches; request duration and MBTA's own reporting cadence add to the age of displayed data. A faster interval cannot create newer positions if MBTA has not reported them. The countdown indicates the next request, while each vehicle popup shows the age of its MBTA timestamp.

## Why requests and motion are different now

Previously routes were fetched together and all vehicles were fetched together, but shapes/stops were fetched per route. At 179 routes that meant roughly 358 additional initial requests, before pagination. Static data was cached; those requests were not repeated every 15 seconds.

Now `/routes` includes `route_patterns.representative_trip.shape` and `route_patterns.representative_trip.stops`. The browser distributes the included resources to the routes using MBTA's relationship IDs. In the tested network this covered all 179 routes in one response (about 6.3 MB uncompressed). Pagination remains supported. Stops/shapes describe representative trips of each route pattern; supplemental unrepresented geometries are not fetched routinely. Routes with incomplete representative resources fall back to targeted `/shapes` and `/stops` requests.

Every polling cycle still requests **all vehicles together**, with pagination only if the API supplies a next page. For a single-page vehicle response, a 5-second interval is about 12 requests/minute per viewer, and a 15-second interval about 4. Multiple visitors and other apps using the key share its quota; shared Worker caching reduces upstream calls but is not a strict global rate limiter. Static responses are cached in the browser for 24 hours and at the Worker for 6 hours.

The prior marker updates jumped directly to each new report, and the pulse advanced at coarse intervals. This version continuously plays valid source timestamps and uses bounded velocity estimates through brief gaps, with smoother halos drawn only for in-view fresh vehicles. It does not extrapolate motion or claim tracking between MBTA reports. Large discontinuities jump immediately. Reduced-motion preferences disable halos and transitions. Stale or unknown timestamps turn gray after 90 seconds. Stops and geometry are added in batches, with rendering yields during bulk loading.

## Styling and grouping

Mattapan is grouped under **Subway** as requested, keeping its actual MBTA route ID and source route type (MBTA categorizes it as light rail). Individual route checkboxes are indented 12px relative to their mode header checkbox. Bus and Orange Line geometries have a thin black casing outside their original color. Live controls and action buttons share consistent heights and alignment.

Dark mode recolors only the basemap canvas, not the transit overlays, so MBTA line colors stay recognizable. It uses the existing OpenStreetMap source and visible attribution, requiring no additional basemap account or key.

`CNAME` still contains `dimimap.org`. Keep it only if you control and want that domain. The bankruptcy map, its JavaScript and all original datasets are preserved.

## Validation

See `VALIDATION.md`. No deployments, account changes, commits, pushes or DNS changes were made. Your authenticated Worker deployment must be tested after you install the new Worker code.

## Interaction template (temporarily console-only)

Clicking **Interactions** performs only `console.log("interaction template works fine")`. It opens no panel and performs no map operation. The click handler is in `js/interactions.js`, with a marked location for your future code. The existing map remains accessible through the exported `interactionContext` in `js/mbta.js` when you are ready to integrate your older functions.

## Continuous valid-report playback

The previous edition retained three samples but still started an endpoint animation after a fetch. It could reach that endpoint and stop, and a partial response could remove/recreate a vehicle. This edition separates the continuous animation clock from API polling.

Each vehicle retains the last **three valid source reports** (`L(n-2t)`, `L(n-t)`, `L(n)`). An empty/invalid fetch is not a new sample. Missing coordinates, zero/null locations, missing timestamps, stale ordering, and cached duplicates cannot replace a valid location or reset playback. New valid source samples shift the oldest point out. Corrections sharing a timestamp replace that sample.

`js/vehicle-motion.js` owns the playback model. `recordPosition()` keeps the three-sample history. `createPlayback()` creates one persistent clock, displayed position, and speed per vehicle. `advancePlayback()` runs every animation frame, using cubic interpolation through valid report timestamps and a critically damped position filter. This clock and speed state survive new packets, repeated packets, and void packets; there is no new animation start per poll.

Source interval is estimated from the valid source timestamps, not from the last fetch attempt. Small clock-rate adjustments absorb reporting jitter. During short gaps after the latest observed point, a velocity estimate from the recent valid samples provides limited continuation. It decays to zero and holds after at most 15 seconds of projected source time. This is explicitly **estimated motion**, not a claim that MBTA reported those coordinates. `STOPPED_AT` vehicles and stationary source samples do not project forward. Stale displays become gray and hold rather than jump backward after a void update.

**Smooth movement On** enables this continuous buffered/estimated display. **Off** immediately snaps to the latest MBTA-reported coordinates and clears playback state. Source history is still collected, so switching back On can reuse valid points. Pausing updates freezes the display clock; a hidden browser tab pauses playback/polling. Reduced-motion preferences disable movement.

A partial response no longer instantly deletes a missing vehicle. Absence must persist for 30–120 seconds, depending on polling interval, before the marker, three reports, and playback state are removed. A completely empty feed preserves the last known data and shows an explicit warning. Stale source timestamps remain visible in popups and turn markers gray. History cannot grow beyond three reports per tracked vehicle.

Interpolation/projection does not follow route geometry and may cut corners. Extended outages cannot be turned into trustworthy continuous tracking; projection is bounded, and raw mode always shows the last reported location. Very large GPS discontinuities reset the buffer instead of inventing a path across them.

## Contrast styling

- Light mode: bus stops have a thin black outer ring outside the original route-colored ring.
- Dark mode: Red/Mattapan, Green/light rail, commuter rail, Blue, and Silver Line have thin white outer strokes on their lines and stops.
- Dark mode: Green/light rail, Blue, and Silver Line stop centers are light gray (`#d9e0e5`). Commuter rail stop centers remain white.
- Silver Line is identified using MBTA's real route metadata (for example ID `741` has short name `SL1`); its numeric route IDs are preserved.
- Shared stops use the first selected visible route's styling. Disabling that route allows another selected serving route to determine the style.

## Readable code and icons

`js/mbta.js`, `js/interactions.js`, the Worker, the MBTA HTML and CSS have been formatted for reading and editing. The map module has section comments separating API/cache code, controls, styling, and movement. Styling rules are in `appearanceFor()` / `styleFor()`. Outlined stops use a single SVG symbol in `outlinedStopImage()` so decluttering does not discard the outer ring. The pure history/velocity/playback helpers are in `js/vehicle-motion.js`; map integration is in `receiveVehiclePosition()`, `snapToReportedPositions()`, `setSmoothMovement()`, and `animate()`. The former per-fetch transition path has been removed.

Official MBTA SVG logo/mode assets are included in `assets/mbta/` for your manual replacement. See `assets/mbta/ASSET_SOURCES.md` for the verified source URLs and exact replacement examples. The header now switches between the requested PNG filenames with the theme. Mode letter icons remain available for manual replacement. The dark PNG is a locally rendered filled-circle variant of the official MBTA SVG T path; see asset provenance below.

For a 1-second interval, a single-page vehicle feed can use roughly 60 browser requests/minute per viewer. The Worker has a 1-second shared vehicle cache; MBTA's source timestamps may update less frequently. Faster polling cannot create new reports.


## H3 grid update

See [README_H3_UPDATE.md](README_H3_UPDATE.md) for H3 controls, installation, polling versus animation, architecture and Vercel notes, validation, and commit instructions.
