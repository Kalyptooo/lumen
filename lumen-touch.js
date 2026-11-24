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

  /* Haptics on iPhone: iOS only vibrates when the finger itself lands on a switch. So every button carries a
     transparent label with a hidden switch over its whole area. The tap hits the label, the switch toggles (that is
     the tick), and the click still reaches the button once. Scrolling over it works as usual. */
  const enabled = function () {
    try { return localStorage.getItem('lumen-haptics') !== 'off'; } catch (e) { return true; }
  };
  const stop = function (e) { e.stopPropagation(); };
  function label() {
    const l = document.createElement('label');
    l.className = 'hx';
    l.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    input.addEventListener('click', stop);
    l.appendChild(input);
    return l;
  }
  function equip(root) {
    (root || document).querySelectorAll('button').forEach(function (b) {
      if (!b.querySelector(':scope > label.hx')) b.appendChild(label());
    });
  }
  function setEnabled(on) { document.documentElement.classList.toggle('no-hx', !on); }
  const style = document.createElement('style');
  style.textContent = 'button:has(> .hx){position:relative}' +
    '.hx{position:absolute;inset:0;z-index:1;display:block;border-radius:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '.hx input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}' +
    'button:disabled>.hx,html.no-hx .hx{display:none}';
  document.head.appendChild(style);
  setEnabled(enabled());

  /* Admin page: switches on every button already on the page, plus a vibration on Android. */
  function haptics() {
    equip(document);
    document.addEventListener('click', function (e) {
      const t = e.target && e.target.closest ? e.target.closest('button, a, [role="button"], input[type="checkbox"], select') : null;
      if (!t || t.disabled || t.closest('.hx') && t.tagName === 'INPUT' || !enabled()) return;
      if (typeof navigator.vibrate === 'function') navigator.vibrate(10);
    }, true);
  }
  window.LumenTouch = { haptics: haptics, label: label, equip: equip, setEnabled: setEnabled };
})();
