/* Lumen touch layer, shared by the learning page and the admin page.
   - A tap that lands while a list is still gliding counts at once. iOS would otherwise use it only to stop the scrolling.
   - haptics() gives the admin page the same light tick on every button as the learning page. */
(function () {
  'use strict';
  const TARGET = 'button, a.btn, [role="button"]';
  const MOVE_LIMIT = 10, TAP_MS = 500, GLIDE_MS = 350, GHOST_MS = 450;
  let lastScroll = 0, start = null, ignoreClicksUntil = 0;

  document.addEventListener('scroll', function () { lastScroll = Date.now(); }, { capture: true, passive: true });
  document.addEventListener('touchstart', function (e) {
    const el = e.touches.length === 1 && e.target.closest ? e.target.closest(TARGET) : null;
    if (!el) { start = null; return; }
    const t = e.touches[0];
    start = { el: el, x: t.clientX, y: t.clientY, at: Date.now(), gliding: Date.now() - lastScroll < GLIDE_MS };
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!start) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_LIMIT) start = null;
  }, { capture: true, passive: true });
  document.addEventListener('touchcancel', function () { start = null; }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    const s = start;
    start = null;
    if (!s || !s.gliding || s.el.disabled || !document.contains(s.el) || Date.now() - s.at > TAP_MS) return;
    if (e.cancelable) e.preventDefault();
    ignoreClicksUntil = Date.now() + GHOST_MS;
    s.el.click();
  }, { capture: true, passive: false });
  // The browser's own late click after a handled tap must not press whatever now sits under the finger.
  document.addEventListener('click', function (e) {
    if (e.isTrusted && Date.now() < ignoreClicksUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  function haptics() {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    const enabled = function () {
      try { return localStorage.getItem('lumen-haptics') !== 'off'; } catch (e) { return true; }
    };
    document.addEventListener('click', function (e) {
      const t = e.target && e.target.closest ? e.target.closest('button, a, [role="button"], input[type="checkbox"], select') : null;
      if (!t || t.disabled || label.contains(t) || !enabled()) return;
      if (typeof navigator.vibrate === 'function') navigator.vibrate(10);
      else label.click();
    }, true);
  }
  window.LumenTouch = { haptics: haptics };
})();
