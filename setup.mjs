// One-time setup: checks Node/opencli, then installs a per-user autostart entry for runner/runner.mjs
// so it survives reboot without a terminal open. Loading the two Chrome extensions stays manual —
// Chrome doesn't allow silent extension installs on an unmanaged profile.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const RUNNER = join(HERE, 'runner', 'runner.mjs');
const NODE = process.execPath;
const WIN = platform() === 'win32';
const STATE_DIR = join(homedir(), '.take-the-wheel');
mkdirSync(STATE_DIR, { recursive: true });

const step = msg => console.log(`\n▶ ${msg}`);
const ok = msg => console.log(`  ✓ ${msg}`);
const warn = msg => console.log(`  ! ${msg}`);
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', shell: WIN });

function checkNode() {
  step('Node version');
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) { console.error(`  ✗ Node ${process.versions.node} found, need >= 20. Install a newer Node and re-run.`); process.exit(1); }
  ok(`Node ${process.versions.node}`);
}

function ensureOpencli() {
  step('opencli');
  const probe = sh('opencli', ['--version']);
  if (probe.status === 0) return ok(`opencli ${probe.stdout.trim()}`);
  warn('not found, installing @jackwener/opencli globally');
  const install = spawnSync('npm', ['i', '-g', '@jackwener/opencli'], { stdio: 'inherit', shell: WIN });
  if (install.status !== 0) { console.error('  ✗ npm install failed — install manually: npm i -g @jackwener/opencli'); process.exit(1); }
  ok('installed');
}

function runDoctor() {
  step('opencli doctor');
  const doc = sh('opencli', ['doctor']);
  const out = (doc.stdout || '') + (doc.stderr || '');
  console.log(out.trim().replace(/^/gm, '  '));
  if (/\[(MISSING|FAIL)\]/.test(out)) warn('doctor reports missing pieces — likely the OpenCLI Chrome extension isn\'t installed yet (manual step, see below)');
  else ok('clean');
}

function installAutostartDarwin() {
  const label = 'com.takethewheel.runner';
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const logPath = join(STATE_DIR, 'runner.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${RUNNER}</string>
  </array>
  <key>WorkingDirectory</key><string>${HERE}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${process.env.PATH}</string></dict>
</dict>
</plist>
`;
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath, plist);
  spawnSync('launchctl', ['unload', plistPath]); // ignore failure: fine if it wasn't loaded yet
  const load = spawnSync('launchctl', ['load', '-w', plistPath]);
  if (load.status !== 0) { warn(`launchctl load failed: ${load.stderr}`); return; }
  ok(`LaunchAgent installed (${plistPath})`);
  ok(`runner starts at login, restarts if it crashes, logs to ${logPath}`);
}

function installAutostartWindows() {
  const vbsPath = join(STATE_DIR, 'start-runner.vbs');
  const xmlPath = join(STATE_DIR, 'runner-task.xml');
  const logPath = join(STATE_DIR, 'runner.log');
  const esc = s => s.replace(/"/g, '""');
  // Hidden (windowless) launch; cmd /c so npm's PATH/PATHEXT resolution applies inside the launched shell too.
  const vbs = `Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "${esc(HERE)}"
shell.Run "cmd /c ""${esc(NODE)}"" ""${esc(RUNNER)}"" >> ""${esc(logPath)}"" 2>&1", 0, False
`;
  writeFileSync(vbsPath, vbs);
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Take the Wheel local runner (starts at logon)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>"${esc(vbsPath)}"</Arguments></Exec>
  </Actions>
</Task>
`;
  writeFileSync(xmlPath, '﻿' + xml, 'utf16le'); // schtasks requires UTF-16 with BOM
  const create = spawnSync('schtasks', ['/Create', '/TN', 'TakeTheWheelRunner', '/XML', xmlPath, '/F']);
  if (create.status !== 0) { warn(`schtasks failed: ${create.stderr || create.stdout}`); return; }
  ok('Scheduled task "TakeTheWheelRunner" installed (starts at logon, restarts on failure)');
  ok(`logs to ${logPath}`);
  spawnSync('schtasks', ['/Run', '/TN', 'TakeTheWheelRunner']); // start it now too, don't wait for next logon
}

function installAutostart() {
  step(`Autostart (${platform()})`);
  if (platform() === 'darwin') return installAutostartDarwin();
  if (platform() === 'win32') return installAutostartWindows();
  warn(`no autostart wired up for platform "${platform()}" yet — run \`node runner/runner.mjs\` manually`);
}

checkNode();
ensureOpencli();
runDoctor();
installAutostart();

console.log(`
Still manual (Chrome won't let this be scripted):
  1. Install the OpenCLI extension: https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk
  2. chrome://extensions -> Developer mode -> Load unpacked -> select "${join(HERE, 'extension')}"
  3. Open the Take the Wheel side panel, paste the token the runner printed (also in runner/.token).
`);
