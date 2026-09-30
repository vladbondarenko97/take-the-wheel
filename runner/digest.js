// Generic page digest for `ttw page`. Runs in the page via `opencli browser task eval`; returns a JSON string.
// Finds the question, its choices (native or custom widgets), text inputs, images, advance/finish buttons and progress,
// without knowing anything about the site.
(() => {
  const undouble = s => { // "X X" / "XX" from screen-reader copy + visible text
    const a = s.slice(0, Math.floor(s.length / 2)).trim();
    return s.length > 3 && a && (s === a + ' ' + a || s === a + a) ? a : s;
  };
  const clean = s => undouble(String(s || '').replace(/\s+/g, ' ').trim());
  const txt = el => clean(el.innerText || el.textContent || el.value || el.getAttribute?.('aria-label') || '');
  const shown = el => {
    if (!el || !el.getClientRects().length) return false;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 2 && r.height > 2;
  };
  const CHROME = 'nav, [role=navigation], [role=banner], [role=contentinfo], body > header, body > footer, [aria-hidden=true], dialog:not([open])';
  const inChrome = el => !!el.closest(CHROME);
  const esc = s => CSS.escape(s);
  const uniqueId = e => e.id && document.querySelectorAll('#' + esc(e.id)).length === 1;
  function sel(el) {
    if (uniqueId(el)) return '#' + esc(el.id);
    if (el.name && el.value && el.matches('input')) {
      const s = `input[name="${el.name.replace(/"/g, '\\"')}"][value="${el.value.replace(/"/g, '\\"')}"]`;
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const parts = [];
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (uniqueId(e)) { parts.unshift('#' + esc(e.id)); return parts.join(' > '); }
      const same = [...(e.parentElement?.children || [])].filter(s => s.tagName === e.tagName);
      parts.unshift(e.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ''));
    }
    return 'body > ' + parts.join(' > ');
  }
  const ADVANCE = /^\W*(next|continue|proceed|skip|go on|forward|start|begin|let'?s go|try it|→|›|»)(\W|$)/i;
  const FINISH = /\b(submit|finish|grade|get (my )?score|see (my )?results?|show (my )?results?|view results?|check (my |your )?answers?|end (the )?quiz|done|complete quiz)\b/i;
  const JUNK = /^(menu|close|×|x|share|sign in|log in|login|sign up|subscribe|search|cookie|accept|reject|agree|manage|settings|play|pause|mute|unmute|facebook|twitter|email|print|copy link|more|less|back to top|donate)\b/i;

  const map = {}, lines = [];
  let n = { c: 0, i: 0, a: 0, f: 0, m: 0 };
  const add = (p, el, kind, extra = {}) => { const id = p + (++n[p]); map[id] = { sel: sel(el), kind, ...extra }; return id; };

  // Choices: native radios/checkboxes, grouped by name.
  const choiceEls = [];
  const groups = {};
  for (const i of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
    const lab = (i.labels && i.labels[0]) || i.closest('label') || i.parentElement;
    if (inChrome(i) || !(shown(i) || shown(lab))) continue;
    (groups[i.name || '(unnamed)'] ??= []).push([i, clean(lab.innerText).slice(0, 140) || i.value]);
    choiceEls.push(lab);
  }
  // Choices: custom ARIA widgets.
  const aria = [...document.querySelectorAll('[role=radio], [role=checkbox], [role=option], [role=menuitemradio], [role=switch], [aria-checked]:not(input), [aria-pressed]')]
    .filter(e => shown(e) && !inChrome(e) && !e.matches('input'));
  // Buttons and button-like links: classify as advance / finish / answer choice.
  const btns = [...document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], a[href]')]
    .filter(e => shown(e) && !inChrome(e) && !aria.includes(e));
  const adv = [], fin = [], btnChoices = [];
  for (const b of btns) {
    const t = txt(b).slice(0, 100);
    if (!t) continue;
    if (FINISH.test(t)) fin.push([b, t]);
    else if (ADVANCE.test(t)) adv.push([b, t]);
    else if (!b.matches('a[href]') && t.length <= 100 && !JUNK.test(t)) btnChoices.push([b, t]);
  }
  // Last resort: clickable-looking elements with short text (onclick / pointer cursor) when nothing else was found.
  let generic = [];
  if (!Object.keys(groups).length && !aria.length && !btnChoices.length) {
    generic = [...document.querySelectorAll('li, div, span, label, p')].filter(e => shown(e) && !inChrome(e)
      && (e.hasAttribute('onclick') || getComputedStyle(e).cursor === 'pointer') && !e.querySelector('a, button, input')
      && txt(e).length > 0 && txt(e).length <= 120);
    generic = generic.filter(e => !generic.some(o => o !== e && o.contains(e))); // drop nested duplicates
    if (adv.length) { // with a Next button, real choices live in the same card as it
      let card = adv[0][0];
      for (let k = 0; card && k < 4; k++) card = card.parentElement;
      generic = card ? generic.filter(e => card.contains(e)) : [];
    }
    generic = generic.slice(0, 20);
  }

  // Question area: smallest ancestor containing all choices, widened until it has non-choice text.
  const all = [...choiceEls, ...aria, ...btnChoices.map(x => x[0]), ...generic];
  const choiceText = new Set([...Object.values(groups).flat().map(x => x[1]), ...aria.map(txt), ...btnChoices.map(x => x[1]), ...generic.map(txt)]);
  let box = all[0]?.parentElement;
  while (box && !all.every(e => box.contains(e))) box = box.parentElement;
  let question = '', asked = '';
  // The question itself is almost always the line right above the first choice. Use the primary choice set only
  // (real radios, else ARIA widgets, else buttons) so page buttons elsewhere can't hijack it.
  const g0 = Object.values(groups)[0];
  const prim = g0 ? g0 : aria.length ? aria.map(e => [e, txt(e)]) : btnChoices.length ? btnChoices : generic.map(e => [e, txt(e)]);
  let pbox = prim[0]?.[0].parentElement;
  while (pbox && !prim.every(x => pbox.contains(x[0]))) pbox = pbox.parentElement;
  let fallback = '';
  for (let a = pbox, k = 0; a && !asked && k < 6; k++, a = a.parentElement) {
    const ls = (a.innerText || '').split('\n').map(clean).filter(Boolean);
    const first = ls.findIndex(l => prim.some(([, c]) => c && (c === l || (l.length >= 4 && c.startsWith(l)))));
    const before = ls.slice(0, first < 0 ? 0 : first).filter(l => !/^(\d+\s*(of|\/)\s*\d+|(question|item)s?\s*#?\s*\d*\s*:?|score:?.*|\d+)$/i.test(l));
    const qlike = before.slice(-3).reverse().find(l => /[?:…]$|\.\.\.$/.test(l) || l.split(' ').length >= 4);
    if (qlike) asked = qlike; else fallback ||= before.at(-1) || '';
  }
  asked ||= fallback;
  for (let k = 0; box && k < 5; k++, box = box.parentElement) {
    question = clean((box.innerText || '').split('\n').filter(l => clean(l) && ![...choiceText].some(c => c && clean(l) === c)).join(' '));
    if (question.length >= 12) break;
  }
  // No choices (feedback/explanation/start screens): take the text around the advance button, else the main content.
  if (!question && adv.length) {
    let b = adv[0][0].parentElement;
    for (let k = 0; b && k < 6 && txt(b).replace(adv[0][1], '').length < 30; k++) b = b.parentElement;
    if (b) question = txt(b);
  }
  const main = document.querySelector('main, [role=main], article') || document.body;
  if (!question) question = txt(main);

  // Progress: "Question 3 of 15", "3/15", progress bars, or quiz-like data arrays in page globals.
  const bodyText = document.body.innerText || '';
  let cur = null, total = null, how = '';
  const m1 = bodyText.match(/\bquestion\s*#?\s*(\d+)\s*(?:of|\/|out of)\s*(\d+)/i) || [...document.querySelectorAll('span, div, p, li, h1, h2, h3, h4')]
    .filter(e => shown(e) && e.children.length === 0).map(e => clean(e.textContent).match(/^(\d+)\s*(?:of|\/)\s*(\d+)$/)).find(Boolean);
  if (m1) { cur = +m1[1]; total = +m1[2]; how = 'page text'; }
  const bar = document.querySelector('[role=progressbar][aria-valuemax], progress[max]');
  if (!total && bar) { cur = +(bar.getAttribute('aria-valuenow') ?? bar.value); total = +(bar.getAttribute('aria-valuemax') ?? bar.max); how = 'progress bar'; }
  if (!total) { const m3 = question.match(/\b(\d{1,3})\s*(?:of|\/|out of)\s*(\d{1,3})\b/); if (m3 && +m3[1] <= +m3[2]) { cur = +m3[1]; total = +m3[2]; how = 'page text'; } }
  if (!total) { const m4 = bodyText.match(/(?:^|\s)(\d{1,3})\s*(?:of|out of)\s*(\d{1,3})(?:\s|$)/m); if (m4 && +m4[1] <= +m4[2]) { cur = +m4[1]; total = +m4[2]; how = 'page text, loose match'; } }
  if (!cur) { const m2 = bodyText.match(/\bquestion\s*#?\s*(\d+)\b/i); if (m2) { cur = +m2[1]; how = 'page text'; } }
  if (!total) for (const k of Object.keys(window)) {
    try { if (/quiz|question/i.test(k) && Array.isArray(window[k]) && window[k].length >= 2 && window[k].length <= 500) { total = window[k].length; how += (how ? ' + ' : '') + `page data window.${k}`; break; } } catch {}
  }

  // Output.
  lines.push(`PROGRESS: ${cur ? 'question ' + cur : '?'}${total ? ' of ' + total : ''}${how ? ` (from ${how})` : ''}`);
  lines.push(`QUESTION/TEXT: ${question.slice(0, Object.keys(groups).length > 1 ? 250 : 700)}`);
  if (asked && Object.keys(groups).length <= 1) lines.push(`ASKED: ${asked.slice(0, 300)}`);
  const imgs = [...document.images].filter(i => shown(i) && !inChrome(i)).map(i => [i, i.getBoundingClientRect()])
    .filter(([, r]) => r.width >= 100 && r.height >= 100).sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height).slice(0, 5);
  for (const [i, r] of imgs) {
    const inView = r.bottom > 0 && r.top < innerHeight;
    lines.push(`IMAGE ${add('m', i, 'image')}: ${i.currentSrc || i.src} (${Math.round(r.width)}x${Math.round(r.height)}${inView ? ', in view' : ', off screen'})${i.alt ? ' alt="' + clean(i.alt).slice(0, 100) + '"' : ''}`);
  }
  const bigGraphics = [...document.querySelectorAll('svg, canvas')].filter(e => shown(e) && !inChrome(e) && e.getBoundingClientRect().width >= 150 && e.getBoundingClientRect().height >= 150).length;
  if (bigGraphics) lines.push(`GRAPHICS: ${bigGraphics} large svg/canvas (use \`ttw look\` to see them)`);
  const gnames = Object.keys(groups);
  if (gnames.length || aria.length || btnChoices.length || generic.length) lines.push('CHOICES (* = selected):');
  // Per-group question text (for pages with many questions): nearest ancestor with non-choice text.
  const groupQuestion = items => {
    const els = items.map(x => x[0]);
    let a = els[0].parentElement;
    while (a && !els.every(e => a.contains(e))) a = a.parentElement;
    for (let k = 0; a && k < 4; k++, a = a.parentElement) {
      const q = (a.innerText || '').split('\n').map(clean).filter(l => l && !items.some(x => x[1] === l || x[1].endsWith(l))).join(' ');
      if (q.length >= 3) return q.slice(0, 250);
    }
    return '';
  };
  for (const g of gnames) {
    if (gnames.length > 1) lines.push(`  Q ${g}: ${groupQuestion(groups[g])}`);
    for (const [i, label] of groups[g]) lines.push(`    ${add('c', i, 'native')} ${i.checked ? '*' : ' '} ${label}`);
  }
  for (const e of aria) {
    const on = ['aria-checked', 'aria-pressed', 'aria-selected'].some(a => e.getAttribute(a) === 'true');
    lines.push(`    ${add('c', e, 'custom')} ${on ? '*' : ' '} ${txt(e).slice(0, 140)}`);
  }
  for (const [b, t] of (gnames.length || aria.length ? [] : btnChoices)) { // real radios/widgets present: page buttons aren't answers
    const cls = String(b.className?.baseVal ?? b.className ?? '') + ' ' + String(b.parentElement?.className ?? '');
    const on = /\b(selected|active|chosen|checked)\b/i.test(cls) || b.getAttribute('aria-pressed') === 'true';
    const mark = /\b(in-?correct|wrong|false)\b/i.test(cls) ? ' [page marks: wrong]' : /\b(correct|right|true)\b/i.test(cls) ? ' [page marks: correct]' : '';
    lines.push(`    ${add('c', b, 'custom')} ${on ? '*' : ' '} ${t} [button]${mark}`);
  }
  for (const e of generic) lines.push(`    ${add('c', e, 'custom')}   ${txt(e)} [clickable]`);
  for (const i of [...document.querySelectorAll('input:not([type]), input[type=text], input[type=number], input[type=email], textarea, select')].filter(e => shown(e) && !inChrome(e)).slice(0, 10)) {
    const label = clean((i.labels && i.labels[0]?.innerText) || i.placeholder || i.getAttribute('aria-label') || i.name);
    const opts = i.matches('select') ? ' options: ' + [...i.options].slice(0, 12).map(o => o.text.trim()).join(' | ') : '';
    lines.push(`INPUT ${add('i', i, i.matches('select') ? 'select' : 'text')}: ${label.slice(0, 80)} = "${clean(i.value).slice(0, 60)}"${opts}`);
  }
  for (const [b, t] of adv) lines.push(`ADVANCE ${add('a', b, 'advance')}: "${t}"`);
  for (const [b, t] of fin) lines.push(`FINISH ${add('f', b, 'finish')}: "${t}" (submits/grades: never press unless the user asked)`);
  const fp = [location.href, question.slice(0, 300).replace(/\d+/g, ''), [...choiceText].join('|'), cur].join('#'); // digits out: timers tick
  let h = 5381; for (let k = 0; k < fp.length; k++) h = ((h << 5) + h + fp.charCodeAt(k)) | 0;
  const dialogs = window.__ttwDialogs ? window.__ttwDialogs.splice(0) : [];
  return JSON.stringify({ text: lines.join('\n'), map, fp: h, host: location.hostname, cur, total, dialogs });
})()
