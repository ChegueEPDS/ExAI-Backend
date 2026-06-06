const stores = new Map();

function ttlMsFromEnv(name, fallbackMs) {
  const n = Number(process.env[name] ?? fallbackMs);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 5 * 60 * 1000);
}

async function getOrSet(namespace, key, ttlMs, loader) {
  if (!ttlMs) return loader();
  const now = Date.now();
  const store = stores.get(namespace) || new Map();
  stores.set(namespace, store);
  const existing = store.get(key);
  if (existing && existing.expiresAt > now) return existing.value;
  const loading = Promise.resolve().then(loader);
  store.set(key, { value: loading, expiresAt: now + ttlMs });
  let value;
  try {
    value = await loading;
  } catch (err) {
    store.delete(key);
    throw err;
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (store.size > 500) {
    for (const [k, v] of store.entries()) {
      if (!v || v.expiresAt <= now) store.delete(k);
    }
  }
  return value;
}

module.exports = { getOrSet, ttlMsFromEnv };
