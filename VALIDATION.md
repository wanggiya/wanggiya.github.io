# Validation — continuous valid-report playback, 2026-10-14

Passed:
- Syntax and readable-code formatting checks for the movement module and map integration.
- Pure motion tests: persistent clock/velocity, no animation restart when a valid or duplicate report arrives, continued short-gap motion, three-report rolling history, bounded projection followed by a hold, and STOPPED_AT handling.
- Chromium with the full previously live-fetched MBTA network snapshot and controlled vehicle packets. Consecutive displayed coordinates were sampled every 250ms across repeated polls and continued advancing. Duplicate packets, null coordinates, missing source timestamps, zero coordinates, and an entirely empty feed preserved valid history and did not reset the clock.
- New valid reports shift the oldest of three samples; raw mode snaps to actual latest reported coordinates; pause/resume freezes/resumes the display; temporary omissions retain markers; persistent omissions remove the marker, history and playback state.
- Stale sources hold the current display rather than snap backward after a void update. Desktop/mobile checks found no uncaught page errors or overflow.
- Bankruptcy files, original datasets and Worker remain byte-for-byte unchanged.

Limits:
- Browser vehicle packets are controlled fixtures. Actual continuity depends on source cadence and device rendering capacity; the animation targets approximately 30fps.
- Smooth mode includes short, decaying speed-based estimates after the latest observed point, capped at 15 seconds of projected source time. It is not reported GPS and does not follow road/rail geometry. Stationary/stopped vehicles do not project. Extended gaps hold rather than drift indefinitely.
- Authenticated user deployment has not been tested. No git commits, pushes or deployments were made.

Install:
- Extract over the current site and refresh with Ctrl+Shift+R after deployment.
- js/config.js is excluded to preserve the working Worker URL.
- No Worker changes are required; js/vehicle-motion.js is included and must be deployed with the updated js/mbta.js.
