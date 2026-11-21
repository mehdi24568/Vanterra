/**
 * Desktop bridge: serves the AI service's HTTP-style middleware to Fetch API requests.
 *
 * In the desktop app the page is loaded from a private `app://` scheme and its `/api/ai/*`
 * requests are handled inside the application through this bridge, so the product runs no
 * local web server and opens no port. The same middleware (and its checks: same-origin
 * JSON only, schema-validated context, size limit) serves the web build and the desktop.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** Minimal ServerResponse: enough for writeHead / write / end / on('close'), streamed out. */
class BridgedResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  writableEnded = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private pending: Uint8Array[] = [];
  private started = false;
  readonly stream: ReadableStream<Uint8Array>;

  constructor(private readonly onStart: () => void) {
    super();
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
        for (const chunk of this.pending) c.enqueue(chunk);
        this.pending = [];
      },
      // The page stopped reading (closed, navigated away, cancelled): tell the service.
      cancel: () => this.finish(),
    });
  }

  writeHead(code: number, headers?: Record<string, string>): this {
    this.statusCode = code;
    if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
    this.begin();
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = String(value);
  }

  write(chunk: string | Uint8Array): boolean {
    this.begin();
    if (this.writableEnded) return false;
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    if (this.controller) this.controller.enqueue(bytes);
    else this.pending.push(bytes);
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk);
    this.begin();
    if (!this.writableEnded) {
      this.writableEnded = true;
      try {
        this.controller?.close();
      } catch {
        /* already cancelled by the reader */
      }
      this.finish();
    }
    return this;
  }

  private begin(): void {
    if (!this.started) {
      this.started = true;
      this.onStart();
    }
  }

  private finish(): void {
    this.writableEnded = true;
    this.emit('close');
  }
}

/**
 * Runs `handle` for one request. Resolves with the response as soon as the middleware starts
 * answering (so streams flow), or with null when the middleware passes the request on.
 */
export async function handleWithMiddleware(handle: Middleware, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
  const req = Readable.from(body.length ? [body] : []) as unknown as IncomingMessage;
  req.method = request.method;
  req.url = url.pathname + url.search;
  // The page's own origin is app://<host>; the host header lets the same-origin check compare them.
  req.headers = { host: url.host, ...Object.fromEntries([...request.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])) };

  return new Promise<Response | null>((resolve) => {
    const res: BridgedResponse = new BridgedResponse(() => resolve(new Response(res.stream, { status: res.statusCode, headers: res.headers })));
    try {
      handle(req, res as unknown as ServerResponse, () => resolve(null));
    } catch {
      resolve(new Response(JSON.stringify({ error: 'internal', message: 'The AI service failed.' }), { status: 500, headers: { 'content-type': 'application/json' } }));
    }
  });
}
