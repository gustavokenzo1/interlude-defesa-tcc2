import { createHash } from 'node:crypto';
import type { CachePort } from '../../domain/cache.js';
import type { CostSku } from '../../domain/cost.js';
import { recordCost } from '../cost/cost-context.js';

// Cada chamada cacheada cobra `calls` unidades da SKU em miss; em hit o custo
// real é zero (mas o custo cheio continua sendo contabilizado pelo meter).
interface CostInfo {
  sku: CostSku;
  calls?: number;
  recordMiss?: boolean;
}

// Isola instâncias de cache (e testes); funciona também quando Redis está ausente.
const pendingByCache = new WeakMap<CachePort, Map<string, Promise<unknown>>>();
const pendingWithoutCache = new Map<string, Promise<unknown>>();

export async function withCache<T>(
  cache: CachePort | undefined,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  cost?: CostInfo,
): Promise<T> {
  let pending = cache ? pendingByCache.get(cache) : pendingWithoutCache;
  if (!pending) {
    pending = new Map();
    pendingByCache.set(cache!, pending);
  }
  const existing = pending.get(key);
  if (existing) {
    const value = await existing as T;
    if (cost) recordCost({ ...cost, cached: true });
    return value;
  }
  const operation = (async () => {
    if (cache && ttlSeconds > 0) {
      const cached = await cache.get<T>(key).catch(() => null);
      if (cached !== null) {
        if (cost) recordCost({ ...cost, cached: true });
        return cached;
      }
    }
    if (cost && cost.recordMiss !== false) recordCost({ sku: cost.sku, calls: cost.calls, cached: false });
    const value = await loader();
    if (cache && ttlSeconds > 0) await cache.set(key, value, ttlSeconds).catch(() => undefined);
    return value;
  })();
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    pending.delete(key);
  }
}

/** Hash determinístico curto para compor chaves estáveis. */
export function hashKey(parts: Array<string | number | boolean | null | undefined>): string {
  const normalized = parts.map((part) => (part == null ? '' : String(part))).join('|');
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

/** Arredonda lat/lng para reduzir variação por GPS, mantendo precisão útil (~110m). */
export function quantizeCoordinate(value: number, decimals = 3): string {
  return value.toFixed(decimals);
}
