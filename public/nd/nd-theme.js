// Nerdesign v1.0.1 – optional light/dark/auto toggle. Copied from github.com/nerdegutt/nerdesign – do not edit here; change the source and copy again.
// Optional theme toggle: auto / light / dark. Sets data-theme on <html>,
// remembers the choice in localStorage ("nd-theme") and dispatches an
// `nd:theme` CustomEvent (detail: { theme, resolved }) that nd-echarts.js listens to.
//
// Usage:
//   <script type="module">
//     import { ndTheme } from './nd/nd-theme.js';
//     ndTheme.init();                         // applies stored choice, no UI
//     ndTheme.mount(document.querySelector('#theme'));   // renders a 3-state control
//   </script>
// To avoid a flash on load, inline this before your stylesheet:
//   <script>try{var t=localStorage.getItem('nd-theme');if(t&&t!=='auto')document.documentElement.dataset.theme=t}catch(e){}</script>

const KEY = 'nd-theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function read() { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } }
function write(v) { try { v === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, v); } catch { /* private mode */ } }

export const ndTheme = {
  get() { return read(); },
  /** 'light' | 'dark' – what is actually showing. */
  resolved() { const t = read(); return t === 'auto' ? (media && media.matches ? 'dark' : 'light') : t; },
  set(theme) {
    write(theme);
    if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    document.dispatchEvent(new CustomEvent('nd:theme', { detail: { theme, resolved: this.resolved() } }));
    for (const el of document.querySelectorAll('.nd-theme-toggle')) syncControl(el, theme);
  },
  init() { this.set(read()); media?.addEventListener('change', () => { if (read() === 'auto') this.set('auto'); }); },
  /** Render a radio-group control into `el` (labels in Norwegian). */
  mount(el) {
    el.classList.add('nd-theme-toggle');
    el.innerHTML = `<fieldset><legend class="nd-sr-only">Fargetema</legend>` +
      [['auto', 'Auto'], ['light', 'Lyst'], ['dark', 'Mørkt']].map(([v, l]) =>
        `<label><input type="radio" name="nd-theme" value="${v}"><span>${l}</span></label>`).join('') + `</fieldset>`;
    el.addEventListener('change', (e) => { if (e.target.name === 'nd-theme') this.set(e.target.value); });
    syncControl(el, read());
  },
};
function syncControl(el, theme) { for (const i of el.querySelectorAll('input[name="nd-theme"]')) i.checked = i.value === theme; }
