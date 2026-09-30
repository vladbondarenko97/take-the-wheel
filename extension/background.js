chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Dev auto-reload (unpacked installs only): snapshot our files when the extension loads;
// panel.js compares them with disk and reloads when they change.
const DEV_FILES = ['manifest.json', 'background.js', 'fx.js', 'panel.html', 'panel.js'];
async function snapshot() {
  if ((await chrome.management.getSelf()).installType !== 'development') return;
  const devSnapshot = {};
  for (const f of DEV_FILES) devSnapshot[f] = await (await fetch(f, { cache: 'no-store' })).text();
  chrome.storage.local.set({ devSnapshot });
}
chrome.runtime.onInstalled.addListener(snapshot);
chrome.runtime.onStartup.addListener(snapshot);

// fx.js asks on every page load whether its tab is the one being driven.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg !== 'ttw:hello') return;
  chrome.storage.local.get('drivingTab', s => reply(!!sender.tab && s.drivingTab === sender.tab.id));
  return true;
});

// Closing the panel stops the run (the runner kills claude), so turn the effects off too.
chrome.runtime.onConnect.addListener(port => port.onDisconnect.addListener(async () => {
  const { drivingTab } = await chrome.storage.local.get('drivingTab');
  if (drivingTab == null) return;
  chrome.storage.local.remove('drivingTab');
  chrome.tabs.sendMessage(drivingTab, { ttw: 'off' }).catch(() => {});
}));
