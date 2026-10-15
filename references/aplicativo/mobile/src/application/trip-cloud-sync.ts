import {
  arrayRemove,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  EnrichedPlace,
  PlaceDetails,
  PlaceSummary,
  TripDraft,
  TripLeg,
} from '@/domain/types';
import { getFirebase } from '@/infrastructure/firebase';
import { storageGet, storageSet } from '@/infrastructure/storage';

const TRIPS_OWNER_KEY = 'interlude:trips:ownerUid';

interface TripStoreBridge {
  getTrips(): TripDraft[];
  replaceTrips(trips: TripDraft[]): Promise<void>;
}

interface MemberIdentity {
  displayName: string;
  email?: string;
  photoURL?: string;
}

class TripCloudSync {
  private generation = 0;
  private visibleLimit = 50;
  private cancelAttach: (() => void) | null = null;
  hasMore = false;
  private uid: string | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private bridge: TripStoreBridge | null = null;
  private applyingRemote = false;
  private identity: MemberIdentity | null = null;
  private ownerByTripId = new Map<string, string>();

  async attach(uid: string, bridge: TripStoreBridge, identity: MemberIdentity, pageLimit = 50): Promise<void> {
    const firebase = getFirebase();
    if (!firebase) return;
    this.detach();
    const generation = this.generation;
    this.visibleLimit = pageLimit;
    this.uid = uid;
    this.bridge = bridge;
    this.identity = identity;

    const storedOwner = await storageGet<string>(TRIPS_OWNER_KEY);
    if (generation !== this.generation) return;
    const accountChanged = Boolean(storedOwner && storedOwner !== uid);
    const localTrips = accountChanged ? [] : bridge.getTrips();
    if (accountChanged) {
      await bridge.replaceTrips([]);
    }

    if (generation !== this.generation) return;
    const tripsRef = collection(firebase.firestore, 'trips');
    const memberTripsQuery = query(tripsRef, where('memberIds', 'array-contains', uid), orderBy('updatedAt', 'desc'), limit(pageLimit));
    const migrationKey = `interlude:trips:migrated:${uid}`;
    const migrated = await storageGet<boolean>(migrationKey);
    if (generation !== this.generation) return;
    const remote = new Map<string, TripDraft>();
    const dirty = new Set<string>();
    let initialized = false;
    let writeQueue = Promise.resolve();
    const applyRemote = () => {
      if (generation !== this.generation) return;
      const incoming = [...remote.values()];
      const changed = new Set(dirty);
      dirty.clear();
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        if (generation !== this.generation) return;
        const currentById = new Map(bridge.getTrips().map((trip) => [trip.id, trip]));
        const next = sortTrips(incoming.map((trip) => {
          const local = currentById.get(trip.id);
          return local && !changed.has(trip.id) ? local : mergeLocalMedia([trip], local ? [local] : [])[0]!;
        }));
        this.rememberOwners(next);
        await bridge.replaceTrips(next);
      });
      void writeQueue.catch((error) => console.warn('[trip-sync] Persistência local falhou', error));
    };
    // A primeira emissão do listener substitui o getDocs da mesma coleção.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Não foi possível sincronizar as viagens. Tente novamente.')), 15_000);
        this.cancelAttach = () => { clearTimeout(timer); resolve(); };
        this.unsubscribe = onSnapshot(memberTripsQuery, { includeMetadataChanges: true }, (snapshot) => {
          if (generation !== this.generation) { clearTimeout(timer); resolve(); return; }
          for (const change of snapshot.docChanges()) {
            dirty.add(change.doc.id);
            if (change.type === 'removed') remote.delete(change.doc.id);
            else {
              const trip = change.doc.data() as TripDraft;
              if (isUsableTrip(trip)) remote.set(change.doc.id, trip);
            }
          }
          this.hasMore = snapshot.size >= pageLimit;
          if (!snapshot.metadata.fromCache) { clearTimeout(timer); resolve(); }
          if (initialized && snapshot.docChanges().length) applyRemote();
        }, (error) => { clearTimeout(timer); reject(error); });
      });
      if (generation !== this.generation) return;
      const legacy = migrated ? [] : (await getDocs(collection(firebase.firestore, 'users', uid, 'trips'))).docs;
      if (generation !== this.generation) return;
      const migrationTrips = legacy.map((snapshot) => withOwnerAccess(snapshot.data() as TripDraft, uid, identity)).filter(isUsableTrip);
      // Viagens com ownerId já sincronizadas não são reenviadas por estarem fora
      // da página ou terem sido excluídas em outro aparelho.
      const localOnly = localTrips.filter((trip) => isUsableTrip(trip) && !trip.ownerId && !remote.has(trip.id))
        .map((trip) => withOwnerAccess(trip, uid, identity));
      const imports = [...migrationTrips.filter((trip) => !remote.has(trip.id)), ...localOnly];
      // Lotes pequenos também cobrem migração de contas com histórico extenso.
      const mutations = [
        ...imports.map((trip) => ({ trip, legacy: undefined as typeof legacy[number] | undefined })),
        ...legacy.map((entry) => ({ trip: undefined as TripDraft | undefined, legacy: entry })),
      ];
      for (let index = 0; index < mutations.length; index += 400) {
        const batch = writeBatch(firebase.firestore);
        mutations.slice(index, index + 400).forEach((item) => {
          if (item.trip) batch.set(doc(tripsRef, item.trip.id), serializeTripForFirestore(item.trip), { merge: true });
          if (item.legacy) batch.delete(item.legacy.ref);
        });
        await batch.commit();
      }
      if (generation !== this.generation) return;
      if (!migrated) await storageSet(migrationKey, true);
      await storageSet(TRIPS_OWNER_KEY, uid);
      initialized = true;
      applyRemote();
      await writeQueue;
    } catch (error) {
      if (generation === this.generation) this.detach();
      throw error;
    }
  }

  async loadMore(): Promise<void> {
    if (!this.uid || !this.bridge || !this.identity || !this.hasMore) return;
    await this.attach(this.uid, this.bridge, this.identity, this.visibleLimit + 50);
  }

  detach(): void {
    this.generation++;
    this.cancelAttach?.();
    this.cancelAttach = null;
    this.hasMore = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.uid = null;
    this.bridge = null;
    this.applyingRemote = false;
    this.identity = null;
    this.ownerByTripId.clear();
  }

  async saveTrip(trip: TripDraft): Promise<void> {
    const firebase = getFirebase();
    const firebaseUser = firebase?.auth.currentUser;
    const uid = this.uid ?? firebaseUser?.uid;
    if (!firebase || !uid) {
      throw new Error('Sua sessão ainda não está pronta para salvar a viagem. Tente novamente.');
    }
    const normalized = withOwnerAccess(
      trip,
      trip.ownerId ?? uid,
      this.identity ?? {
        displayName: firebaseUser?.displayName ?? firebaseUser?.email ?? 'Viajante',
        email: firebaseUser?.email ?? undefined,
        photoURL: firebaseUser?.photoURL ?? undefined,
      },
    );
    await setDoc(doc(firebase.firestore, 'trips', trip.id), serializeTripForFirestore(normalized), {
      merge: true,
    });
    this.ownerByTripId.set(trip.id, normalized.ownerId!);
  }

  async patchTrip(tripId: string, patch: Partial<TripDraft>): Promise<void> {
    const firebase = getFirebase();
    if (this.applyingRemote || !firebase?.auth.currentUser) return;
    await updateDoc(
      doc(firebase.firestore, 'trips', tripId),
      sanitizeForFirestore({ ...patch,
        ...(patch.legs ? { legs: patch.legs.map(compactLeg) } : {}),
        ...(patch.mealCandidates ? { mealCandidates: patch.mealCandidates.map(meal => ({ ...meal, photoUrl: compactMediaUrl(meal.photoUrl) })) } : {}),
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  prepareNewTrip(trip: TripDraft): TripDraft {
    const firebaseUser = getFirebase()?.auth.currentUser;
    const uid = this.uid ?? firebaseUser?.uid;
    if (!uid) return trip;
    return withOwnerAccess(trip, uid, this.identity ?? {
      displayName: firebaseUser?.displayName ?? firebaseUser?.email ?? 'Viajante',
      email: firebaseUser?.email ?? undefined,
      photoURL: firebaseUser?.photoURL ?? undefined,
    });
  }

  canEditTrip(trip: TripDraft): boolean {
    const uid = this.uid ?? getFirebase()?.auth.currentUser?.uid;
    if (!uid || !trip.ownerId) return true;
    if (trip.ownerId === uid) return true;
    return trip.members?.[uid]?.role === 'editor';
  }

  async deleteTrip(tripId: string): Promise<void> {
    const firebase = getFirebase();
    const uid = this.uid ?? firebase?.auth.currentUser?.uid;
    if (this.applyingRemote || !firebase || !uid) return;
    // Hard delete: apaga o documento de vez. Como o Firestore é a fonte da
    // verdade no attach/onSnapshot, a viagem não é ressuscitada em nenhum device.
    const tripRef = doc(firebase.firestore, 'trips', tripId);
    if (this.ownerByTripId.get(tripId) === uid) {
      const expenses = (await getDocs(collection(firebase.firestore, 'trips', tripId, 'expenses'))).docs;
      for (let index = 0; index < expenses.length; index += 400) {
        const batch = writeBatch(firebase.firestore);
        expenses.slice(index, index + 400).forEach((expense) => batch.delete(expense.ref));
        await batch.commit();
      }
      await deleteDoc(tripRef);
    } else {
      const participantId = `user:${uid}`;
      await updateDoc(tripRef, {
        memberIds: arrayRemove(uid),
        [`members.${uid}`]: deleteField(),
        [`participants.${participantId}.status`]: 'removed',
        [`participants.${participantId}.uid`]: deleteField(),
      });
    }
    this.ownerByTripId.delete(tripId);
  }

  private rememberOwners(trips: TripDraft[]): void {
    this.ownerByTripId = new Map(
      trips.flatMap((trip) => (trip.ownerId ? [[trip.id, trip.ownerId] as const] : [])),
    );
  }
}

function withOwnerAccess(trip: TripDraft, ownerId: string, identity: MemberIdentity): TripDraft {
  const joinedAt = trip.createdAt || new Date().toISOString();
  const ownerParticipantId = `user:${ownerId}`;
  return {
    ...trip,
    ownerId,
    memberIds: Array.from(new Set([...(trip.memberIds ?? []), ownerId])),
    members: {
      ...(trip.members ?? {}),
      [ownerId]: trip.members?.[ownerId] ?? {
        uid: ownerId,
        role: 'owner',
        displayName: identity.displayName,
        email: identity.email,
        photoURL: identity.photoURL,
        joinedAt,
      },
    },
    participants: {
      ...(trip.participants ?? {}),
      [ownerParticipantId]: trip.participants?.[ownerParticipantId] ?? {
        id: ownerParticipantId,
        uid: ownerId,
        displayName: identity.displayName,
        email: identity.email,
        status: 'active',
        joinedAt,
      },
    },
  };
}

export const tripCloudSync = new TripCloudSync();

function isUsableTrip(trip: TripDraft): boolean {
  return Boolean(trip && Array.isArray(trip.legs));
}

// Deduplica e ordena os documentos da janela carregada; o limite é da consulta.
function sortTrips(trips: TripDraft[]): TripDraft[] {
  const byId = new Map<string, TripDraft>();
  for (const trip of trips) {
    const current = byId.get(trip.id);
    if (!current || Date.parse(trip.updatedAt) >= Date.parse(current.updatedAt)) {
      byId.set(trip.id, trip);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function serializeTripForFirestore(trip: TripDraft): TripDraft {
  return sanitizeForFirestore(compactTripForFirestore(trip));
}

function compactTripForFirestore(trip: TripDraft): TripDraft {
  return {
    ...trip,
    coverPhotoUrl: compactMediaUrl(trip.coverPhotoUrl),
    coverPhotoUrls: trip.coverPhotoUrls?.map(compactMediaUrl).filter((url): url is string => Boolean(url)),
    legs: trip.legs.map(compactLeg),
    mealCandidates: trip.mealCandidates?.map((candidate) => ({
      ...candidate,
      photoUrl: compactMediaUrl(candidate.photoUrl),
    })),
    itinerary: trip.itinerary
      ? {
          ...trip.itinerary,
          pois: trip.itinerary.pois.map(compactPlaceSummary),
        }
      : undefined,
  };
}

function compactLeg(leg: TripLeg): TripLeg {
  return {
    ...leg,
    destination: compactPlaceDetails(leg.destination),
    candidates: leg.candidates.map(compactEnrichedPlace),
  };
}

function compactEnrichedPlace(place: EnrichedPlace): EnrichedPlace {
  return {
    place: compactPlaceSummary(place.place),
    insight: place.insight,
    // Mídia editorial licenciada é uma URL curta e estável, então pode viajar
    // com o roteiro. Base64 do Places continua fora do Firestore.
    photoUrl: compactMediaUrl(place.photoUrl),
    photoAttribution: place.photoAttribution,
  };
}

function compactMediaUrl(url?: string): string | undefined {
  return url && !url.startsWith('data:') ? url : undefined;
}

function compactPlaceDetails(place: PlaceDetails): PlaceDetails {
  return { ...place, photoNames: place.photoNames?.slice(0, 3) };
}

// O data URL (base64, ~200KB) fica fora do Firestore; a REFERÊNCIA da primeira
// foto (string curta) fica — é o que permite a outro device rebuscar a imagem.
function compactPlaceSummary(place: PlaceSummary): PlaceSummary {
  return { ...place, photoNames: place.photoNames?.slice(0, 3) };
}

// Fotos vivem só no device (data URLs). Ao aplicar o remoto (compacto), copia
// de volta a mídia que o local já tinha; sem isso, todo snapshot apagava as
// fotos do roteiro e dos cards de viagens salvas.
function mergeLocalMedia(incoming: TripDraft[], local: TripDraft[]): TripDraft[] {
  const localById = new Map(local.map((trip) => [trip.id, trip]));
  return incoming.map((trip) => {
    const localTrip = localById.get(trip.id);
    if (!localTrip) return trip;
    const localLegById = new Map(localTrip.legs.map((leg) => [leg.id, leg]));
    return {
      ...trip,
      coverPhotoUrl: trip.coverPhotoUrl ?? localTrip.coverPhotoUrl,
      coverPhotoUrls: trip.coverPhotoUrls?.length ? trip.coverPhotoUrls : localTrip.coverPhotoUrls,
      mealCandidates: trip.mealCandidates?.map((candidate) => {
        const localCandidate = localTrip.mealCandidates?.find((item) => item.id === candidate.id);
        return {
          ...candidate,
          photoUrl: candidate.photoUrl ?? localCandidate?.photoUrl,
        };
      }),
      legs: trip.legs.map((leg) => {
        const localLeg = localLegById.get(leg.id);
        if (!localLeg) return leg;
        const localCandidateById = new Map(
          localLeg.candidates.map((candidate) => [candidate.place.placeId, candidate]),
        );
        return {
          ...leg,
          destination: {
            ...leg.destination,
            photoNames: leg.destination.photoNames ?? localLeg.destination.photoNames,
          },
          candidates: leg.candidates.map((candidate) => {
            const localCandidate = localCandidateById.get(candidate.place.placeId);
            if (!localCandidate) return candidate;
            return {
              ...candidate,
              photoUrl: candidate.photoUrl ?? localCandidate.photoUrl,
              photoAttribution: candidate.photoAttribution ?? localCandidate.photoAttribution,
              place: {
                ...candidate.place,
                photoNames: candidate.place.photoNames ?? localCandidate.place.photoNames,
              },
            };
          }),
        };
      }),
    };
  });
}

function sanitizeForFirestore<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sanitizeForFirestore) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, sanitizeForFirestore(entryValue)]),
    ) as T;
  }
  return value;
}
