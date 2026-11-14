/* Sound Diary — lightweight visit tracking.
 * Anonymous, no cookies. Sends custom events to Umami (or Plausible) if that
 * script is on the page; otherwise events are dropped silently.
 *
 * Switches (add to the page URL, once per browser):
 *   ?notrack=1     stop tracking this browser (use it on your own devices)
 *   ?notrack=0     start tracking this browser again
 *   ?trackdebug=1  show a small on-screen list of events as they fire
 */
(function () {
  'use strict';
  if (window.sdTrack) return;

  var PAGE = 'site';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) {} }

  var qs = new URLSearchParams(window.location.search);
  if (qs.get('notrack') === '1') { lsSet('sd_notrack', '1'); lsSet('umami.disabled', '1'); }
  if (qs.get('notrack') === '0') { lsDel('sd_notrack'); lsDel('umami.disabled'); }
  var DISABLED = lsGet('sd_notrack') === '1';
  var DEBUG = qs.get('trackdebug') === '1';

  /* ---------- optional: Microsoft Clarity (screen-recording style replays) ----------
   * Paste your Clarity project ID between the quotes. Empty = Clarity is not loaded.
   * Browsers with ?notrack=1 are excluded from Clarity too. */
  var CLARITY_ID = '';
  if (CLARITY_ID && !DISABLED) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_ID);
  }
  function clarity() {
    if (CLARITY_ID && !DISABLED && typeof window.clarity === 'function') {
      try { window.clarity.apply(null, arguments); } catch (e) {}
    }
  }

  /* ---------- delivery ---------- */
  var queue = [];
  var tries = 0;
  var timer = null;

  function deliver(name, data) {
    if (window.umami && typeof window.umami.track === 'function') { window.umami.track(name, data); return true; }
    if (typeof window.plausible === 'function') { window.plausible(name, { props: data }); return true; }
    return false;
  }

  function flush() {
    timer = null;
    while (queue.length && deliver(queue[0].n, queue[0].d)) queue.shift();
    if (queue.length && tries < 40) { tries += 1; timer = setTimeout(flush, 500); }
  }

  var panel = null;
  var shown = [];
  function debugShow(name, data) {
    if (!DEBUG || !document.body) return;
    if (!panel) {
      panel = document.createElement('pre');
      panel.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;margin:0;padding:6px 8px;' +
        'background:rgba(0,0,0,.85);color:#3f6;font:11px/1.35 monospace;max-width:92vw;pointer-events:none;white-space:pre-wrap';
      document.body.appendChild(panel);
    }
    var text = name;
    try { var j = JSON.stringify(data); if (j && j !== '{}') text += ' ' + j; } catch (e) {}
    shown.push(text);
    if (shown.length > 12) shown.shift();
    panel.textContent = (DISABLED ? '[tracking OFF in this browser]\n' : '') + shown.join('\n');
  }

  function event(name, data) {
    data = data || {};
    debugShow(name, data);
    if (DISABLED) return;
    clarity('event', name);
    if (name === 'terminal_option') clarity('set', 'terminal_option', String(data.option));
    queue.push({ n: name, d: data });
    if (queue.length > 200) queue.shift();
    if (!timer) flush();
  }

  /* ---------- time (only counts while the tab is visible) ---------- */
  function Clock() {
    this.acc = 0;
    this.start = document.visibilityState === 'hidden' ? null : performance.now();
  }
  Clock.prototype.pause = function () { if (this.start !== null) { this.acc += performance.now() - this.start; this.start = null; } };
  Clock.prototype.resume = function () { if (this.start === null) this.start = performance.now(); };
  Clock.prototype.take = function () { // seconds since last take, then reset
    this.pause();
    var s = this.acc / 1000;
    this.acc = 0;
    return s;
  };

  var pageClock = new Clock();
  var slideClock = new Clock();

  /* ---------- session ---------- */
  var visits = parseInt(lsGet('sd_visits') || '0', 10) || 0;
  var newSession = !ssGet('sd_session');
  if (newSession) {
    ssSet('sd_session', '1');
    visits += 1;
    lsSet('sd_visits', String(visits));
  }

  /* ---------- slides ---------- */
  var NAMES = {
    cover: 'cover', problem: 'problem', believe: 'believe', whatwedo: 'what-we-do', dontdo: 'dont-do',
    howwethink: 'how-we-think', sitebroken: 'terminal', proof: 'proof', cta: 'cta', footer: 'footer'
  };
  var seen = {};
  var current = null;
  var dodges = 0;
  var lastDodge = 0;
  var lastSlide = null;

  function slugOf(el) {
    var m = /slide--(\w+)/.exec((el && el.className) || '');
    var k = m ? m[1] : 'unknown';
    return NAMES[k] || k;
  }

  function flushDodges() {
    if (dodges > 0) { event('cta_dodges', { count: dodges }); dodges = 0; }
  }

  function leaveCurrent() {
    if (!current) return;
    var secs = Math.round(slideClock.take());
    if (secs >= 1) event('slide_time', { slide: current, seconds: secs });
    if (current === 'cta') flushDodges();
  }

  function enterSlide(el, index) {
    var slug = slugOf(el);
    if (slug === current) return;
    leaveCurrent();
    current = slug;
    lastSlide = slug;
    slideClock = new Clock();
    seen[slug] = (seen[slug] || 0) + 1;
    clarity('set', 'slide', slug);
    event('slide_view', { slide: slug, index: index, first: seen[slug] === 1 });
    if (seen[slug] > 1) event('slide_replay', { slide: slug, times: seen[slug] });
  }

  function countSeen() { var n = 0; for (var k in seen) if (Object.prototype.hasOwnProperty.call(seen, k)) n += 1; return n; }

  function endSegment() {
    leaveCurrent();
    var secs = Math.round(pageClock.take());
    if (secs < 1) return;
    event('page_end', {
      page: PAGE, seconds: secs, slides_seen: countSeen(),
      last_slide: lastSlide || 'none', reached_cta: !!seen.cta, finished: !!seen.footer
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      endSegment();
    } else {
      pageClock = new Clock();
      if (current) slideClock = new Clock();
    }
  });
  window.addEventListener('pagehide', endSegment);

  /* ---------- clicks and hovers (no changes to the bundles needed) ---------- */
  function albumOf(href) {
    href = href || '';
    if (href.indexOf('2y09iaCtieD2Aj1lsEpKvs') !== -1) return 'nafida';
    if (href.indexOf('3sJXIkVh7Fd31jVfyBPGmd') !== -1) return 'howls';
    return 'other';
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href]');
    if (a) {
      var h = a.getAttribute('href') || '';
      if (/canva\.site\/home\//.test(h)) {
        event('carousel_card_click', { card: h.split('/').pop() });
      } else if (/open\.spotify\.com\/playlist/.test(h)) {
        event('playlist_click', { source: a.closest('.slide--cta') ? 'cta' : 'site' });
      } else if (/open\.spotify\.com\//.test(h)) {
        event('mention_click', { album: albumOf(h) });
      }
    }
    if (t.closest('[data-title-start]')) event('game_start');
  }, true);

  var hovered = {};
  document.addEventListener('mouseover', function (e) {
    var t = e.target;
    var c = t && t.closest ? t.closest('.mention-cover') : null;
    if (!c) return;
    var a = c.querySelector('a');
    var k = albumOf(a ? a.getAttribute('href') : '');
    if (hovered[k]) return;
    hovered[k] = 1;
    event('mention_hover', { album: k });
  });

  /* ---------- public API used by the bundles ---------- */
  window.sdTrack = {
    event: event,
    slideChange: function (el, index) { enterSlide(el, index); },
    dodge: function () {
      var now = Date.now();
      if (now - lastDodge > 600) { dodges += 1; lastDodge = now; }
    }
  };

  /* ---------- start ---------- */
  function init() {
    if (document.getElementById('game-wrapper')) PAGE = 'game';
    /* index.html shows a "desktop only" gate on touch devices and never starts the deck.
       Those visits are flagged and get no slide events (the cover is in the HTML but hidden). */
    var gated = document.documentElement.classList.contains('is-gated');
    if (newSession) {
      event('session_start', {
        visit_n: visits,
        returning: visits > 1,
        device: window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
        hour: new Date().getHours(),
        page: PAGE,
        gated: gated
      });
    }
    if (PAGE === 'game') event('game_view');
    if (gated) { PAGE = 'gate'; return; }
    var active = document.querySelector('.slide.is-active');
    if (active) enterSlide(active, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
