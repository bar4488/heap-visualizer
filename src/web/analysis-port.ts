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

let server: { config: LocalServerConfig; traceId: string } | null = null;

export function useServerAnalysis(config: LocalServerConfig | null, traceId?: string) {
  server = config && traceId ? { config, traceId } : null;
}

export function isServerAnalysis() { return server !== null; }

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
  const response = await fetch(`${server.config.baseURL}/api/v1/analysis`, serverInit(server.config));
  if (!response.ok) throw new Error(`analysis read failed: ${response.status}`);
  const document = (await response.json()).document as AnalysisDocument;
  const installed = await request('analysis-replace', { document });
  if (!installed.ok) throw new Error(installed.message || 'analysis rejected by browser core');
  return document;
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
  const response = await fetch(
    `${server.config.baseURL}/api/v1/analysis/changes`,
    serverInit(server.config, 'POST', {
      traceId: server.traceId,
      expectedRevision: document.revision,
      change,
    }),
  );
  if (!response.ok) throw new Error(response.status === 409 ? 'analysis revision changed' : `analysis change failed: ${response.status}`);
  const committed = await response.json();
  if (committed.traceId !== server.traceId || committed.revision !== document.revision + 1) {
    throw new Error('analysis change returned an unexpected revision');
  }
  const installed = await request('analysis-change', {
    expectedRevision: document.revision,
    change: committed.change,
  });
  if (!installed.ok || installed.revision !== committed.revision) {
    throw new Error(installed.message || 'committed analysis delta was rejected by browser core');
  }
  return readWorkerAnalysis();
}

export async function replaceStandaloneAnalysis(document: AnalysisDocument): Promise<AnalysisDocument> {
  if (server) throw new Error('connected analysis cannot be replaced from browser state');
  const installed = await request('analysis-replace', { document });
  if (!installed.ok) throw new Error(installed.message || 'analysis rejected by browser core');
  return readAnalysis();
}

export function persistentId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
