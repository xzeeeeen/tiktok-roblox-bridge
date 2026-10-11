import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Antrean aksi untuk Roblox. FIFO, dengan "lease":
 * Roblox claim -> status processing -> harus ack dalam CLAIM_LEASE_SECONDS,
 * kalau tidak, job dikembalikan ke antrean (atau gagal jika sudah terlalu sering dicoba).
 */
export class ActionQueue extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      maxQueue: config.MAX_QUEUE_SIZE,
      leaseMs: config.CLAIM_LEASE_SECONDS * 1000,
      ttlMs: config.EVENT_TTL_SECONDS * 1000,
      maxAttempts: config.MAX_ATTEMPTS,
      keepFinished: 500,
      ...opts,
    };
    this.items = new Map();
    this.totals = { enqueued: 0, done: 0, failed: 0, expired: 0 };
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.sweep(), 2000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  #active() {
    let n = 0;
    for (const it of this.items.values()) if (it.status === 'queued' || it.status === 'processing') n++;
    return n;
  }
  #touch(it, patch) {
    Object.assign(it, patch, { updatedAt: Date.now() });
    this.emit('change', { ...it });
  }

  enqueue(type, payload) {
    if (this.#active() >= this.opts.maxQueue) return { ok: false, code: 'QUEUE_FULL', error: 'Antrean penuh.' };
    const now = Date.now();
    const item = {
      id: crypto.randomUUID(), type, status: 'queued', payload,
      createdAt: now, updatedAt: now, attempts: 0, workerId: null, claimedAt: null, error: null,
    };
    this.items.set(item.id, item);
    this.totals.enqueued++;
    this.emit('change', { ...item });
    return { ok: true, item: { ...item } };
  }

  hasActive(type, key) {
    for (const it of this.items.values()) {
      if (it.type === type && (it.status === 'queued' || it.status === 'processing') && it.payload?.key === key) return true;
    }
    return false;
  }

  claim(workerId, max = 5) {
    this.sweep();
    const out = [];
    for (const it of this.items.values()) { // Map menjaga urutan insert = FIFO
      if (out.length >= Math.min(Math.max(1, max), 20)) break;
      if (it.status !== 'queued') continue;
      this.#touch(it, { status: 'processing', workerId, claimedAt: Date.now(), attempts: it.attempts + 1 });
      out.push({ ...it });
    }
    return out;
  }

  ack(results = [], workerId = null) {
    let updated = 0; const unknown = [];
    for (const r of results) {
      const it = this.items.get(r?.id);
      if (!it || it.status !== 'processing') { unknown.push(r?.id); continue; }
      if (workerId && it.workerId && it.workerId !== workerId) { unknown.push(r.id); continue; }
      if (r.status === 'done') { this.totals.done++; this.#touch(it, { status: 'done', error: null }); }
      else { this.totals.failed++; this.#touch(it, { status: 'failed', error: String(r.error || 'unknown').slice(0, 200) }); }
      updated++;
    }
    return { updated, unknown };
  }

  sweep() {
    const now = Date.now();
    for (const it of this.items.values()) {
      if (it.status === 'processing' && now - it.claimedAt > this.opts.leaseMs) {
        if (it.attempts >= this.opts.maxAttempts) {
          this.totals.failed++;
          this.#touch(it, { status: 'failed', error: 'Lease habis (Roblox tidak mengirim ack).' });
        } else this.#touch(it, { status: 'queued', workerId: null, claimedAt: null });
      } else if (it.status === 'queued' && now - it.createdAt > this.opts.ttlMs) {
        this.totals.expired++;
        this.#touch(it, { status: 'expired', error: 'Tidak diambil Roblox tepat waktu.' });
      }
    }
    const finished = [...this.items.values()].filter((i) => !['queued', 'processing'].includes(i.status));
    for (const it of finished.slice(0, Math.max(0, finished.length - this.opts.keepFinished))) this.items.delete(it.id);
  }

  list({ status, limit = 50 } = {}) {
    const all = [...this.items.values()].filter((i) => !status || i.status === status);
    return all.slice(-limit).reverse().map((i) => ({ ...i }));
  }

  stats() {
    const by = { queued: 0, processing: 0, done: 0, failed: 0, expired: 0 };
    for (const it of this.items.values()) by[it.status] = (by[it.status] || 0) + 1;
    return { ...by, totals: { ...this.totals }, max: this.opts.maxQueue };
  }

  clear() { const n = this.items.size; this.items.clear(); this.emit('cleared'); return n; }
}
