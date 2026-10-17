/** Small dependency-free color utilities shared by controls and the map. */
export const COLOR_PRESETS = {
  warm: { label: 'Yellow → orange → red', colors: ['#ffffcc', '#fd8d3c', '#bd0026'] },
  viridis: { label: 'Purple → teal → yellow', colors: ['#440154', '#21918c', '#fde725'] },
  diverging: { label: 'Blue → white → red', colors: ['#2166ac', '#f7f7f7', '#b2182b'] },
  blue: { label: 'Light blue → dark blue', colors: ['#e0f3f8', '#08589e'] },
};
export function hexToRgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Use a six-digit RGB color.');
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
export function rgbToHex(rgb) {
  if (rgb.length !== 3 || !rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
    throw new Error('RGB values must be whole numbers from 0 to 255.');
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}
export function makePalette(colors, count = 7) {
  if (![2, 3].includes(colors.length)) throw new Error('Choose two or three colors.');
  const anchors = colors.map(hexToRgb);
  if (!Number.isInteger(count) || count < 2) throw new Error('Invalid color count.');
  return Array.from({ length: count }, (_, i) => {
    const progress = (i / (count - 1)) * (anchors.length - 1);
    const left = Math.min(anchors.length - 2, Math.floor(progress));
    const fraction = progress - left;
    return rgbToHex(
      anchors[left].map((v, j) => Math.round(v + (anchors[left + 1][j] - v) * fraction)),
    );
  });
}
export function rgba(hex, alpha) {
  return `rgba(${hexToRgb(hex).join(',')},${alpha})`;
}
export function colorEditor(id, label, initial) {
  const rgb = hexToRgb(initial);
  return `<fieldset class="grid-color-editor" id="${id}"><legend>${label}</legend>
    <div class="grid-color-row"><input type="color" value="${initial}" aria-label="${label} color picker">
    ${['R', 'G', 'B'].map((channel, i) => `<label>${channel}<input type="number" data-channel="${i}" min="0" max="255" step="1" value="${rgb[i]}" aria-label="${label} ${channel}"></label>`).join('')}</div></fieldset>`;
}
export function bindColorEditor(element, onChange) {
  const well = element.querySelector('input[type="color"]');
  const channels = [...element.querySelectorAll('[data-channel]')];
  function set(hex, notify = false) {
    well.value = rgbToHex(hexToRgb(hex));
    hexToRgb(well.value).forEach((v, i) => {
      channels[i].value = v;
      channels[i].setCustomValidity('');
    });
    if (notify) onChange(well.value);
  }
  well.addEventListener('input', () => set(well.value, true));
  channels.forEach((input) =>
    input.addEventListener('input', () => {
      const values = channels.map((field) =>
        field.value === '' ? NaN : field.valueAsNumber,
      );
      channels.forEach((field, i) =>
        field.setCustomValidity(
          Number.isInteger(values[i]) && values[i] >= 0 && values[i] <= 255
            ? ''
            : 'Enter a whole number from 0 to 255.',
        ),
      );
      if (values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
        well.value = rgbToHex(values);
        onChange(well.value);
      }
    }),
  );
  return { set, get: () => well.value };
}
