import type { EngineTransport } from './stockfish-engine';

/**
 * The real transport: a Web Worker running Stockfish compiled to WebAssembly.
 *
 * The script is served from /public, put there by scripts/fetch-stockfish.mjs. The URL is a
 * plain string on purpose — `new Worker(new URL(...))` would make the bundler take ownership of
 * the file, and the Emscripten glue finds its .wasm by resolving a relative path against its
 * own location, which only holds while the two files stay side by side where we put them.
 */

/** Both halves of the name matter: `lite` is the small net, `single` is the no-threads build. */
export const ENGINE_SCRIPT_URL = '/engines/stockfish-18-lite-single.js';

export interface WorkerTransportOptions {
  scriptUrl?: string;
  /** Every line the engine emits. Used by the `?engineLog=1` debug switch. */
  onLine?: (line: string) => void;
  /** The worker failed to load or threw. Almost always a missing engine file. */
  onError?: (error: Error) => void;
}

export function createWorkerTransport(options: WorkerTransportOptions = {}): EngineTransport {
  const worker = new Worker(options.scriptUrl ?? ENGINE_SCRIPT_URL);
  const listeners = new Set<(line: string) => void>();

  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (typeof event.data !== 'string') return;
    // One message can carry several lines; the rest of the stack is line-based.
    for (const raw of event.data.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      options.onLine?.(line);
      for (const listener of [...listeners]) listener(line);
    }
  });

  worker.addEventListener('error', (event: ErrorEvent) => {
    options.onError?.(new Error(event.message || 'the engine worker failed to start'));
  });

  return {
    send(command) {
      worker.postMessage(command);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    terminate() {
      listeners.clear();
      worker.terminate();
    },
  };
}
