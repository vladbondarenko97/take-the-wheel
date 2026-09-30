#!/usr/bin/env node
// Prototype: drive a VMware WMKS canvas-based remote console (LabOnDemand/Skillable-style
// virtual labs) where opencli's normal ref/CSS click can't help — the whole VM screen is
// pixels on a <canvas> inside a same-origin nested #consoleIFrame, not a DOM.
//
// Two techniques, both confirmed live against a real lab:
//   1. The lab platform's own UI (Type Username/Password, Virtual Keyboard) is real DOM
//      *inside* that iframe. opencli's `click` never reaches it (refs go stale near-instantly;
//      CSS-selector click never descends into iframes at all) — but `eval` running JS in the
//      top frame can reach in via `contentDocument`, and `.click()` there genuinely reaches
//      the VM. That's the only way to send keystrokes here: opencli's own `keys` command does
//      NOT reach the VM (tested: real DOM focus on the canvas, still nothing).
//   2. For anything else (icons, windows, menus rendered as pixels): the canvas's own
//      mousedown/mouseup listeners aren't gated behind Chrome's isTrusted check, so a synthetic
//      MouseEvent with the right clientX/clientY, dispatched the same way, genuinely clicks
//      into the VM. Coordinates are given in the VM's *native* resolution (canvas.width/height,
//      e.g. 1024x768) and scaled to whatever the canvas is currently displayed at, so this
//      keeps working across window resizes.
//
// Usage:
//   labctl <session> shot <path>              screenshot (plain opencli passthrough)
//   labctl <session> click <vx> <vy>           click at native-VM pixel (vx,vy)
//   labctl <session> key <aria-label-substr>   click a Virtual Keyboard key, e.g. "Backspace key", "Tab key", "Q key"
//   labctl <session> type <text>               type text via Virtual Keyboard, one click per char (letters, digits, space)
//   labctl <session> username                  click the platform's "Type Username" helper
//   labctl <session> password                  click the platform's "Type Password" helper
import { execFileSync } from 'node:child_process';

const [session, cmd, ...rest] = process.argv.slice(2);
if (!session || !cmd) {
  console.error('usage: labctl <session> <shot|click|key|type|username|password> [args...]');
  process.exit(1);
}

const oc = args => execFileSync('opencli', ['browser', session, ...args], { encoding: 'utf8' });

// All lab-platform DOM (Type Username/Password, Virtual Keyboard) lives in this same-origin
// nested iframe. It's "same-origin" so contentDocument works directly — no `eval --frame`
// needed (that flag is for genuinely cross-origin iframes, confirmed via `browser frames`,
// which doesn't even list this one).
const IN_FRAME = expr => `(function(){ var d=document.querySelector('#consoleIFrame').contentDocument; ${expr} })()`;
const evalIn = expr => oc(['eval', IN_FRAME(expr)]);

// Picks whichever machine's canvas is actually visible, so this isn't hardcoded to one
// lab's machine id. Labs can have >1 VM (only the selected one is on-screen).
const GET_CANVAS = `var c=[...d.querySelectorAll("[id^=wmksContainer-] canvas")].find(function(x){return x.offsetParent;});
if(!c) throw new Error("no visible console canvas found");`;

// Per-key virtual keyboard buttons. `exact` matters: aria-labels like "Minus key",
// "Equals key", and "Numpad plus key" all end in "s key" (because they end in the letter
// "s"), so a substring match for e.g. "S key" grabs "Minus key" first and silently types the
// wrong character. Exact match for the auto-typed single-character case; substring only for
// the freeform `key <text>` CLI command where that's a convenience, not a correctness risk.
function pressKey(label, exact = false) {
  const needle = JSON.stringify(label.toLowerCase());
  const match = exact
    ? `x.getAttribute('aria-label').toLowerCase()===${needle}`
    : `x.getAttribute('aria-label').toLowerCase().indexOf(${needle})!==-1`;
  evalIn(`${GET_CANVAS}
    var btns=[...d.querySelectorAll('#virtualKeyboard [aria-label]')];
    var b=btns.find(function(x){return ${match};});
    if(!b) throw new Error('no virtual-keyboard key matching ${label}');
    b.click();`);
}

const CHAR_LABEL = new Map([[' ', 'space bar'], ['\n', 'enter key'], ['\b', 'backspace key'], ['\t', 'tab key']]);
function typeText(text) {
  for (const ch of text) {
    const label = CHAR_LABEL.get(ch) ?? `${ch.toUpperCase()} key`;
    pressKey(label, true);
  }
}

switch (cmd) {
  case 'shot':
    execFileSync('opencli', ['browser', session, 'screenshot', rest[0]], { stdio: 'inherit' });
    break;

  case 'click': {
    const [vx, vy] = rest.map(Number);
    evalIn(`${GET_CANVAS}
      var r=c.getBoundingClientRect();
      var cx=r.x + (${vx}/c.width)*r.width, cy=r.y + (${vy}/c.height)*r.height;
      var o={clientX:cx, clientY:cy, bubbles:true, cancelable:true, view:d.defaultView, button:0};
      c.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, o, {buttons:1})));
      c.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, {buttons:0})));
      c.dispatchEvent(new MouseEvent('click', Object.assign({}, o, {buttons:0})));`);
    break;
  }

  case 'key':
    pressKey(rest.join(' '), false);
    break;

  case 'type':
    typeText(rest.join(' '));
    break;

  case 'username':
    evalIn(`var b=d.querySelector('#pasteUsername'); if(!b) throw new Error('no #pasteUsername'); b.click();`);
    break;

  case 'password':
    evalIn(`var b=d.querySelector('#pastePassword'); if(!b) throw new Error('no #pastePassword'); b.click();`);
    break;

  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
