import { EventEmitter } from 'node:events';
import { config } from './config.js';

const pick = (...v) => v.find((x) => x !== undefined && x !== null);

function normUser(d) {
  return {
    userId: String(pick(d.user?.userId, d.userId, '') ?? ''),
    uniqueId: pick(d.user?.uniqueId, d.uniqueId, 'unknown'),
    nickname: pick(d.user?.nickname, d.nickname, d.user?.uniqueId, d.uniqueId, 'unknown'),
  };
}

/**
 * Pembungkus tiktok-live-connector.
 * - Hanya butuh username (tanpa @) akun yang sedang LIVE. Tidak perlu login/API TikTok Studio.
 * - Auto-reconnect dengan backoff, dan opsi "tunggu sampai live".
 * Emit: 'event' (event ternormalisasi), 'status' (state berubah)
 */
export class TikTokBridge extends EventEmitter {
  constructor() {
    super();
    this.conn = null;
    this.wanted = false;
    this.retryTimer = null;
    this.attempt = 0;
    this.opts = {};
    this.state = {
      status: 'idle', // idle | connecting | connected | waiting | ended | error
      username: null, roomId: null, viewers: 0, error: null, connectedAt: null, attempt: 0,
    };
  }

  #set(patch) {
    Object.assign(this.state, patch);
    this.emit('status', { ...this.state });
  }

  async connect(username, opts = {}) {
    const clean = String(username || '').replace(/^@/, '').trim();
    if (!clean) throw new Error('Username TikTok wajib diisi.');
    await this.disconnect(true);
    this.wanted = true;
    this.attempt = 0;
    this.opts = {
      signApiKey: opts.signApiKey || config.TIKTOK_SIGN_API_KEY || undefined,
      sessionId: opts.sessionId || config.TIKTOK_SESSION_ID || undefined,
      waitForLive: opts.waitForLive ?? config.TIKTOK_WAIT_FOR_LIVE,
    };
    this.#set({ username: clean, status: 'connecting', error: null, roomId: null, viewers: 0 });
    await this.#attempt();
  }

  async disconnect(silent = false) {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    const c = this.conn; this.conn = null;
    if (c) { try { c.removeAllListeners?.(); await c.disconnect(); } catch { /* abaikan */ } }
    if (!silent) this.#set({ status: 'idle', roomId: null, viewers: 0, error: null, connectedAt: null });
  }

  async #loadLib() {
    let lib;
    try { lib = await import('tiktok-live-connector'); }
    catch { throw new Error('Package "tiktok-live-connector" belum terpasang. Jalankan: npm install'); }
    const Conn = lib.TikTokLiveConnection || lib.WebcastPushConnection || lib.default?.TikTokLiveConnection || lib.default?.WebcastPushConnection;
    if (!Conn) throw new Error('Versi tiktok-live-connector tidak dikenali (class koneksi tidak ditemukan).');
    return Conn;
  }

  async #attempt() {
    if (!this.wanted) return;
    this.attempt++;
    this.state.attempt = this.attempt;
    let Conn;
    try { Conn = await this.#loadLib(); }
    catch (e) { this.wanted = false; return this.#set({ status: 'error', error: e.message }); }

    const conn = new Conn(this.state.username, {
      processInitialData: false,
      enableExtendedGiftInfo: true,
      signApiKey: this.opts.signApiKey,
      sessionId: this.opts.sessionId,
    });
    this.conn = conn;
    this.#wire(conn);

    try {
      const info = await conn.connect();
      this.attempt = 0;
      this.#set({
        status: 'connected', error: null, connectedAt: Date.now(),
        roomId: String(pick(info?.roomId, conn.roomId, '') ?? ''),
      });
    } catch (e) {
      const msg = String(e?.message || e);
      this.conn = null;
      if (!this.wanted) return;
      const offline = /offline|not live|LIVE has ended|isn't online|UserOfflineError/i.test(msg);
      if (offline && !this.opts.waitForLive) {
        this.wanted = false;
        return this.#set({ status: 'error', error: 'Akun sedang tidak LIVE.' });
      }
      const delay = Math.min(60000, 5000 * Math.pow(1.6, Math.min(this.attempt, 6)));
      this.#set({
        status: offline ? 'waiting' : 'connecting',
        error: offline ? 'Menunggu akun mulai LIVE…' : msg.slice(0, 200),
      });
      this.retryTimer = setTimeout(() => this.#attempt(), delay);
    }
  }

  #scheduleReconnect(reason) {
    if (!this.wanted) return;
    this.conn = null;
    this.#set({ status: 'connecting', error: reason });
    this.retryTimer = setTimeout(() => this.#attempt(), 3000);
  }

  #wire(c) {
    const emit = (e) => this.emit('event', { source: 'tiktok', ...e });

    c.on('chat', (d) => emit({ type: 'chat', user: normUser(d), comment: String(d.comment ?? '') }));

    c.on('gift', (d) => {
      const giftType = pick(d.giftType, d.giftDetails?.giftType);
      const repeatEnd = pick(d.repeatEnd, true);
      // Gift beruntun (giftType 1) dikirim berkali-kali; proses hanya saat streak selesai.
      if (giftType === 1 && !repeatEnd) return;
      emit({
        type: 'gift', user: normUser(d),
        giftName: String(pick(d.giftName, d.giftDetails?.giftName, 'Gift')),
        diamonds: Number(pick(d.diamondCount, d.giftDetails?.diamondCount, 0)) || 0,
        repeatCount: Number(pick(d.repeatCount, 1)) || 1,
      });
    });

    c.on('like', (d) => emit({
      type: 'like', user: normUser(d),
      likeCount: Number(pick(d.likeCount, 1)) || 1,
      totalLikeCount: Number(pick(d.totalLikeCount, 0)) || 0,
    }));

    c.on('follow', (d) => emit({ type: 'follow', user: normUser(d) }));
    c.on('share', (d) => emit({ type: 'share', user: normUser(d) }));
    c.on('roomUser', (d) => { this.state.viewers = Number(d.viewerCount) || 0; this.emit('status', { ...this.state }); });

    c.on('streamEnd', () => {
      this.wanted = false;
      this.#set({ status: 'ended', error: 'LIVE telah berakhir.', roomId: null });
    });
    c.on('disconnected', () => this.#scheduleReconnect('Terputus, mencoba sambung ulang…'));
    c.on('error', (e) => { this.state.error = String(e?.message || e).slice(0, 200); });
  }
}
