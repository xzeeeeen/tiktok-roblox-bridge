// Aturan username Roblox: 3-20 karakter, huruf/angka/underscore,
// tidak boleh diawali/diakhiri underscore, maksimal satu underscore.
export function isValidRobloxUsername(name) {
  if (typeof name !== 'string') return false;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return false;
  if (name.startsWith('_') || name.endsWith('_')) return false;
  if ((name.match(/_/g) || []).length > 1) return false;
  return true;
}

/**
 * Baca komentar penonton dan cari username Roblox.
 * mode: 'mention' (@nama), 'command' (!spawn nama), 'both'
 * Return { username } atau null.
 */
export function parseSpawnComment(text, opts = {}) {
  const { mode = 'both', command = '!spawn', allowBareUsername = false } = opts;
  if (typeof text !== 'string') return null;
  const t = text.trim().slice(0, 200);
  if (!t) return null;

  if (mode === 'command' || mode === 'both') {
    const cmd = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = t.match(new RegExp(`^${cmd}\\s+@?([A-Za-z0-9_]+)`, 'i'));
    if (m && isValidRobloxUsername(m[1])) return { username: m[1] };
  }
  if (mode === 'mention' || mode === 'both') {
    for (const m of t.matchAll(/(?:^|\s)@([A-Za-z0-9_.]{3,30})/g)) {
      const candidate = m[1].replace(/\.+$/, '');
      if (isValidRobloxUsername(candidate)) return { username: candidate };
    }
  }
  if (allowBareUsername && isValidRobloxUsername(t)) return { username: t };
  return null;
}
