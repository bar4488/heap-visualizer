// Two globals the app really does add to the DOM, declared once so the
// checker knows about them instead of every use site casting.

interface Window {
  /** The `UI` object, exposed for console poking and hand-verification. */
  __heap_visualizer?: any;
}

interface Element {
  /** setHtml's memo of the last markup it assigned (src/web/shell/dom.ts). */
  _lastHtml?: string;
  /** The allocation a pinned detail window is showing (src/web/main.js). */
  _allocInfo?: any;
}

/** A Worker that only accepts protocol messages — see src/web/protocol.ts. */
interface TypedWorker extends Omit<Worker, 'postMessage'> {
  postMessage(m: import('./protocol.ts').ToWorker, transfer?: Transferable[]): void;
  onmessage: ((this: Worker, ev: MessageEvent<import('./protocol.ts').FromWorker>) => any) | null;
}
