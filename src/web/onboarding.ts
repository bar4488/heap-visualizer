import { $, $$ } from './shell/dom.ts';
import type { LocalServerStatus } from './local-server.ts';

const SEEN_KEY = 'heapviz:onboarding-seen';

export function setupCommands(webURL: string) {
  const base = new URL('.', webURL).href.replace(/\/$/, '');
  return {
    linuxInstall: `curl -fsSL ${base}/install.sh | HEAPVIZ_DOWNLOAD_BASE=${base} sh`,
    linuxOpen: 'heapviz open ~/path/to/trace-file',
    linuxDemo: `curl -fL ${base}/demo.heapl -o heapviz-demo.heapl && heapviz open heapviz-demo.heapl`,
    windowsInstall: `$env:HEAPVIZ_DOWNLOAD_BASE='${base}'; irm ${base}/install.ps1 | iex`,
    windowsOpen: 'heapviz open "C:\\path\\to\\trace-file"',
    windowsDemo: `$demo=Join-Path $env:TEMP 'heapviz-demo.heapl'; irm ${base}/demo.heapl -OutFile $demo; heapviz open $demo`,
  };
}

function remember() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage may be unavailable */ }
}

function showInstall() {
  $('welcome').hidden = false;
  $('welcome-intro').hidden = true;
  $('welcome-install').hidden = false;
}

function selectOS(os: 'linux' | 'windows') {
  $('setup-linux').classList.toggle('active', os === 'linux');
  $('setup-windows').classList.toggle('active', os === 'windows');
  $('setup-linux-body').hidden = os !== 'linux';
  $('setup-windows-body').hidden = os !== 'windows';
}

export function setOnboardingConnectionStatus(status: LocalServerStatus) {
  if (status.state === 'connected' || status.state === 'connecting') {
    $('welcome').hidden = true;
    if (status.state === 'connected') remember();
    return;
  }
  if (!['auth-failed', 'permission-denied', 'upgrade-required', 'unreachable'].includes(status.state)) return;
  showInstall();
  const alert = $('setup-alert');
  alert.hidden = false;
  alert.textContent = status.state === 'upgrade-required'
    ? `This site requires heapviz ${status.minimum} or newer; installed: ${status.installed}. Run heapviz update.`
    : status.state === 'permission-denied'
      ? 'Your browser denied loopback access. Allow local-device access for this site, then reconnect.'
      : status.state === 'auth-failed'
        ? 'That connection has expired. Restart heapviz and use its new Browser connection.'
        : 'The local companion could not be reached. Keep its terminal open, then run heapviz doctor if the problem continues.';
}

export function initOnboarding(serverConfigured: () => boolean) {
  const commands = setupCommands(location.href);
  $('setup-linux-install').textContent = commands.linuxInstall;
  $('setup-linux-open').textContent = commands.linuxOpen;
  $('setup-linux-demo').textContent = commands.linuxDemo;
  $('setup-windows-install').textContent = commands.windowsInstall;
  $('setup-windows-open').textContent = commands.windowsOpen;
  $('setup-windows-demo').textContent = commands.windowsDemo;
  selectOS(/Windows/i.test(navigator.userAgent) ? 'windows' : 'linux');

  $('btn-setup').onclick = showInstall;
  $('welcome-setup').onclick = showInstall;
  $('welcome-back').onclick = () => {
    $('welcome-intro').hidden = false;
    $('welcome-install').hidden = true;
    $('setup-alert').hidden = true;
  };
  $('welcome-close').onclick = $('welcome-done').onclick = () => { remember(); $('welcome').hidden = true; };
  $('welcome-demo').onclick = () => {
    remember();
    $('welcome').hidden = true;
    $('btn-demo').click();
    if (!$('btn-guide').classList.contains('active')) $('btn-guide').click();
  };
  $('welcome-connect').onclick = () => {
    $('welcome').hidden = true;
    $('btn-connect').click();
  };
  $('setup-linux').onclick = () => selectOS('linux');
  $('setup-windows').onclick = () => selectOS('windows');
  for (const button of $$('[data-copy]', $('welcome'))) {
    button.onclick = async () => {
      const value = $(button.dataset.copy).textContent;
      try { await navigator.clipboard.writeText(value); button.textContent = 'Copied'; }
      catch { button.textContent = 'Select and copy'; }
    };
  }

  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* storage may be unavailable */ }
  if (!seen && !serverConfigured()) $('welcome').hidden = false;
}
