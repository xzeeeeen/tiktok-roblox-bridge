# 🎮 TikTok → Roblox Bridge

Backend **Node.js** (tanpa framework, hanya 1 dependensi: `tiktok-live-connector`) + dashboard web + skrip Roblox.

```
TikTok LIVE ──► Backend Node.js ──(antrean)──◄ Roblox Server (polling HttpService)
 chat/gift       aturan + dashboard             spawn avatar / efek
```

- Komentar `@username` (atau `!spawn username`) → avatar Roblox pemilik username itu muncul.
- Gift (mis. Rose) → efek di Roblox, bisa diatur dari dashboard.
- Follow, share, dan milestone like juga bisa memicu efek.
- **Cukup username TikTok yang sedang LIVE.** Tidak perlu API TikTok Studio. API key Euler Stream (opsional) hanya untuk koneksi lebih stabil.

## Mulai cepat

```bash
npm install
npm start
```

Terminal mencetak `ADMIN_API_KEY` dan `ROBLOX_API_KEY` (disimpan di `data/secrets.json`). Buka `http://localhost:3000`, masukkan admin key, isi username TikTok, klik **Connect**.
Butuh Node.js 20.12+ (disarankan 22).

Belum LIVE? Pakai panel **Simulator** di dashboard: kirim komentar/gift palsu lewat jalur yang sama dengan event asli.

## Menghubungkan Roblox

1. **Buat URL publik.** Roblox tidak bisa mengakses `localhost`. Contoh gratis: `cloudflared tunnel --url http://localhost:3000` (atau `ngrok http 3000`), atau deploy ke VPS.
2. Di Roblox Studio: *Game Settings → Security → Allow HTTP Requests* = ON.
3. Di dashboard bagian **4 · Skrip Roblox**, isi URL publik, klik **Ambil skrip**, lalu tempel ke **Script** (bukan LocalScript) di `ServerScriptService`. Atau salin `roblox/BridgeClient.server.lua` dan isi `BASE_URL` + `API_KEY` manual.
4. Opsional: buat Part bernama `SpawnArea` di Workspace untuk menentukan area muncul.
5. Play. Roblox akan polling `/api/roblox/claim` tiap ±1,5 detik.

Catatan: kalau tes di Studio gagal mengambil avatar, coba di game yang sudah dipublish.

## Aturan komentar & gift

Diatur dari dashboard (bagian 3), disimpan di `data/mappings.json`:

```json
{
  "comment": { "mode": "both", "command": "!spawn", "perRobloxUserCooldownSeconds": 30, "perTikTokUserCooldownSeconds": 10 },
  "gifts": { "Rose": { "effect": "rose_rain" }, "Galaxy": { "effect": "fireworks", "params": { "intensity": 5 } } },
  "giftTiers": [{ "minDiamonds": 50, "effect": "confetti" }],
  "likeMilestone": { "enabled": true, "every": 200, "effect": "hearts" }
}
```

- `mode`: `mention` (`@nama`), `command` (`!spawn nama`), atau `both`.
- Gift beruntun (streak) diproses sekali saat streak selesai; jumlahnya jadi `intensity` efek (1–10).
- Gift yang tidak ada di daftar memakai `giftTiers` berdasarkan total diamond.
- Efek bawaan: `rose_rain`, `hearts`, `sparkle`, `confetti`, `fireworks`, `mega`, `welcome`. Efek baru: tambah `function EFFECTS.nama_efek(a) ... end` di skrip Luau, lalu pakai namanya di mapping.
- Untuk UI sendiri, dengarkan `ReplicatedStorage.TikTokEvent` (RemoteEvent) di client.

## API

| Endpoint | Auth | Fungsi |
|---|---|---|
| `GET /api/health` | – | Cek server |
| `GET /api/status` | admin | Snapshot lengkap |
| `GET /api/stream?key=` | admin | Stream realtime (SSE) |
| `POST /api/tiktok/connect` | admin | `{username, signApiKey?, sessionId?, waitForLive?}` |
| `POST /api/tiktok/disconnect` | admin | Putus |
| `GET/PUT /api/mappings` | admin | Baca/simpan aturan |
| `GET/DELETE /api/actions` | admin | Lihat/kosongkan antrean |
| `POST /api/simulate` | admin | Event palsu untuk tes |
| `POST /api/roblox/claim` | roblox | `{workerId, max}`, ambil job (lease 30 dtk) |
| `POST /api/roblox/ack` | roblox | `{workerId, results:[{id,status:"done"/"failed",error?}]}` |
| `GET /api/roblox/script?base=` | admin | Skrip Luau siap tempel |

Header: `x-admin-api-key` / `x-roblox-api-key`.

## Konfigurasi (.env)

Salin `.env.example` ke `.env`. Penting: `TIKTOK_USERNAME` (auto-connect saat start), `TIKTOK_SIGN_API_KEY` (opsional), `ADMIN_API_KEY` / `ROBLOX_API_KEY` (kosong = dibuat otomatis).

## Catatan penting

- `tiktok-live-connector` memakai API TikTok **tidak resmi**. Bisa kena rate-limit atau berubah sewaktu-waktu; jika bermasalah, jalankan `npm update tiktok-live-connector` atau isi `TIKTOK_SIGN_API_KEY`.
- Antrean ada di memori: restart server mengosongkan antrean (mapping & key tetap tersimpan).
- Jika server dipasang publik, jangan bagikan admin key dan pakai HTTPS (tunnel / reverse proxy).
- Beberapa server Roblox boleh polling bersamaan; tiap job hanya diambil satu server.

## Tes

```bash
npm test
```
