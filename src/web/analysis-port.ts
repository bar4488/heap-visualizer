import { request } from './rpc.ts';
import type { LocalServerConfig } from './local-server.ts';

export type AnalysisDocument = {
  version: 1;
  revision: number;
  allocations: Record<string, { name?: string; color?: string; tags?: string[] }>;
  tags: Record<string, { name: string; color: string }>;
  bookmarks: Record<string, { name: string; seq: number; t: number }>;
  addressMarks: Record<string, { name: string; addr: string }>;
  savedFilters: Record<string, { name: string; source: string }>;
};

type ServerAnalysis = { config: LocalServerConfig; traceId: string | null; generation: number };

let server: ServerAnalysis | null = null;
let generation = 0;
let installed: AnalysisDocument | null = null;
let changeFeedController: AbortController | null = null;
let operationQueue: Promise<unknown> = Promise.resolve();
const subscribers = new Set<(document: AnalysisDocument) => void>();
const healthSubscribers = new Set<(state: 'connected' | 'auth-failed' | 'unreachable') => void>();

export function useServerAnalysis(config: LocalServerConfig | null, traceId?: string) {
  generation++;
  changeFeedController?.abort();
  changeFeedController = null;
  installed = null;
  server = config ? { config, traceId: traceId || null, generation } : null;
}

export function isServerAnalysis() { return server !== null; }

export function subscribeAnalysisDocuments(subscriber: (document: AnalysisDocument) => void) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function subscribeAnalysisServerHealth(subscriber: (state: 'connected' | 'auth-failed' | 'unreachable') => void) {
  healthSubscribers.add(subscriber);
  return () => healthSubscribers.delete(subscriber);
}

function reportHealth(state: 'connected' | 'auth-failed' | 'unreachable') {
  for (const subscriber of healthSubscribers) subscriber(state);
}

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

async function readWorkerAnalysis(): Promise<AnalysisDocument> {
  return (await request('analysis-get')).document as AnalysisDocument;
}

function serverInit(config: LocalServerConfig, method = 'GET', body?: unknown): RequestInit & { targetAddressSpace: 'loopback' } {
  return {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    targetAddressSpace: 'loopback',
  };
}

export async function readAnalysis(): Promise<AnalysisDocument> {
  if (!server) {
    return readWorkerAnalysis();
  }
  if (!server.traceId) throw new Error('local server is not connected');
  const active = server;
  const document = await serial(() => readServerSnapshot(active));
  startChangeFeed(active);
  return document;
}

async function readServerSnapshot(active: ServerAnalysis): Promise<AnalysisDocument> {
  if (!active.traceId) throw new Error('local server is not connected');
  if (server?.generation !== active.generation) throw new Error('local server connection changed');
  const response = await fetch(`${active.config.baseURL}/api/v1/analysis`, serverInit(active.config));
  if (!response.ok) {
    reportHealth(response.status === 401 ? 'auth-failed' : 'unreachable');
    throw new Error(`analysis read failed: ${response.status}`);
  }
  reportHealth('connected');
  const body = await response.json();
  if (body?.traceId !== active.traceId) throw new Error('analysis belongs to a different trace');
  if (server?.generation !== active.generation) throw new Error('local server connection changed');
  const document = body.document as AnalysisDocument;
  const installed = await request('analysis-replace', { document });
  if (!installed.ok) throw new Error(installed.message || 'analysis rejected by browser core');
  if (server?.generation !== active.generation) throw new Error('local server connection changed');
  globalsInstalled(document);
  return document;
}

function globalsInstalled(document: AnalysisDocument) {
  installed = document;
}

