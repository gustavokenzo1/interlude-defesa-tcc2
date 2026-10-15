import { loadPersistedTrips, persistTrips } from '@/infrastructure/trip-persistence';
import { storageGet, storageSet, storageRemove } from '@/infrastructure/storage';
import * as Crypto from 'expo-crypto';
import { tripCloudSync } from './trip-cloud-sync';
import { costStore } from './cost-store';
import {
  LEG_COLORS,
  type BudgetPreferences,
  type EnrichedPlace,
  type FlightPlan,
  type ItineraryPreferences,
  type ItinerarySolution,
  type LiveProgress,
  type LodgingStay,
  type MealCandidate,
  type PlaceDetails,
  type TransitionLeg,
  type TripDraft,
  type TripLeg,
} from '@/domain/types';

const DRAFT_KEY = 'interlude:draft';
const DRAFT_SCHEMA_KEY = 'interlude:draft:schema';
const CURRENT_DRAFT_SCHEMA = 'multi-leg-v2';

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function colorForIndex(index: number): string {
  return LEG_COLORS[index % LEG_COLORS.length]!;
}

function reindexColors(legs: TripLeg[]): TripLeg[] {
  return legs.map((leg, index) => ({ ...leg, color: colorForIndex(index) }));
}

function emptyDraft(): TripDraft {
  return {
    id: `draft-${Date.now()}`,
    legs: [],
    preferenceOrder: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

type Listener<T> = (value: T) => void;

class Observable<T> {
  private value: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    this.listeners.forEach((listener) => listener(next));
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const draftObservable = new Observable<TripDraft>(emptyDraft());
const tripsObservable = new Observable<TripDraft[]>([]);

let hydrated = false;

function isValidDraft(value: unknown): value is TripDraft {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'legs' in (value as Record<string, unknown>) &&
      Array.isArray((value as TripDraft).legs),
  );
}

export function filterValidTrips(trips: TripDraft[]): TripDraft[] {
  return trips.filter(isValidDraft);
}

export const tripStore = {
  async hydrate(): Promise<void> {
    if (hydrated) return;
    const [storedDraft, storedTrips, storedSchema] = await Promise.all([
      storageGet<TripDraft>(DRAFT_KEY),
      loadPersistedTrips(),
      storageGet<string>(DRAFT_SCHEMA_KEY),
    ]);
    if (storedSchema !== CURRENT_DRAFT_SCHEMA) {
      await storageRemove(DRAFT_KEY);
      await storageSet(DRAFT_SCHEMA_KEY, CURRENT_DRAFT_SCHEMA);
    } else if (storedDraft && isValidDraft(storedDraft)) {
      draftObservable.set(storedDraft);
    } else if (storedDraft) {
      await storageRemove(DRAFT_KEY);
    }
    if (storedTrips) {
      const valid = storedTrips.filter(isValidDraft);
      tripsObservable.set(valid);
    }
    hydrated = true;
  },

  draft(): TripDraft {
    return draftObservable.get();
  },

  trips(): TripDraft[] {
    return tripsObservable.get();
  },

  async replaceTrips(trips: TripDraft[]): Promise<void> {
    const valid = filterValidTrips(trips);
    const previous = tripsObservable.get();
    if (previous.length === valid.length && valid.every((trip, index) => trip === previous[index])) return;
    tripsObservable.set(valid);
    await persistTrips(valid);
  },

  subscribeDraft(listener: Listener<TripDraft>): () => void {
    return draftObservable.subscribe(listener);
  },

  subscribeTrips(listener: Listener<TripDraft[]>): () => void {
    return tripsObservable.subscribe(listener);
  },

  async resetDraft(): Promise<void> {
    const next = emptyDraft();
    draftObservable.set(next);
    await storageRemove(DRAFT_KEY);
    // Zera a instrumentação de custo (dev) ao iniciar um novo rascunho.
    if (__DEV__) costStore.reset();
  },

  async patchDraft(patch: Partial<TripDraft>): Promise<TripDraft> {
    const current = draftObservable.get();
    const next: TripDraft = { ...current, ...patch, updatedAt: nowIso() };
    draftObservable.set(next);
    await storageSet(DRAFT_KEY, next);
    return next;
  },

  async setLegs(legs: TripLeg[]): Promise<TripDraft> {
    return this.patchDraft({ legs: reindexColors(legs) });
  },

  async addLeg(destination: PlaceDetails, recommendedDays?: number): Promise<TripDraft> {
    const current = draftObservable.get();
    const newLeg: TripLeg = {
      id: randomId('leg'),
      destination,
      lodgings: [],
      candidates: [],
      selectedCandidateIds: [],
      color: colorForIndex(current.legs.length),
      recommendedDays,
    };
    return this.patchDraft({ legs: reindexColors([...current.legs, newLeg]) });
  },

  async removeLeg(legId: string): Promise<TripDraft> {
    const current = draftObservable.get();
    const legs = current.legs.filter((leg) => leg.id !== legId);
    return this.patchDraft({ legs: reindexColors(legs) });
  },

  async reorderLegs(orderedIds: string[]): Promise<TripDraft> {
    const current = draftObservable.get();
    const byId = new Map(current.legs.map((leg) => [leg.id, leg] as const));
    const ordered = orderedIds
      .map((id) => byId.get(id))
      .filter((leg): leg is TripLeg => Boolean(leg));
    return this.patchDraft({ legs: reindexColors(ordered) });
  },

  async updateLeg(legId: string, patch: Partial<TripLeg>): Promise<TripDraft> {
    const current = draftObservable.get();
    const legs = current.legs.map((leg) => (leg.id === legId ? { ...leg, ...patch } : leg));
    return this.patchDraft({ legs: reindexColors(legs) });
  },

  async setLegDates(legId: string, startDate: string, endDate: string): Promise<TripDraft> {
    return this.updateLeg(legId, { startDate, endDate });
  },

  async clearLegDates(legId: string): Promise<TripDraft> {
    return this.updateLeg(legId, { startDate: undefined, endDate: undefined });
  },

  async setLegLodgings(legId: string, lodgings: LodgingStay[]): Promise<TripDraft> {
    return this.updateLeg(legId, { lodgings });
  },

  async setLegDiscoveryRadius(legId: string, discoveryRadiusMeters: number): Promise<TripDraft> {
    return this.updateLeg(legId, { discoveryRadiusMeters });
  },

  async setLegCandidates(
    legId: string,
    candidates: EnrichedPlace[],
    selectedCandidateIds: string[],
  ): Promise<TripDraft> {
    return this.updateLeg(legId, { candidates, selectedCandidateIds });
  },

  // Adiciona um POI custom ao leg (vindo de uma busca manual). Se o placeId já
  // existir no leg, apenas garante que ele está marcado como selecionado.
  async addLegCandidate(legId: string, candidate: EnrichedPlace): Promise<TripDraft> {
    const current = draftObservable.get();
    const leg = current.legs.find((l) => l.id === legId);
    if (!leg) return current;
    const placeId = candidate.place.placeId;
    const alreadyHas = leg.candidates.some((c) => c.place.placeId === placeId);
    const nextCandidates = alreadyHas
      ? leg.candidates.map((c) => (c.place.placeId === placeId ? candidate : c))
      : [candidate, ...leg.candidates];
    const nextSelected = leg.selectedCandidateIds.includes(placeId)
      ? leg.selectedCandidateIds
      : [placeId, ...leg.selectedCandidateIds];
    return this.updateLeg(legId, {
      candidates: nextCandidates,
      selectedCandidateIds: nextSelected,
    });
  },

  setFlightPlan(flightPlan: FlightPlan | undefined) {
    return this.patchDraft({ flightPlan });
  },

  async setTransition(transition: TransitionLeg): Promise<TripDraft> {
    const current = draftObservable.get();
    const others = (current.transitions ?? []).filter(
      (t) => !(t.fromLegId === transition.fromLegId && t.toLegId === transition.toLegId),
    );
    return this.patchDraft({ transitions: [...others, transition] });
  },

  async removeTransition(fromLegId: string, toLegId: string): Promise<TripDraft> {
    const current = draftObservable.get();
    const transitions = (current.transitions ?? []).filter(
      (t) => !(t.fromLegId === fromLegId && t.toLegId === toLegId),
    );
    return this.patchDraft({ transitions });
  },

  setPreferenceOrder(preferenceOrder: string[]) {
    return this.patchDraft({ preferenceOrder });
  },

  setInterestLevels(interestLevels: Record<string, number>, preferenceOrder: string[]) {
    return this.patchDraft({ interestLevels, preferenceOrder });
  },

  setPreferences(preferences: ItineraryPreferences) {
    return this.patchDraft({ preferences });
  },

  setBudget(budget: BudgetPreferences | undefined) {
    return this.patchDraft({ budget });
  },

  setItinerary(itinerary: ItinerarySolution) {
    return this.patchDraft({ itinerary, itineraryEdited: false });
  },

  // Aplica uma transformação ao roteiro do rascunho e persiste. Usado pela
  // edição pós-geração (reordenar, ajustar duração, mover entre dias). Funções
  // de mutação vivem em features/itinerary/edit.ts.
  async editDraftItinerary(
    edit: (itinerary: ItinerarySolution) => ItinerarySolution,
  ): Promise<TripDraft> {
    const current = draftObservable.get();
    if (!current.itinerary) return current;
    return this.patchDraft({ itinerary: edit(current.itinerary), itineraryEdited: true });
  },

  // Mesmo que editDraftItinerary, mas sobre uma viagem já salva (identificada
  // por tripId). Persiste em AsyncStorage e sincroniza com o Firestore — segue
  // o caminho de saveTrip/deleteTrip.
  async editTripItinerary(
    tripId: string,
    edit: (itinerary: ItinerarySolution) => ItinerarySolution,
  ): Promise<void> {
    const trips = tripsObservable.get();
    const target = trips.find((trip) => trip.id === tripId);
    if (!target || !tripCloudSync.canEditTrip(target)) return;
    let updated: TripDraft | undefined;
    const next = trips.map((trip) => {
      if (trip.id !== tripId || !trip.itinerary) return trip;
      updated = { ...trip, itinerary: edit(trip.itinerary), itineraryEdited: true, updatedAt: nowIso() };
      return updated;
    });
    if (!updated) return;
    tripsObservable.set(next);
    await persistTrips(next);
    try {
      await tripCloudSync.patchTrip(updated.id, { itinerary: updated.itinerary });
    } catch (error) {
      console.warn('[trip-store] Failed to sync edited itinerary to Firestore', error);
    }
  },

  async saveReplannedTrip(original: TripDraft, planned: TripDraft, saved: boolean): Promise<void> {
    const current = saved ? tripsObservable.get().find(trip => trip.id === original.id) : draftObservable.get();
    if (!current || current.id !== original.id || current.updatedAt !== original.updatedAt) {
      throw new Error('A viagem mudou durante a edição. Reabra a edição para usar a versão atual.');
    }
    if (!tripCloudSync.canEditTrip(current)) throw new Error('Você não tem permissão para editar esta viagem.');
    const patch: Partial<TripDraft> = {
      legs: planned.legs, datesFlexible: planned.datesFlexible, flightPlan: planned.flightPlan,
      transitions: planned.transitions, mealCandidates: planned.mealCandidates,
      sourceBlueprint: planned.sourceBlueprint, itinerary: planned.itinerary, itineraryEdited: false,
      attractionDayAssignments: planned.attractionDayAssignments, attractionPriority: planned.attractionPriority,
    };
    if (!saved) { await this.patchDraft(patch); return; }
    await tripCloudSync.patchTrip(current.id, patch);
    const updated = { ...current, ...patch, updatedAt: nowIso() };
    const next = tripsObservable.get().map(trip => trip.id === current.id ? updated : trip);
    tripsObservable.set(next);
    await persistTrips(next);
  },

  setMealCandidates(mealCandidates: MealCandidate[]) {
    return this.patchDraft({ mealCandidates });
  },

  async addMealCandidate(candidate: MealCandidate): Promise<TripDraft> {
    const current = draftObservable.get();
    const existing = current.mealCandidates ?? [];
    if (existing.some((c) => c.id === candidate.id)) {
      return current;
    }
    return this.patchDraft({ mealCandidates: [...existing, candidate] });
  },

  async removeMealCandidate(candidateId: string): Promise<TripDraft> {
    const current = draftObservable.get();
    const existing = current.mealCandidates ?? [];
    const next = existing.filter((c) => c.id !== candidateId);
    return this.patchDraft({ mealCandidates: next });
  },

  async setMealCandidateReservation(
    candidateId: string,
    reservationLocalIso?: string,
  ): Promise<TripDraft> {
    const current = draftObservable.get();
    const existing = current.mealCandidates ?? [];
    const next = existing.map((c) =>
      c.id === candidateId ? { ...c, reservationLocalIso } : c,
    );
    return this.patchDraft({ mealCandidates: next });
  },

  async setMealCandidateDay(candidateId: string, dayOffset?: number): Promise<TripDraft> {
    const current = draftObservable.get();
    const existing = current.mealCandidates ?? [];
    const next = existing.map((c) => (c.id === candidateId ? { ...c, dayOffset } : c));
    return this.patchDraft({ mealCandidates: next });
  },

  async setMealCandidateEnrichment(
    candidateId: string,
    enriched: EnrichedPlace,
  ): Promise<TripDraft> {
    const current = draftObservable.get();
    const existing = current.mealCandidates ?? [];
    const next = existing.map((candidate) =>
      candidate.id === candidateId
        ? {
            ...candidate,
            place: enriched.place,
            insight: enriched.insight,
            photoUrl: enriched.photoUrl ?? candidate.photoUrl,
            coordinate: enriched.place.coordinate,
            openingHours: enriched.place.openingHours,
            rating: enriched.place.rating,
            userRatingCount: enriched.place.userRatingCount,
            primaryType: enriched.place.primaryType,
            serviceTimeSeconds:
              candidate.serviceTimeSeconds ??
              (enriched.insight?.averageMinutes && enriched.insight.averageMinutes > 0
                ? Math.round(enriched.insight.averageMinutes * 60)
                : undefined),
          }
        : candidate,
    );
    return this.patchDraft({ mealCandidates: next });
  },

  setAttractionPriority(attractionPriority: string[]) {
    return this.patchDraft({ attractionPriority });
  },

  setMealPriority(mealPriority: string[]) {
    return this.patchDraft({ mealPriority });
  },

  async saveAsTrip(): Promise<TripDraft | null> {
    const current = draftObservable.get();
    if (!current.itinerary || current.legs.length === 0) return null;
    const coverPhotoUrls = current.coverPhotoUrls ?? [];
    // Fallback para o coverPhotoUrl singular: primeira foto multi, depois foto
    // de POI selecionado.
    const coverPhotoUrl =
      current.coverPhotoUrl ??
      coverPhotoUrls[0] ??
      current.legs.flatMap((leg) => leg.candidates).find((c) => c.photoUrl)?.photoUrl ??
      undefined;
    const trip = tripCloudSync.prepareNewTrip({
      ...current,
      coverPhotoUrl,
      coverPhotoUrls: coverPhotoUrls.length > 0 ? coverPhotoUrls : undefined,
      id: `trip-${Crypto.randomUUID()}`,
      updatedAt: nowIso(),
    });
    await tripCloudSync.saveTrip(trip);
    const all = [trip, ...tripsObservable.get().filter((item) => item.id !== trip.id)];
    tripsObservable.set(all);
    await persistTrips(all);
    return trip;
  },

  // Atualiza o progresso do modo viagem de uma trip salva e persiste. Opera
  // sobre a lista de trips (não o draft), pois o modo viagem roda sobre uma
  // viagem já salva.
  async patchTripProgress(tripId: string, patch: Partial<LiveProgress>): Promise<void> {
    const trips = tripsObservable.get();
    const target = trips.find((trip) => trip.id === tripId);
    if (!target || !tripCloudSync.canEditTrip(target)) return;
    let updated: TripDraft | undefined;
    const next = trips.map((trip) => {
      if (trip.id !== tripId) return trip;
      const current = trip.liveProgress;
      const liveProgress: LiveProgress = {
        completedStopIds: patch.completedStopIds ?? current?.completedStopIds ?? [],
        skippedStopIds: patch.skippedStopIds ?? current?.skippedStopIds ?? [],
        activeDayIndex: patch.activeDayIndex ?? current?.activeDayIndex,
        updatedAt: nowIso(),
      };
      const stopIds = (trip.itinerary?.days ?? []).flatMap((day) =>
        day.steps
          .filter((step) => !step.isDepot && !step.mealPositional)
          .map((step) => step.stopId),
      );
      const resolved = new Set([...liveProgress.completedStopIds, ...liveProgress.skippedStopIds]);
      const isCompleted = stopIds.length > 0 && stopIds.every((stopId) => resolved.has(stopId));
      updated = {
        ...trip,
        completedAt: isCompleted ? trip.completedAt ?? liveProgress.updatedAt : null,
        liveProgress,
        updatedAt: nowIso(),
      };
      return updated;
    });
    tripsObservable.set(next);
    await persistTrips(next);
    if (updated) {
      try {
        await tripCloudSync.patchTrip(updated.id, {
          completedAt: updated.completedAt,
          liveProgress: updated.liveProgress,
        });
      } catch (error) {
        console.warn('[trip-store] Failed to sync live progress to Firestore', error);
      }
    }
  },

  async deleteTrip(tripId: string): Promise<void> {
    const remaining = tripsObservable.get().filter((trip) => trip.id !== tripId);
    tripsObservable.set(remaining);
    await persistTrips(remaining);
    try {
      await tripCloudSync.deleteTrip(tripId);
    } catch (error) {
      console.warn('[trip-store] Failed to delete trip from Firestore', error);
    }
  },
};
