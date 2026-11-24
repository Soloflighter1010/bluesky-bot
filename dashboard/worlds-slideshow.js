'use strict';

{
  const banner = document.getElementById('archive-slideshow');
  const frame = banner.querySelector('.archive-photo-frame');
  const controls = banner.querySelector('.archive-photo-controls');
  const playback = document.getElementById('cover-playback');
  const count = document.getElementById('cover-count');
  const status = document.getElementById('cover-status');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const slideDuration = 7000;
  const first = frame.querySelector('img');
  const slides = [
    [first.src, first.alt, '24%'],
    ['/brand/covers/neon-portrait.webp', 'A green and orange avatar under neon lights', '32%'],
    ['/brand/covers/pool-float.webp', 'A pink avatar lounges on a pool float by a waterfall', '34%'],
    ['/brand/covers/group-photo.webp', 'A group of VRChat avatars pose together in a decorated room', '50%'],
    ['/brand/covers/blue-moon.webp', 'An avatar in dark armor against a blue moon', '38%'],
    ['/brand/covers/checkered-floor.webp', 'VRChat avatars pose on a checkered floor', '50%'],
    ['/brand/covers/nightclub.webp', 'An avatar with red and black hair in a nightclub', '32%'],
    ['/brand/covers/garden-portrait.webp', 'A dark-haired avatar sits in a garden', '42%'],
    ['/brand/covers/blue-portrait.webp', 'Close-up of an avatar with blue hair and a purple nose', '38%'],
  ];

  let active = 0;
  let target = 0;
  let request = 0;
  let timer;
  let playing = !reducedMotion.matches;
  let hovering = false;
  let focusPaused = false;

  function canRotate() {
    return playing && !document.hidden && !hovering && !focusPaused;
  }

  function schedule() {
    clearTimeout(timer);
    if (canRotate()) timer = setTimeout(() => move(1), slideDuration);
  }

  function updateControls() {
    playback.textContent = playing ? 'Pause' : 'Play';
    playback.setAttribute('aria-label', playing ? 'Pause slideshow' : 'Play slideshow');
    count.textContent = `${active + 1} / ${slides.length}`;
  }

  function setPlaying(enabled) {
    playing = enabled;
    if (enabled) {
      focusPaused = false;
    } else {
      request++;
      target = active;
    }
    updateControls();
    schedule();
  }

  async function move(step, manual = false) {
    clearTimeout(timer);
    const currentRequest = ++request;
    const index = (target + step + slides.length) % slides.length;
    target = index;

    const [src, alt, crop] = slides[index];
    const image = new Image();
    image.alt = alt;
    image.style.setProperty('--cover-crop', crop);
    image.src = src;
    try {
      await image.decode();
    } catch {
      if (currentRequest !== request) return;
      if (manual) status.textContent = 'This cover photo could not load.';
      schedule();
      return;
    }

    if (currentRequest !== request) return;
    if (!manual && !canRotate()) {
      target = active;
      return;
    }

    active = index;
    frame.replaceChildren(image);
    updateControls();
    if (manual) status.textContent = `Photo ${active + 1} of ${slides.length}. ${alt}`;
    schedule();
  }

  function browse(step) {
    if (playing) setPlaying(false);
    move(step, true);
  }

  playback.addEventListener('click', () => setPlaying(!playing));
  document.getElementById('cover-previous').addEventListener('click', () => browse(-1));
  document.getElementById('cover-next').addEventListener('click', () => browse(1));
  frame.addEventListener('mouseenter', () => { hovering = true; schedule(); });
  frame.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  banner.addEventListener('focusin', event => {
    if (banner.contains(event.relatedTarget)) return;
    focusPaused = true;
    schedule();
  });
  banner.addEventListener('focusout', event => {
    if (banner.contains(event.relatedTarget)) return;
    focusPaused = false;
    schedule();
  });
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', event => {
    if (event.matches && playing) setPlaying(false);
  });

  updateControls();
  controls.hidden = false;
  schedule();
}