export async function changeAnalysis(document: AnalysisDocument, change: unknown): Promise<AnalysisDocument> {
  if (!server) {
    const result = await request('analysis-change', {
      expectedRevision: document.revision,
      change,
    });
    if (!result.ok) throw new Error(result.error === 'conflict' ? 'analysis revision changed' : result.message);
    return readWorkerAnalysis();
  }
  if (!server.traceId) throw new Error('local server is not connected');
  const active = server;
  return serial(async () => {
    if (server?.generation !== active.generation) throw new Error('local server connection changed');
    // Low-level renderer previews (range tagging and live color input) must not
    // leak into the canonical connected document if the HTTP commit fails.
    const restored = await request('analysis-replace', { document });
    if (!restored.ok) throw new Error(restored.message || 'analysis rejected by browser core');
    globalsInstalled(document);
    const response = await fetch(
      `${active.config.baseURL}/api/v1/analysis/changes`,
      serverInit(active.config, 'POST', {
        traceId: active.traceId,
        expectedRevision: document.revision,
        change,
      }),
    );
    if (!response.ok) {
      if (response.status !== 409) reportHealth(response.status === 401 ? 'auth-failed' : 'unreachable');
      throw new Error(response.status === 409 ? 'analysis revision changed' : `analysis change failed: ${response.status}`);
    }
    reportHealth('connected');
    const committed = await response.json();
    if (committed.traceId !== active.traceId || committed.revision !== document.revision + 1) {
      throw new Error('analysis change returned an unexpected revision');
    }
    if (server?.generation !== active.generation) throw new Error('local server connection changed');
    const applied = await request('analysis-change', {
      expectedRevision: document.revision,
      change: committed.change,
    });
    if (!applied.ok || applied.revision !== committed.revision) {
      throw new Error(applied.message || 'committed analysis delta was rejected by browser core');
    }
    const next = await readWorkerAnalysis();
    globalsInstalled(next);
    return next;
  });
}

export async function replaceStandaloneAnalysis(document: AnalysisDocument): Promise<AnalysisDocument> {
  if (server) throw new Error('connected analysis cannot be replaced from browser state');
  const installed = await request('analysis-replace', { document });
  if (!installed.ok) throw new Error(installed.message || 'analysis rejected by browser core');
  return readAnalysis();
}

function startChangeFeed(active: ServerAnalysis) {
  if (changeFeedController || !active.traceId) return;
  const controller = new AbortController();
  changeFeedController = controller;
  void runChangeFeed(active, controller).finally(() => {
    if (changeFeedController === controller) changeFeedController = null;
  });
}

async function runChangeFeed(active: ServerAnalysis, controller: AbortController) {
  while (!controller.signal.aborted && server?.generation === active.generation) {
    try {
      const after = installed?.revision;
      if (after === undefined) return;
      const response = await fetch(
        `${active.config.baseURL}/api/v1/changes?after=${after}&wait=25`,
        { ...serverInit(active.config), signal: controller.signal },
      );
      if (!response.ok) {
        reportHealth(response.status === 401 ? 'auth-failed' : 'unreachable');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      reportHealth('connected');
      const body = await response.json();
      if (body?.traceId !== active.traceId || !Array.isArray(body.changes)) {
        throw new Error('invalid analysis changes response');
      }
      await serial(async () => {
        if (server?.generation !== active.generation) return;
        if (body.reset) {
          const document = await readServerSnapshot(active);
          notifySubscribers(document);
          return;
        }
        for (const committed of body.changes) {
          if (!installed || committed.revision <= installed.revision) continue;
          if (committed.revision !== installed.revision + 1) {
            const document = await readServerSnapshot(active);
            notifySubscribers(document);
            return;
          }
          const applied = await request('analysis-change', {
            expectedRevision: installed.revision,
            change: committed.change,
          });
          if (!applied.ok || applied.revision !== committed.revision) {
            const document = await readServerSnapshot(active);
            notifySubscribers(document);
            return;
          }
          globalsInstalled(await readWorkerAnalysis());
          notifySubscribers(installed!);
        }
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      reportHealth('unreachable');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function notifySubscribers(document: AnalysisDocument) {
  for (const subscriber of subscribers) subscriber(document);
}

export function persistentId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
