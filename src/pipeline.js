import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { getMappings, resolveGiftEffect } from './mappings.js';
import { parseSpawnComment } from './validation.js';

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/**
 * Menerima event TikTok yang sudah dinormalisasi, menerapkan aturan (mapping),
 * lalu memasukkan aksi (spawn / effect) ke antrean Roblox.
 */
export class Pipeline extends EventEmitter {
  constructor(queue) {
    super();
    this.queue = queue;
    this.feed = [];
    this.robloxCooldown = new Map();
    this.tiktokCooldown = new Map();
    this.likes = { total: 0, lastMilestone: 0 };
    this.counters = { chat: 0, gift: 0, like: 0, follow: 0, share: 0, diamonds: 0 };
  }

  resetSession() {
    this.likes = { total: 0, lastMilestone: 0 };
    this.counters = { chat: 0, gift: 0, like: 0, follow: 0, share: 0, diamonds: 0 };
  }

  #cooling(map, key, seconds) {
    const now = Date.now();
    const last = map.get(key) || 0;
    if (seconds > 0 && now - last < seconds * 1000) return Math.ceil((seconds * 1000 - (now - last)) / 1000);
    return 0;
  }

  #push(type, payload, key) {
    const r = this.queue.enqueue(type, { ...payload, ...(key ? { key } : {}) });
    return r.ok ? { ok: true, id: r.item.id } : { ok: false, reason: r.error };
  }

  handle(raw) {
    const m = getMappings();
    const ev = { id: crypto.randomUUID(), ts: Date.now(), ...raw };
    const user = ev.user || {};
    const from = { uniqueId: user.uniqueId || 'unknown', nickname: user.nickname || user.uniqueId || 'unknown' };
    const out = [];

    if (ev.type in this.counters) this.counters[ev.type]++;

    switch (ev.type) {
      case 'chat': {
        if (!m.comment.enabled) break;
        const parsed = parseSpawnComment(ev.comment, m.comment);
        if (!parsed) break;
        const name = parsed.username;
        const wait1 = this.#cooling(this.tiktokCooldown, from.uniqueId.toLowerCase(), m.comment.perTikTokUserCooldownSeconds);
        const wait2 = this.#cooling(this.robloxCooldown, name.toLowerCase(), m.comment.perRobloxUserCooldownSeconds);
        if (wait1) { out.push(`ditolak: ${from.uniqueId} cooldown ${wait1}s`); break; }
        if (wait2) { out.push(`ditolak: ${name} cooldown ${wait2}s`); break; }
        if (this.queue.hasActive('spawn', name.toLowerCase())) { out.push(`ditolak: ${name} sudah di antrean`); break; }
        const r = this.#push('spawn', { robloxUsername: name, from, comment: ev.comment }, name.toLowerCase());
        if (r.ok) {
          this.tiktokCooldown.set(from.uniqueId.toLowerCase(), Date.now());
          this.robloxCooldown.set(name.toLowerCase(), Date.now());
          out.push(`spawn avatar "${name}"`);
        } else out.push(`ditolak: ${r.reason}`);
        break;
      }
      case 'gift': {
        const repeat = Math.max(1, ev.repeatCount || 1);
        const total = (ev.diamonds || 0) * repeat;
        this.counters.diamonds += total;
        const rule = resolveGiftEffect(ev.giftName, total);
        if (!rule) { out.push(`gift "${ev.giftName}" tanpa aturan`); break; }
        const r = this.#push('effect', {
          effect: rule.effect,
          params: { intensity: clamp(repeat, 1, 10), ...rule.params },
          gift: { name: ev.giftName, diamonds: ev.diamonds || 0, repeatCount: repeat, totalDiamonds: total },
          from,
        });
        out.push(r.ok ? `efek "${rule.effect}" (${rule.matched})` : `ditolak: ${r.reason}`);
        break;
      }
      case 'follow':
      case 'share': {
        const rule = m[ev.type];
        if (!rule?.enabled) break;
        const r = this.#push('effect', { effect: rule.effect, params: { intensity: 1 }, from });
        out.push(r.ok ? `efek "${rule.effect}"` : `ditolak: ${r.reason}`);
        break;
      }
      case 'like': {
        this.likes.total = Math.max(this.likes.total, ev.totalLikeCount || this.likes.total + (ev.likeCount || 1));
        const lm = m.likeMilestone;
        if (lm?.enabled && lm.every > 0) {
          const reached = Math.floor(this.likes.total / lm.every);
          if (reached > this.likes.lastMilestone) {
            this.likes.lastMilestone = reached;
            const r = this.#push('effect', {
              effect: lm.effect, params: { intensity: 3 },
              milestone: { totalLikes: reached * lm.every }, from,
            });
            out.push(r.ok ? `milestone ${reached * lm.every} like -> "${lm.effect}"` : `ditolak: ${r.reason}`);
          }
        }
        break;
      }
      default: break;
    }

    ev.outcome = out;
    // Like sangat berisik; hanya masuk feed jika memicu sesuatu
    if (ev.type !== 'like' || out.length) {
      this.feed.push(ev);
      if (this.feed.length > 200) this.feed.shift();
      this.emit('feed', ev);
    }
    return { event: ev, outcome: out };
  }
}
