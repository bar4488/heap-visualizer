import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectLocalServer, localServerConfig, parseLocalServerConnection,
} from '../local-server.ts';

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem() { return value; },
    setItem(_key: string, next: string) { value = next; },
    value() { return value; },
  };
}

test('a launch capability is read from the fragment, saved for this tab, and removed from history', () => {
  const store = storage();
  let replaced = '';
  const config = localServerConfig(
    {
      hash: '#keep=yes&heap-server=http%3A%2F%2F127.0.0.1%3A8631&heap-token=0123456789abcdef0123456789abcdef',
      pathname: '/viewer',
      search: '?trace=demo.heapl',
    },
    store,
    { replaceState(_data: unknown, _unused: string, url?: string | URL | null) { replaced = String(url); } },
  );
  assert.deepEqual(config, {
    baseURL: 'http://127.0.0.1:8631',
    token: '0123456789abcdef0123456789abcdef',
  });
  assert.equal(replaced, '/viewer?trace=demo.heapl#keep=yes');
  assert.equal(JSON.parse(store.value()).token, config.token);

  const restored = localServerConfig(
    { hash: '', pathname: '/viewer', search: '' },
    store,
    { replaceState() { throw new Error('history is untouched on reload'); } },
  );
  assert.deepEqual(restored, config);
});

test('an ordinary tab is standalone and makes no request', async () => {
  let fetched = false;
  const status = await connectLocalServer(null, async () => {
    fetched = true;
    throw new Error('must not fetch');
  });
  assert.deepEqual(status, { state: 'standalone' });
  assert.equal(fetched, false);
});

test('a valid session response establishes connected mode', async () => {
  const status = await connectLocalServer(
    { baseURL: 'http://127.0.0.1:8631', token: 'x'.repeat(64) },
    async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${'x'.repeat(64)}`);
      return Response.json({ apiVersion: 1, mode: 'local', serverVersion: '0.1.0' });
    },
  );
  assert.deepEqual(status, { state: 'connected', version: '0.1.0' });
});

test('authentication failure is distinct', async () => {
  const status = await connectLocalServer(
    { baseURL: 'http://127.0.0.1:8631', token: 'x'.repeat(64) },
    async () => new Response('{}', { status: 401 }),
  );
  assert.deepEqual(status, { state: 'auth-failed' });
});

test('a denied loopback permission is distinct from an otherwise unreachable server', async () => {
  const config = { baseURL: 'http://127.0.0.1:8631', token: 'x'.repeat(64) };
  const fail = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await connectLocalServer(config, fail, async () => 'denied'), { state: 'permission-denied' });
  assert.deepEqual(await connectLocalServer(config, fail, async () => 'prompt'), { state: 'unreachable' });
});

test('a launch fragment cannot point the hosted app at a non-loopback service', () => {
  const config = localServerConfig(
    {
      hash: `#heap-server=${encodeURIComponent('https://attacker.example')}&heap-token=${'x'.repeat(64)}`,
      pathname: '/',
      search: '',
    },
    storage(),
    { replaceState() {} },
  );
  assert.equal(config, null);
});

test('the binary connection string names no web deployment', () => {
  assert.deepEqual(
    parseLocalServerConnection(`http://127.0.0.1:8631#${'a'.repeat(64)}`),
    { baseURL: 'http://127.0.0.1:8631', token: 'a'.repeat(64) },
  );
  assert.equal(parseLocalServerConnection(`https://viewer.example/#${'a'.repeat(64)}`), null);
  assert.equal(parseLocalServerConnection('http://127.0.0.1:8631#short'), null);
});
