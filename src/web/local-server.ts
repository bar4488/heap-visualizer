export type LocalServerConfig = { baseURL: string; token: string };
export type LocalSession = {
  apiVersion: 1;
  mode: 'local';
  serverVersion: string;
  trace: { id: string; name: string; bytes: number; url: string };
};

export type LocalServerStatus =
  | { state: 'standalone' }
  | { state: 'connecting' }
  | { state: 'connected'; version: string; session: LocalSession }
  | { state: 'auth-failed' }
  | { state: 'permission-denied' }
  | { state: 'unreachable' };

const STORAGE_KEY = 'heapviz:local-server';

type StoredConfig = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type HistoryLike = Pick<History, 'replaceState'>;
type LocationLike = Pick<Location, 'hash' | 'pathname' | 'search'>;

/**
 * Read a server launch fragment once, persist it only for this tab, and remove
 * the capability from browser history. An ordinary new tab has no fragment or
 * sessionStorage entry and therefore stays standalone.
 */
export function localServerConfig(
  location: LocationLike,
  storage: StoredConfig,
  history: HistoryLike,
): LocalServerConfig | null {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const baseURL = fragment.get('heap-server');
  const token = fragment.get('heap-token');
  if (baseURL !== null || token !== null) {
    fragment.delete('heap-server');
    fragment.delete('heap-token');
    const rest = fragment.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
    const config = validConfig(baseURL, token);
    if (!config) return null;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* unavailable storage */ }
    return config;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validConfig(parsed?.baseURL, parsed?.token);
  } catch {
    return null;
  }
}

function validConfig(baseURL: unknown, token: unknown): LocalServerConfig | null {
  if (typeof baseURL !== 'string' || typeof token !== 'string' || token.length < 32) return null;
  try {
    const url = new URL(baseURL);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return { baseURL: url.origin, token };
  } catch {
    return null;
  }
}

/** Parse the deployment-agnostic string printed by the local binary. */
export function parseLocalServerConnection(value: string): LocalServerConfig | null {
  try {
    const url = new URL(value.trim());
    const token = url.hash.replace(/^#/, '');
    url.hash = '';
    return validConfig(url.href, token);
  } catch {
    return null;
  }
}

function retainLocalServerConfig(config: LocalServerConfig, storage: StoredConfig) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* unavailable storage */ }
}

export function forgetLocalServerConfig(storage: StoredConfig) {
  try { storage.removeItem(STORAGE_KEY); } catch { /* unavailable storage */ }
}

type PermissionStateReader = () => Promise<PermissionState | null>;

export async function connectLocalServer(
  config: LocalServerConfig | null,
  fetchFn: typeof fetch = fetch,
  permissionState: PermissionStateReader = loopbackPermissionState,
): Promise<LocalServerStatus> {
  if (!config) return { state: 'standalone' };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      // targetAddressSpace is the current Local Network Access hint. It is
      // intentionally progressive: browsers that do not know it ignore it.
      const init: RequestInit & { targetAddressSpace?: 'loopback' } = {
        headers: { Authorization: `Bearer ${config.token}` },
        cache: 'no-store',
        signal: controller.signal,
        targetAddressSpace: 'loopback',
      };
      const response = await fetchFn(`${config.baseURL}/api/v1/session`, init);
      if (response.status === 401) return { state: 'auth-failed' };
      if (!response.ok) return { state: 'unreachable' };
      const body = await response.json();
      if (body?.apiVersion !== 1 || body?.mode !== 'local') return { state: 'unreachable' };
      if (!body.trace
          || typeof body.trace.id !== 'string' || !body.trace.id
          || typeof body.trace.name !== 'string'
          || !Number.isSafeInteger(body.trace.bytes) || body.trace.bytes < 0
          || typeof body.trace.url !== 'string') {
        return { state: 'unreachable' };
      }
      const traceURL = new URL(body.trace.url, config.baseURL);
      if (traceURL.origin !== config.baseURL || !body.trace.url.startsWith('/')) {
        return { state: 'unreachable' };
      }
      return { state: 'connected', version: String(body.serverVersion || ''), session: body };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return await permissionState() === 'denied'
      ? { state: 'permission-denied' }
      : { state: 'unreachable' };
  }
}

async function loopbackPermissionState(): Promise<PermissionState | null> {
  if (!navigator.permissions) return null;
  // Chrome 145 split loopback from broader local-network permission; older
  // releases used local-network-access. Neither name is in every DOM lib yet.
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      return (await navigator.permissions.query({ name } as PermissionDescriptor)).state;
    } catch { /* try the older spelling */ }
  }
  return null;
}

const STATUS_TEXT: Record<LocalServerStatus['state'], string> = {
  standalone: 'standalone',
  connecting: 'connecting to local server…',
  connected: 'local server',
  'auth-failed': 'local server: authentication failed',
  'permission-denied': 'local server: browser permission denied',
  unreachable: 'local server: unavailable or blocked',
};

export async function initLocalServerMode(
  element: HTMLElement,
  button: HTMLButtonElement,
  onStatus: (config: LocalServerConfig | null, status: LocalServerStatus) => void = () => {},
) {
  let config = localServerConfig(window.location, window.sessionStorage, window.history);
  let generation = 0;

  function updateButton() {
    button.textContent = config ? 'Disconnect' : 'Connect…';
    button.title = config
      ? 'Disconnect this tab from the local data server'
      : 'Connect this tab to a local data server';
  }

  async function connect(config: LocalServerConfig | null) {
    const mine = ++generation;
    setStatus(element, config ? { state: 'connecting' } : { state: 'standalone' });
    const status = await connectLocalServer(config);
    if (mine !== generation) return;
    setStatus(element, status);
    onStatus(config, status);
  }

  button.onclick = () => {
    if (config) {
      config = null;
      generation++;
      forgetLocalServerConfig(window.sessionStorage);
      updateButton();
      const status: LocalServerStatus = { state: 'standalone' };
      setStatus(element, status);
      onStatus(config, status);
      return;
    }
    const value = window.prompt('Paste the connection string printed by heap-visualizer-local-server:');
    if (value === null) return;
    const next = parseLocalServerConnection(value);
    if (!next) {
      element.dataset.state = 'unreachable';
      element.textContent = 'local server: invalid connection string';
      element.title = 'Expected the loopback connection string printed by the local server';
      return;
    }
    config = next;
    retainLocalServerConfig(config, window.sessionStorage);
    updateButton();
    void connect(config);
  };

  updateButton();
  await connect(config);
}

function setStatus(element: HTMLElement, status: LocalServerStatus) {
  element.dataset.state = status.state;
  element.textContent = STATUS_TEXT[status.state];
  element.title = status.state === 'connected'
    ? `Connected to the local data server${status.version ? ` v${status.version}` : ''}; rendering remains in this browser`
    : status.state === 'standalone'
      ? 'This tab is fully standalone; it has not contacted a local server'
      : STATUS_TEXT[status.state];
}
