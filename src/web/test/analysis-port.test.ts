import test from 'node:test';
import assert from 'node:assert/strict';

import { initRpc, handleReply } from '../rpc.ts';
import { changeAnalysis, readAnalysis, useServerAnalysis } from '../analysis-port.ts';

const initial = {
  version: 1 as const,
  revision: 0,
  allocations: {},
  tags: {},
  bookmarks: {},
  addressMarks: {},
  savedFilters: {},
};
const changed = {
  ...initial,
  revision: 1,
  tags: { leak: { name: 'Leak', color: '#aabbcc' } },
};

test('the HTTP adapter installs the committed delta through the worker core', async () => {
  let workerDocument = initial;
  const workerMessages: any[] = [];
  initRpc({
    postMessage(message) {
      workerMessages.push(message);
      if (message.type === 'analysis-replace') {
        workerDocument = message.document;
        queueMicrotask(() => handleReply({
          type: 'analysis-replace-result', reqId: message.reqId, ok: true, revision: 0,
        }));
      } else if (message.type === 'analysis-change') {
        workerDocument = changed;
        queueMicrotask(() => handleReply({
          type: 'analysis-change-result', reqId: message.reqId, ok: true, revision: 1,
        }));
      } else if (message.type === 'analysis-get') {
        queueMicrotask(() => handleReply({
          type: 'analysis-get-result', reqId: message.reqId, document: workerDocument,
        }));
      }
    },
  });

  const methods: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const method = init?.method || 'GET';
    methods.push(method);
    if (method === 'GET') return Response.json({ traceId: 'trace', document: initial });
    return Response.json({
      traceId: 'trace', revision: 1,
      change: { type: 'putTag', id: 'leak', name: 'Leak', color: '#aabbcc' },
    });
  };
  useServerAnalysis({ baseURL: 'http://127.0.0.1:8631', token: 'secret' }, 'trace');
  try {
    const document = await readAnalysis();
    assert.deepEqual(await changeAnalysis(document, {
      type: 'putTag', id: 'leak', name: ' Leak ', color: '#AABBCC',
    }), changed);
    assert.deepEqual(methods, ['GET', 'POST']);
    assert.deepEqual(
      workerMessages.filter((message) => message.type === 'analysis-change')[0].change,
      { type: 'putTag', id: 'leak', name: 'Leak', color: '#aabbcc' },
    );
  } finally {
    useServerAnalysis(null);
    globalThis.fetch = originalFetch;
  }
});
