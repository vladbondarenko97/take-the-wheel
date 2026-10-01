#!/usr/bin/env node
// labctl: drive a VMware WMKS canvas-based remote console (LabOnDemand/Skillable-style
// virtual labs), where the VM screen is pixels on a <canvas> with no DOM inside it.
//
// Use the console's own "vmOnly=1" popout window (Resources tab -> "Open in New Window"),
// not the embedded lab view: the popout puts the console directly in the top document, so
// opencli's native click/find work on all its real UI (Type Username/Password, Virtual
// Keyboard) via plain CSS selectors. The embedded view nests that same UI in a same-origin
// iframe that opencli's click/find can't reach at all (ref-based click also fails there:
// refs go stale almost instantly, apparently because the canvas element gets recreated
// often). If you're stuck with the embedded view, reach for `eval` +
// `document.querySelector('#consoleIFrame').contentDocument` instead of the plain
// `opencli click` calls below — confirmed working, just more code.
//
// Two things here that opencli has no native command for:
//   - coordinate clicks on the canvas itself (icons, windows: all pixels, no DOM). The
//     canvas's mousedown/mouseup listeners aren't gated behind Chrome's isTrusted check, so
//     a synthetic MouseEvent at the right clientX/clientY genuinely reaches the VM.
//   - typing arbitrary text: opencli's own `keys` command does NOT reach the VM (tested:
//     real DOM focus forced onto the canvas, still nothing reaches it). The Virtual
//     Keyboard's per-key buttons are the platform's actual supported input channel.
//   - `locate`: point a local vision model (Ollama) at a screenshot instead of eyeballing
//     pixel coordinates by hand.
//
// Usage:
//   labctl <session> shot <path>             screenshot (plain opencli passthrough)
//   labctl <session> click <vx> <vy>          click at native-VM pixel (vx,vy) -- native
//                                              resolution (canvas.width/height), scaled to
//                                              the canvas's current displayed size, so this
//                                              survives window resizes
//   labctl <session> key <exact-aria-label>   click one Virtual Keyboard key, e.g. "S key",
//                                              "Backspace key", "Tab key", "Space bar"
//   labctl <session> type <text>              type text via Virtual Keyboard, one click per
//                                              character (letters, digits, space)
//   labctl <session> username                 click the platform's "Type Username" helper
//   labctl <session> password                 click the platform's "Type Password" helper
//   labctl <session> locate <description>     screenshot -> local vision model -> click
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [session, cmd, ...rest] = process.argv.slice(2);
if (!session || !cmd) {
  console.error('usage: labctl <session> <shot|click|key|type|username|password|locate> [args...]');
  process.exit(1);
}

const oc = args => execFileSync('opencli', ['browser', session, ...args], { encoding: 'utf8' });

// aria-label must match EXACTLY: "Minus key", "Equals key", and "Numpad plus key" all end in
// "s key" (they end in the letter "s"), so a substring match for e.g. "S key" would grab
// "Minus key" first and silently type the wrong character.
const keySelector = label => `[aria-label="${label.replace(/"/g, '\\"')}"]`;
const pressKey = label => oc(['click', keySelector(label)]);

const CHAR_LABEL = new Map([[' ', 'Space bar'], ['\n', 'Enter key'], ['\b', 'Backspace key'], ['\t', 'Tab key']]);
function typeText(text) {
  for (const ch of text) pressKey(CHAR_LABEL.get(ch) ?? `${ch.toUpperCase()} key`);
}

// The only visible console's canvas, plus its on-page rect and native (VM) resolution.
// Recomputed fresh every call -- cheap, and avoids caching a rect that's gone stale after a
// window resize.
const CANVAS_INFO = `(function(){
  var c=[...document.querySelectorAll("[id^=wmksContainer-] canvas")].find(function(x){return x.offsetParent;});
  if(!c) throw new Error("no visible console canvas found");
  var r=c.getBoundingClientRect();
  return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,attrW:c.width,attrH:c.height});
})()`;
const canvasInfo = () => JSON.parse(oc(['eval', CANVAS_INFO]));

function clickNative(vx, vy) {
  oc(['eval', `(function(){
    var c=[...document.querySelectorAll("[id^=wmksContainer-] canvas")].find(function(x){return x.offsetParent;});
    if(!c) throw new Error("no visible console canvas found");
    var r=c.getBoundingClientRect();
    var cx=r.x + (${vx}/c.width)*r.width, cy=r.y + (${vy}/c.height)*r.height;
    var o={clientX:cx, clientY:cy, bubbles:true, cancelable:true, view:window, button:0};
    c.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, o, {buttons:1})));
    c.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, {buttons:0})));
    c.dispatchEvent(new MouseEvent('click', Object.assign({}, o, {buttons:0})));
  })()`]);
}

const OLLAMA_URL = process.env.LABCTL_OLLAMA_URL ?? 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.LABCTL_VISION_MODEL ?? 'qwen3-vl:30b-a3b';

async function locate(description) {
  const info = canvasInfo();
  const shotPath = join(tmpdir(), `labctl-${Date.now()}.png`);
  execFileSync('opencli', ['browser', session, 'screenshot', shotPath]);
  const image = readFileSync(shotPath).toString('base64');
  unlinkSync(shotPath);

  const prompt = `This is a screenshot of a browser tab, ${Math.round(info.x + info.w)}x${Math.round(info.y + info.h)} pixels. ` +
    `Reply with ONLY a JSON object {"x": <int>, "y": <int>} giving the pixel coordinates of the ` +
    `center of: ${description}. Use pixel coordinates within this image, not percentages.`;

  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, images: [image], format: 'json', stream: false, think: false }),
  });
  if (!res.ok) throw new Error(`ollama request failed: ${res.status} ${await res.text()}`);
  const { response } = await res.json();
  const { x, y } = JSON.parse(response);

  // Model reasons in full-screenshot pixels; convert into VM-native pixels via the canvas's
  // on-page rect (subtract its offset, then scale displayed size -> native resolution).
  const vx = ((x - info.x) / info.w) * info.attrW;
  const vy = ((y - info.y) / info.h) * info.attrH;
  console.error(`locate: "${description}" -> screenshot (${x},${y}) -> VM (${Math.round(vx)},${Math.round(vy)})`);
  clickNative(Math.round(vx), Math.round(vy));
}

switch (cmd) {
  case 'shot':
    execFileSync('opencli', ['browser', session, 'screenshot', rest[0]], { stdio: 'inherit' });
    break;

  case 'click': {
    const [vx, vy] = rest.map(Number);
    clickNative(vx, vy);
    break;
  }

  case 'key':
    pressKey(rest.join(' '));
    break;

  case 'type':
    typeText(rest.join(' '));
    break;

  case 'username':
    oc(['click', '#pasteUsername']);
    break;

  case 'password':
    oc(['click', '#pastePassword']);
    break;

  case 'locate':
    await locate(rest.join(' '));
    break;

  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
