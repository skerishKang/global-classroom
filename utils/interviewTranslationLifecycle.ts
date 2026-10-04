export type TranslationSessionLike = {
  sendRealtimeInput?: (payload: unknown) => void;
  close?: () => void;
};

export type TranslationSlot<Target extends string> = {
  target: Target;
  generation: number;
  session: TranslationSessionLike;
};

export type TranslationRotation<Target extends string> = {
  completedGeneration: number;
  activeGeneration: number;
  retiring: Array<TranslationSlot<Target>>;
  missingTargets: Target[];
};

export class InterviewTranslationLifecycle<Target extends string> {
  private generation = 1;
  private active = new Map<Target, TranslationSlot<Target>>();
  private standby = new Map<Target, TranslationSlot<Target>>();

  constructor(private readonly targets: readonly Target[]) {}

  currentGeneration() {
    return this.generation;
  }

  hasActive(target: Target, generation = this.generation) {
    return this.active.get(target)?.generation === generation;
  }

  hasStandby(target: Target, generation = this.generation + 1) {
    return this.standby.get(target)?.generation === generation;
  }

  isActive(target: Target, generation: number) {
    return this.active.get(target)?.generation === generation;
  }

  installActive(target: Target, generation: number, session: TranslationSessionLike) {
    if (generation !== this.generation) return false;
    const previous = this.active.get(target);
    if (previous && previous.session !== session) {
      try {
        previous.session.close?.();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.active.set(target, { target, generation, session });
    return true;
  }

  installStandby(target: Target, generation: number, session: TranslationSessionLike) {
    if (generation !== this.generation + 1) return false;
    const previous = this.standby.get(target);
    if (previous && previous.session !== session) {
      try {
        previous.session.close?.();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.standby.set(target, { target, generation, session });
    return true;
  }

  sendMedia(media: unknown) {
    for (const slot of this.active.values()) {
      try {
        slot.session.sendRealtimeInput?.({ media });
      } catch {
        // Translation preview is best effort.
      }
    }
  }

  rotate(): TranslationRotation<Target> {
    const completedGeneration = this.generation;
    const retiring = Array.from(this.active.values());
    this.generation += 1;

    const nextActive = new Map<Target, TranslationSlot<Target>>();
    for (const target of this.targets) {
      const slot = this.standby.get(target);
      if (slot?.generation === this.generation) {
        nextActive.set(target, slot);
      }
    }

    this.active = nextActive;
    this.standby = new Map();

    const missingTargets = this.targets.filter((target) => !this.hasActive(target));
    return {
      completedGeneration,
      activeGeneration: this.generation,
      retiring,
      missingTargets,
    };
  }

  activeSessions() {
    return Array.from(this.active.values());
  }

  closeAll() {
    const sessions = [
      ...Array.from(this.active.values()),
      ...Array.from(this.standby.values()),
    ];

    const seen = new Set<TranslationSessionLike>();
    for (const slot of sessions) {
      if (seen.has(slot.session)) continue;
      seen.add(slot.session);
      try {
        slot.session.close?.();
      } catch {
        // Best-effort cleanup.
      }
    }

    this.active.clear();
    this.standby.clear();
    this.generation = 1;
  }
}
