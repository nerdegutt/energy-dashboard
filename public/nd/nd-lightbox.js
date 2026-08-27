// Nerdesign v1.0.1 – PhotoSwipe lightbox for every image; expects ./vendor/photoswipe/. Copied from github.com/nerdegutt/nerdesign – do not edit here; change the source and copy again.
// Nerdesign lightbox: every image in a gallery, figure card, hero or two-column
// block opens in PhotoSwipe (self-hosted, MIT) – no markup changes needed.
//
//   <script type="module">
//     import { ndLightbox } from './nd/nd-lightbox.js';
//     ndLightbox();                 // defaults: .nd-gallery, .nd-figure-card, .nd-hero, .nd-two-col, [data-nd-zoom]
//   </script>
//
// The full-size source is `data-full` on the <img> if present, else `src`.
// Natural size is read from `data-w`/`data-h` if present, else from the image
// when it has loaded (PhotoSwipe needs dimensions to animate). The caption is
// the nearest <figcaption> or .nd-caption. Images with `data-nd-zoom="false"`
// are left alone. Expects ./vendor/photoswipe/ next to this file.
const here = new URL('.', import.meta.url);

export async function ndLightbox({
  selector = '.nd-gallery img, .nd-figure-card img, .nd-hero img, .nd-two-col img, [data-nd-zoom] img, img[data-nd-zoom]',
  root = document,
  gallery = 'body',
} = {}) {
  const imgs = [...root.querySelectorAll(selector)].filter((img) => img.dataset.ndZoom !== 'false' && !img.closest('a'));
  if (!imgs.length) return null;
  for (const img of imgs) {
    const a = document.createElement('a');
    a.className = 'nd-zoom';
    a.href = img.dataset.full || img.currentSrc || img.src;
    const setSize = () => { a.dataset.pswpWidth = img.dataset.w || img.naturalWidth; a.dataset.pswpHeight = img.dataset.h || img.naturalHeight; };
    if (img.complete && img.naturalWidth) setSize(); else img.addEventListener('load', setSize, { once: true });
    if (img.dataset.w) setSize();
    a.setAttribute('aria-label', `Vis større: ${img.alt || 'bilde'}`);
    img.replaceWith(a); a.appendChild(img);
  }
  const { default: PhotoSwipeLightbox } = await import(new URL('vendor/photoswipe/photoswipe-lightbox.esm.min.js', here));
  const lightbox = new PhotoSwipeLightbox({
    gallery, children: 'a.nd-zoom',
    pswpModule: () => import(new URL('vendor/photoswipe/photoswipe.esm.min.js', here)),
    closeTitle: 'Lukk', zoomTitle: 'Zoom', arrowPrevTitle: 'Forrige', arrowNextTitle: 'Neste', errorMsg: 'Bildet kunne ikke lastes',
    bgOpacity: 0.92, padding: { top: 24, bottom: 64, left: 24, right: 24 },
  });
  lightbox.on('uiRegister', () => {
    lightbox.pswp.ui.registerElement({
      name: 'nd-caption', order: 9, isButton: false, appendTo: 'root',
      html: '',
      onInit: (el, pswp) => {
        el.className = 'pswp__nd-caption';
        pswp.on('change', () => { el.textContent = captionFor(pswp.currSlide?.data?.element); });
      },
    });
  });
  lightbox.init();
  return lightbox;
}
function captionFor(a) {
  if (!a) return '';
  const fig = a.closest('figure'); const cap = fig?.querySelector('figcaption') || a.parentElement?.querySelector('.nd-caption');
  return cap ? cap.textContent.trim().replace(/\s+/g, ' ') : (a.querySelector('img')?.alt || '');
}
