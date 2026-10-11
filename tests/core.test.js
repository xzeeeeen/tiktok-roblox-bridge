import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrb-'));
const { isValidRobloxUsername, parseSpawnComment } = await import('../src/validation.js');
const { ActionQueue } = await import('../src/queue.js');
const { Pipeline } = await import('../src/pipeline.js');
const { createApp } = await import('../src/app.js');

test('validasi username Roblox', () => {
  for (const ok of ['abc', 'Builder_man', 'xzeeeeen00', 'A1B2C3']) assert.ok(isValidRobloxUsername(ok), ok);
  for (const bad of ['ab', '_abc', 'abc_', 'a_b_c', 'a b c', 'abcdefghijklmnopqrstu', 'ab!c']) assert.ok(!isValidRobloxUsername(bad), bad);
});

test('parse komentar: mention, command, bare', () => {
  assert.deepEqual(parseSpawnComment('halo @xzeeeeen00 gas'), { username: 'xzeeeeen00' });
  assert.deepEqual(parseSpawnComment('!spawn Builder_man'), { username: 'Builder_man' });
  assert.deepEqual(parseSpawnComment('!SPAWN @abc123'), { username: 'abc123' });
  assert.equal(parseSpawnComment('halo semua'), null);
  assert.equal(parseSpawnComment('@ab'), null);
  assert.equal(parseSpawnComment('abc123'), null);
  assert.deepEqual(parseSpawnComment('abc123', { allowBareUsername: true }), { username: 'abc123' });
  assert.equal(parseSpawnComment('@abc123', { mode: 'command' }), null);
});

test('queue: FIFO, claim, ack, lease timeout & retry', async () => {
  const q = new ActionQueue({ leaseMs: 30, maxAttempts: 2, ttlMs: 10_000 });
  const a = q.enqueue('spawn', { key: 'a' }).item; q.enqueue('spawn', { key: 'b' });
  const got = q.claim('w1', 1);
  assert.equal(got.length, 1); assert.equal(got[0].id, a.id); assert.equal(got[0].status, 'processing');
  assert.equal(q.claim('w2', 5).length, 1); // hanya b yang tersisa
  assert.deepEqual(q.ack([{ id: a.id, status: 'done' }], 'w1'), { updated: 1, unknown: [] });
  assert.equal(q.ack([{ id: a.id, status: 'done' }], 'w1').unknown.length, 1); // double ack ditolak
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.claim('w3', 5).length, 1); // b kembali ke antrean, attempt ke-2
  await new Promise((r) => setTimeout(r, 50));
  q.sweep();
  assert.equal(q.stats().failed, 1); // attempt habis -> failed
});

test('queue: penuh & expired', async () => {
  const q = new ActionQueue({ maxQueue: 1, ttlMs: 20 });
  assert.ok(q.enqueue('effect', {}).ok);
  assert.equal(q.enqueue('effect', {}).code, 'QUEUE_FULL');
  await new Promise((r) => setTimeout(r, 40)); q.sweep();
  assert.equal(q.stats().expired, 1);
});

test('pipeline: komentar -> spawn, cooldown, duplikat', () => {
  const q = new ActionQueue(); const p = new Pipeline(q);
  const chat = (u, c) => p.handle({ type: 'chat', user: { uniqueId: u }, comment: c });
  assert.match(chat('viewer1', '@xzeeeeen00').outcome[0], /spawn avatar/);
  assert.match(chat('viewer1', '@other_one').outcome[0], /cooldown/);       // cooldown TikTok user
  assert.match(chat('viewer2', '@xzeeeeen00').outcome[0], /cooldown/);      // cooldown username Roblox
  assert.equal(q.stats().queued, 1);
});

test('pipeline: gift -> efek (nama, tier, streak intensity), like milestone', () => {
  const q = new ActionQueue(); const p = new Pipeline(q);
  p.handle({ type: 'gift', user: { uniqueId: 'a' }, giftName: 'Rose', diamonds: 1, repeatCount: 5 });
  p.handle({ type: 'gift', user: { uniqueId: 'a' }, giftName: 'Hadiah Aneh', diamonds: 400, repeatCount: 1 });
  p.handle({ type: 'like', user: { uniqueId: 'a' }, likeCount: 5, totalLikeCount: 250 });
  const items = q.list({ limit: 10 }).reverse();
  assert.equal(items[0].payload.effect, 'rose_rain'); assert.equal(items[0].payload.params.intensity, 5);
  assert.equal(items[1].payload.effect, 'fireworks');
  assert.equal(items[2].payload.effect, 'hearts');
});

test('HTTP end-to-end: auth, simulate, claim, ack, mappings', async () => {
  const app = createApp({ PORT: 0, HOST: '127.0.0.1', ADMIN_API_KEY: 'adm', ROBLOX_API_KEY: 'rbx' });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, { method = 'GET', key, rkey, body } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-api-key': key } : {}), ...(rkey ? { 'x-roblox-api-key': rkey } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    assert.equal((await call('/api/health')).json.data.status, 'ok');
    assert.equal((await call('/api/status')).status, 401);
    assert.equal((await call('/api/roblox/claim', { method: 'POST', rkey: 'salah', body: {} })).status, 401);
    assert.equal((await call('/api/roblox/claim', { method: 'POST', key: 'adm', body: {} })).status, 401); // admin key tidak berlaku di jalur Roblox

    const sim = await call('/api/simulate', { method: 'POST', key: 'adm', body: { type: 'chat', user: 'v1', comment: 'ayo @Builder_man' } });
    assert.equal(sim.status, 200);
    await call('/api/simulate', { method: 'POST', key: 'adm', body: { type: 'gift', user: 'v2', giftName: 'Rose', diamonds: 1, repeatCount: 3 } });

    const claim = await call('/api/roblox/claim', { method: 'POST', rkey: 'rbx', body: { workerId: 'jobA', max: 5 } });
    const items = claim.json.data.items;
    assert.equal(items.length, 2);
    assert.equal(items[0].type, 'spawn'); assert.equal(items[0].payload.robloxUsername, 'Builder_man');
    assert.equal(items[1].payload.effect, 'rose_rain');

    const ack = await call('/api/roblox/ack', { method: 'POST', rkey: 'rbx', body: { workerId: 'jobA', results: items.map((i) => ({ id: i.id, status: 'done' })) } });
    assert.equal(ack.json.data.updated, 2);
    assert.equal((await call('/api/roblox/claim', { method: 'POST', rkey: 'rbx', body: {} })).json.data.items.length, 0);

    const bad = await call('/api/mappings', { method: 'PUT', key: 'adm', body: { gifts: { X: {} } } });
    assert.equal(bad.status, 400);
    const good = await call('/api/mappings', { method: 'PUT', key: 'adm', body: { gifts: { Rose: { effect: 'confetti' } } } });
    assert.equal(good.json.data.gifts.Rose.effect, 'confetti');

    const script = await call('/api/roblox/script?base=https://contoh.trycloudflare.com', { key: 'adm' });
    assert.equal(script.status, 200);
  } finally { await app.stop(); }
});
