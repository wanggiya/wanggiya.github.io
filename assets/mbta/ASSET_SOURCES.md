# Official MBTA icon sources

These SVG files are downloaded copies of assets in MBTA's own website repository:
https://github.com/mbta/dotcom/tree/main/priv/static/icon-svg

| Local file | Intended use | Source |
|---|---|---|
| `mbta-logo.svg` | Header T logo | https://github.com/mbta/dotcom/blob/main/priv/static/icon-svg/mbta-logo.svg |
| `icon-mode-subway-green.svg` | Light rail / Green Line | https://github.com/mbta/dotcom/blob/main/priv/static/icon-svg/icon-mode-subway-green.svg |
| `icon-mode-subway-default.svg` | Subway | https://github.com/mbta/dotcom/blob/main/priv/static/icon-svg/icon-mode-subway-default.svg |
| `icon-mode-commuter-rail-default.svg` | Commuter rail | https://github.com/mbta/dotcom/blob/main/priv/static/icon-svg/icon-mode-commuter-rail-default.svg |
| `icon-mode-bus-default.svg` | Bus | https://github.com/mbta/dotcom/blob/main/priv/static/icon-svg/icon-mode-bus-default.svg |
| `icon-mode-bus-silver.svg` | Silver Line | https://github.com/mbta/dotcom/blob/main/priv/static/icon-svg/icon-mode-bus-silver.svg |
| `icon-mode-ferry-default.svg` | Ferry | https://github.com/mbta/dotcom/blob/main/priv/static/icon-svg/icon-mode-ferry-default.svg |

Downloaded 2026-10-14. The original SVG contents are preserved. These assets are included for manual replacement; the current letter icons have not been changed automatically.

## Replace the header manually

In `index.html`, replace `<span class="t-mark">T</span>` with:

```html
<img class="official-mbta-logo" src="assets/mbta/mbta-logo.svg" alt="MBTA">
```

Add to `css/mbta.css`:

```css
.official-mbta-logo {
  width: 36px;
  height: 36px;
  background: white;
  border-radius: 50%;
}
```

## Replace a mode icon manually

In `js/mbta.js`, add `iconUrl` to the relevant object in `MODES`, for example:

```js
iconUrl: 'assets/mbta/icon-mode-bus-default.svg',
```

Inside `buildControls()`, replace the block starting with `const icon = line(mode.icon, label, 'span')` with:

```js
const icon = document.createElement('img');
icon.src = mode.iconUrl;
icon.alt = ''; // The neighboring mode name is already accessible.
icon.className = 'official-mode-icon';
label.append(icon);
```

Set `iconUrl` for every mode before making that change. Add `.official-mode-icon { width: 25px; height: 25px; }` to the CSS. This preserves the mode checkbox and adjacent text.

## Theme-specific header PNGs

The app now uses these local filenames directly:

| Theme | File | Provenance |
|---|---|---|
| Light | `mbta-secondary-logo-circle.png` | Higher-resolution 360×360 official MBTA website asset, originally named `mbta-logo-t.png`, copied under the requested filename: https://github.com/mbta/dotcom/blob/main/priv/static/images/mbta-logo-t.png . |
| Dark | `mbta-secondary-logo-circle-filled.png` | Locally rendered 360×360 filled-circle variant using the unchanged official T path from `mbta-logo.svg`; editable source is `mbta-secondary-logo-circle-filled.svg`. This is not an original downloaded MBTA filled PNG. |

You can replace either PNG in place if you have the original brand master files. `applyTheme()` in `js/mbta.js` selects the corresponding file. `mbta-logo-t.png` is also included as a higher-resolution 360×360 light-logo option, downloaded from https://github.com/mbta/dotcom/blob/main/priv/static/images/mbta-logo-t.png .

The preceding manual header-replacement instructions describe the former letter icon; they are optional. The current HTML already contains `<img id="mbta-brand-logo">`.

The exact-named public MWRTA 25×25 source is retained as `mbta-secondary-logo-circle-original-25.png` for reference: https://mwrta.com/application/files/3217/4465/6079/mbta-secondary-logo-circle.png . The displayed light logo uses the high-resolution official copy to avoid pixelation.
