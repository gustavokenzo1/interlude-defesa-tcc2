import { useEffect, useMemo, useState } from 'react';
import { placesService } from '@/application/places-service';

export interface PlacePhotoRequest {
  placeId: string;
  photoName?: string;
  photoNames?: string[];
  existingUrl?: string;
}
const sessionCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const queue = new Map<string, { request: PlacePhotoRequest; resolve: (url: string | null) => void }>();
let scheduled = false;
let activeBatches = 0;
const CACHE_LIMIT = 60;

export function cachedPlacePhoto(placeId: string): string | undefined {
  return sessionCache.get(placeId) ?? undefined;
}
function scheduleBatch() {
  if (scheduled || activeBatches >= 2 || !queue.size) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; void flushBatch(); }, 25);
}
async function flushBatch() {
  if (activeBatches >= 2) return;
  const entries = Array.from(queue.entries()).slice(0, 10);
  if (!entries.length) return;
  entries.forEach(([id]) => queue.delete(id));
  activeBatches++;
  scheduleBatch();
  let photos: Record<string, string | null> = {};
  try {
    const items: { placeId: string; photoNames: string[] }[] = [];
    // Recuperação de referências antigas é sequencial por lote; no máximo dois lotes.
    for (const [placeId, { request }] of entries) {
      let names = request.photoNames?.length ? request.photoNames : request.photoName ? [request.photoName] : [];
      if (!names.length) names = (await placesService.details(placeId, 'photos').catch(() => null))?.photoNames ?? [];
      if (names.length) items.push({ placeId, photoNames: names.slice(0, 3) });
    }
    photos = await placesService.fetchPhotos(items);
  } catch { /* Falha de mídia não bloqueia o roteiro. */ }
  finally {
    for (const [id, { resolve }] of entries) {
      const url = photos[id] ?? null;
      // Falhas não ficam memorizadas pela sessão toda; nova montagem pode tentar.
      if (url) {
        sessionCache.delete(id);
        sessionCache.set(id, url);
        while (sessionCache.size > CACHE_LIMIT) sessionCache.delete(sessionCache.keys().next().value!);
      }
      resolve(url);
      inflight.delete(id);
    }
    activeBatches--;
    scheduleBatch();
  }
}
function fetchWithCache(request: PlacePhotoRequest): Promise<string | null> {
  const { placeId } = request;
  if (placeId.startsWith('demo-')) return Promise.resolve(null);
  const cached = sessionCache.get(placeId);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(placeId);
  if (pending) return pending;
  const promise = new Promise<string | null>((resolve) => queue.set(placeId, { request, resolve }));
  inflight.set(placeId, promise);
  scheduleBatch();
  return promise;
}
export function usePlacePhotos(requests: PlacePhotoRequest[]): Record<string, string> {
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const missing = useMemo(() => requests.filter((r) => !r.existingUrl && r.placeId && !r.placeId.startsWith('demo-')), [requests]);
  const missingKey = JSON.stringify(missing.map((r) => [r.placeId, r.photoNames ?? r.photoName]));
  useEffect(() => {
    let cancelled = false;
    // Atualização única por lote visível, em vez de um render por foto.
    void Promise.all(missing.map(async (request) => [request.placeId, await fetchWithCache(request)] as const)).then((entries) => {
      if (!cancelled) setPhotos(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))));
    });
    return () => { cancelled = true; };
    // O conteúdo da requisição já faz parte de missingKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);
  return photos;
}
