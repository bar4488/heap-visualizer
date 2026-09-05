import test from 'node:test';
import assert from 'node:assert/strict';

import { initRpc, handleReply } from '../rpc.ts';
import {
  changeAnalysis, readAnalysis, subscribeAnalysisDocuments, useServerAnalysis,
} from '../analysis-port.ts';

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

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const method = init?.method || 'GET';
    const url = String(input);
    requests.push(`${method} ${new URL(url).pathname}`);
    if (url.includes('/api/v1/changes?')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
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
    assert.deepEqual(requests, [
      'GET /api/v1/analysis',
      'GET /api/v1/changes',
      'POST /api/v1/analysis/changes',
    ]);
    assert.deepEqual(
      workerMessages.filter((message) => message.type === 'analysis-change')[0].change,
      { type: 'putTag', id: 'leak', name: 'Leak', color: '#aabbcc' },
    );
  } finally {
    useServerAnalysis(null);
    globalThis.fetch = originalFetch;
  }
});

test('a configured but unconnected server is not a writable standalone adapter', async () => {
  useServerAnalysis({ baseURL: 'http://127.0.0.1:8631', token: 'secret' });
  try {
    await assert.rejects(
      changeAnalysis(initial, { type: 'deleteTag', id: 'missing' }),
      /not connected/,
    );
  } finally {
    useServerAnalysis(null);
  }
});

test('remote committed deltas are installed through the worker core', async () => {
  let workerDocument = initial;
  initRpc({
    postMessage(message) {
      if (message.type === 'analysis-replace') {
        workerDocument = message.document;
        queueMicrotask(() => handleReply({
          type: 'analysis-replace-result', reqId: message.reqId, ok: true, revision: workerDocument.revision,
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

  let feeds = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/api/v1/changes?')) {
      feeds++;
      if (feeds === 1) return Response.json({
        traceId: 'trace', revision: 1, reset: false,
        changes: [{
          revision: 1,
          change: { type: 'putTag', id: 'leak', name: 'Leak', color: '#aabbcc' },
        }],
      });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return Response.json({ traceId: 'trace', document: initial });
  };
  useServerAnalysis({ baseURL: 'http://127.0.0.1:8631', token: 'secret' }, 'trace');
  let resolveUpdate!: (document: typeof changed) => void;
  const update = new Promise<typeof changed>((resolve) => { resolveUpdate = resolve; });
  const unsubscribe = subscribeAnalysisDocuments((document) => resolveUpdate(document as typeof changed));
  try {
    await readAnalysis();
    assert.deepEqual(await update, changed);
    assert.deepEqual(workerDocument, changed);
  } finally {
    unsubscribe();
    useServerAnalysis(null);
    globalThis.fetch = originalFetch;
  }
});
