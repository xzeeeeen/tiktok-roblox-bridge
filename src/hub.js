// Broadcaster Server-Sent Events untuk dashboard realtime.
export class Hub {
  constructor() {
    this.clients = new Set();
    this.hb = setInterval(() => this.#raw(': ping\n\n'), 20000);
    this.hb.unref();
  }
  add(req, res, snapshot) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    if (snapshot) res.write(this.#fmt('snapshot', snapshot));
  }
  #fmt(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
  #raw(chunk) { for (const c of this.clients) { try { c.write(chunk); } catch { this.clients.delete(c); } } }
  broadcast(event, data) { if (this.clients.size) this.#raw(this.#fmt(event, data)); }
}
