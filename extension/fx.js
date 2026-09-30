// Visual effects while Claude drives this tab: rainbow aura + animated click cards on the left.
// Pure page UI in a closed shadow root with pointer-events off, so it costs no Claude usage and doesn't block clicks.
(() => {
  if (window.__ttwFx) return;
  const RAINBOW = '#ff2a6d,#ff9f1c,#ffe700,#2bff88,#00d0ff,#7b5cff,#ff2a6d';
  const CSS = `
    :host { all: initial; }
    .aura { position: fixed; inset: 0; padding: 5px; background: linear-gradient(90deg,${RAINBOW}); background-size: 300% 100%;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
      animation: flow 3s linear infinite; }
    .glow { position: fixed; inset: 0; box-shadow: inset 0 0 60px 10px #ff2a6d66; animation: hue 4s linear infinite; }
    .pill { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); padding: 7px 8px 7px 16px; border-radius: 999px;
      display: flex; align-items: center; gap: 10px; pointer-events: auto;
      font: 600 13px system-ui, sans-serif; color: #fff; background: #111c; box-shadow: 0 0 0 2px #fff3, 0 0 24px #7b5cffaa;
      animation: hue 4s linear infinite; }
    .pill button { all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 50%; text-align: center; line-height: 22px;
      font: 700 14px system-ui, sans-serif; background: #fff2; }
    .pill button:hover { background: #ff2a6d; }
    .shield { position: fixed; inset: 0; pointer-events: auto; cursor: not-allowed; }
    .shield.lifted { pointer-events: none; }
    .feed { position: fixed; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
    .feed.tr { top: 16px; right: 16px; } .feed.tl { top: 16px; left: 16px; }
    .feed.br { bottom: 64px; right: 16px; } .feed.bl { bottom: 64px; left: 16px; }
    .feed.tr .card, .feed.br .card { animation: slideinr .35s cubic-bezier(.2,.9,.3,1.2), fadeoutr .5s ease-in 2.6s forwards; }
    .card { display: flex; align-items: center; gap: 10px; width: 230px; padding: 10px 12px; border-radius: 14px;
      background: #111e; color: #fff; font: 13px system-ui, sans-serif; box-shadow: 0 6px 24px #0006, 0 0 0 1.5px #ffffff22;
      animation: slidein .35s cubic-bezier(.2,.9,.3,1.2), fadeout .5s ease-in 2.6s forwards; }
    .card b { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; opacity: .6; }
    .card span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
    .anim { position: relative; flex: none; width: 44px; height: 44px; border-radius: 10px; background: linear-gradient(135deg,${RAINBOW}); background-size: 300% 300%; animation: flow 3s linear infinite; overflow: hidden; }
    .anim .icon { position: absolute; left: 7px; top: 7px; font-size: 15px; }
    .anim .ring { position: absolute; left: 24px; top: 24px; width: 6px; height: 6px; margin: -3px; border-radius: 50%; border: 2px solid #fff; animation: ring 1.1s ease-out .35s 2; opacity: 0; }
    .anim svg { position: absolute; left: 22px; top: 22px; width: 16px; filter: drop-shadow(0 1px 1px #0008); animation: tap 1.1s ease-in-out 2; }
    .ripple { position: fixed; width: 12px; height: 12px; margin: -6px; border-radius: 50%; border: 3px solid #7b5cff; animation: ripple .7s ease-out forwards; }
    @keyframes flow { to { background-position: 300% 0; } }
    @keyframes hue { to { filter: hue-rotate(360deg); } }
    @keyframes slidein { from { transform: translateX(-120%); opacity: 0; } }
    @keyframes fadeout { to { transform: translateX(-40px); opacity: 0; } }
    @keyframes slideinr { from { transform: translateX(120%); opacity: 0; } }
    @keyframes fadeoutr { to { transform: translateX(40px); opacity: 0; } }
    @keyframes tap { 0% { transform: translate(10px, 10px); } 40% { transform: translate(0, 0); } 50% { transform: translate(0, 0) scale(.8); } 60%, 100% { transform: translate(0, 0); } }
    @keyframes ring { 0% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(5); } }
    @keyframes ripple { from { opacity: 1; } to { opacity: 0; transform: scale(6); } }
    @media (prefers-reduced-motion: reduce) { * { animation-duration: .01s !important; animation-iteration-count: 1 !important; } }`;
  const CURSOR = '<svg viewBox="0 0 16 22"><path d="M1 1v17l4.5-4.2 3 6.7 3-1.3-3-6.6H15z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>';
  let host, root, feed, on = false, lastCard = 0;

  function mount() {
    host = document.createElement('ttw-fx');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="glow"></div><div class="aura"></div><div class="shield" title="Take the Wheel is driving. Press × to stop."></div><div class="feed tr"></div><div class="pill">✦ Take the Wheel is driving <button title="Stop">×</button></div>`;
    feed = root.querySelector('.feed');
    shield = root.querySelector('.shield');
    root.querySelector('.pill button').onclick = () => globalThis.chrome?.runtime?.id && chrome.runtime.sendMessage('ttw:stop');
    document.documentElement.append(host);
    if (globalThis.chrome?.storage) {
      chrome.storage.local.get('fxCorner', s => setCorner(s.fxCorner));
      chrome.storage.onChanged.addListener(c => { if (c.fxCorner) setCorner(c.fxCorner.newValue); });
    }
  }
  const setCorner = c => { if (feed) feed.className = 'feed ' + (['tr', 'tl', 'br', 'bl'].includes(c) ? c : 'tr'); };

  // The shield blocks the user's mouse while driving. ttw fires `ttw-act` before each action to lift it briefly,
  // so the agent's real (CDP) clicks reach the page.
  let shield, liftTimer;
  document.addEventListener('ttw-act', () => {
    if (!shield) return;
    shield.classList.add('lifted');
    clearTimeout(liftTimer);
    liftTimer = setTimeout(() => shield.classList.remove('lifted'), 3000);
  });
  function set(v) {
    on = !!v;
    if (on && !host) mount();
    if (host) host.style.display = on ? '' : 'none';
  }

  const kind = el => {
    const t = el.type;
    if (t === 'radio') return ['◉', 'Select'];
    if (t === 'checkbox') return ['☑', el.checked ? 'Check' : 'Uncheck'];
    if (el.matches('textarea, input, [contenteditable=""], [contenteditable=true]')) return ['✎', 'Type in'];
    if (el.matches('a, [role=link]')) return ['🔗', 'Open link'];
    if (el.matches('select')) return ['▾', 'Choose'];
    return ['▣', 'Click'];
  };
  const labelOf = el => ((el.labels && el.labels[0]) || (el.matches('input') && el.closest('label')) || (el.type === 'radio' || el.type === 'checkbox' ? el.parentElement : el)).innerText?.trim()
    || el.getAttribute('aria-label') || el.placeholder || el.value || el.name || el.tagName.toLowerCase();

  function show(el) {
    const now = Date.now();
    if (now - lastCard < 120) return; // a click on a <label> also fires one on its input
    lastCard = now;
    const [icon, verb] = kind(el);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="anim"><div class="icon"></div><div class="ring"></div>${CURSOR}</div><div><b></b><span></span></div>`;
    card.querySelector('.icon').textContent = icon;
    card.querySelector('b').textContent = verb;
    card.querySelector('span').textContent = labelOf(el).replace(/\s+/g, ' ').slice(0, 80);
    feed.append(card);
    while (feed.children.length > 4) feed.firstChild.remove();
    setTimeout(() => card.remove(), 3200);
    const r = el.getBoundingClientRect();
    if (r.width || r.height) {
      const rip = document.createElement('div');
      rip.className = 'ripple';
      rip.style.left = r.left + r.width / 2 + 'px';
      rip.style.top = r.top + r.height / 2 + 'px';
      root.append(rip);
      setTimeout(() => rip.remove(), 800);
    }
  }

  const TARGET = 'a, button, input, select, textarea, label, summary, [role=button], [role=link], [role=radio], [role=checkbox], [role=tab], [role=option], [contenteditable=""], [contenteditable=true]';
  document.addEventListener('click', e => {
    if (!on) return;
    let el = e.target.closest?.(TARGET);
    if (el?.matches('label') && el.control) el = el.control;
    if (el) show(el);
  }, true);
  const typed = new WeakMap(); // one card per field per burst of typing
  document.addEventListener('input', e => {
    if (!on || !e.target.matches?.('input:not([type=radio]):not([type=checkbox]), textarea, [contenteditable]')) return;
    if (Date.now() - (typed.get(e.target) || 0) > 2000) show(e.target);
    typed.set(e.target, Date.now());
  }, true);

  window.__ttwFx = set;
  if (globalThis.chrome?.runtime?.id) {
    chrome.runtime.sendMessage('ttw:hello', driving => set(driving)); // re-arm after navigation mid-run
    chrome.runtime.onMessage.addListener(m => { if (m?.ttw) set(m.ttw === 'on'); });
  }
})();
