import type { Project, ShellSnapshot, ThreadShell } from "./model.js";
import { canonicalThreadId } from "./model.js";
import { normalizeShell } from "./v2.js";
import type { RawShellSnapshot, RawThreadShell } from "./v2.js";

/** Loose mirror of T3's orchestration.subscribeShell stream items. */
export interface ShellStreamItem {
  kind: string;
  sequence?: number;
  snapshot?: RawShellSnapshot;
  project?: Project;
  projectId?: string;
  location?: "active" | "archive";
  thread?: RawThreadShell;
  threadId?: string;
}

export interface ShellIndexDeps {
  loadActive(signal?: AbortSignal): Promise<RawShellSnapshot>;
  loadArchived(): Promise<RawShellSnapshot>;
  subscribe(
    afterSequence: number,
    onItems: (items: ShellStreamItem[]) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ThreadIndexOptions {
  /**
   * Reload the shell snapshot when it is older than this, even while the
   * subscribeShell stream reports live. The stream can stall without closing
   * (half-open socket, server-side fiber stuck), and a "live" flag alone would
   * then freeze list/search reads forever. Default 45 s.
   */
  maxAgeMs?: number;
  /**
   * Restart the subscribeShell stream when no stream item has arrived for this
   * long. Default 5 min. 0 disables the watchdog.
   */
  watchdogMs?: number;
}

const DEFAULT_MAX_AGE_MS = 45_000;
const DEFAULT_WATCHDOG_MS = 5 * 60_000;

/**
 * In-memory index of T3 thread shells.
 *
 * The first read pays for one shell snapshot; a subscription to
 * orchestration.subscribeShell then applies thread/project deltas in place.
 * Tools never rebuild the full 600-thread list per call, and a single-thread
 * read does not touch this index at all.
 *
 * Freshness guards (0.4.1): reads reload the snapshot once it is older than
 * maxAgeMs regardless of the stream state, and a watchdog restarts a stream
 * that has been silent for watchdogMs.
 */
export class ThreadIndex {
  private projects = new Map<string, Project>();
  private active = new Map<string, ThreadShell>();
  private archived = new Map<string, ThreadShell>();
  private sequence = 0;
  private loadedAt = 0;
  private updatedAt = 0;
  private archivedLoaded = false;
  private refreshPromise?: Promise<void>;
  private subscription?: Promise<void>;
  private subscriptionAbort?: AbortController;
  private subscribing = false;
  private live = false;
  private dirty = false;
  private generation = 0;
  private subscribedAt = 0;
  private lastStreamItemAt = 0;
  private streamRestarts = 0;
  private watchdog?: ReturnType<typeof setInterval>;
  private readonly maxAgeMs: number;
  private readonly watchdogMs: number;

  constructor(
    private readonly deps: ShellIndexDeps,
    private readonly staleAfterMs = 1_500,
    options: ThreadIndexOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  }

  async snapshot(
    includeArchived = false,
    signal?: AbortSignal,
  ): Promise<ShellSnapshot> {
    await this.ensure(includeArchived, signal);
    const threads = [
      ...this.active.values(),
      ...(includeArchived ? this.archived.values() : []),
    ];
    return {
      snapshotSequence: this.sequence,
      projects: [...this.projects.values()],
      threads,
      updatedAt: new Date(this.updatedAt || Date.now()).toISOString(),
    };
  }

  async get(id: string, signal?: AbortSignal): Promise<ThreadShell | undefined> {
    await this.ensure(false, signal);
    const active = this.active.get(id);
    if (active) return active;
    if (!this.archivedLoaded) await this.ensure(true, signal);
    return this.archived.get(id);
  }

  /** Provider-scoped ids resolve to the canonical app thread, including archived. */
  async resolveId(id: string, signal?: AbortSignal): Promise<string> {
    await this.ensure(false, signal);
    const active = canonicalThreadId([...this.active.values()], id);
    if (active !== id || this.active.has(id)) return active;
    if (!this.archivedLoaded) await this.ensure(true, signal);
    return canonicalThreadId(
      [...this.active.values(), ...this.archived.values()],
      id,
    );
  }

  /** Force the next read to reconcile after a local mutation. */
  invalidate() {
    this.dirty = true;
    this.archivedLoaded = false;
  }

  /**
   * Reload the active snapshot now and wait until `threadId` is present.
   * T3 can acknowledge a launch slightly before the shell projection lists the
   * new thread; a single refresh would then cache a list without it. Retries a
   * few times and returns whether the thread was seen. Never throws.
   */
  async refreshUntil(
    threadId: string,
    attempts = 4,
    delayMs = 250,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        this.invalidate();
        await this.ensure(false);
        if (this.active.has(threadId) || this.archived.has(threadId))
          return true;
      } catch {
        // Best effort: the next read still reconciles because dirty stays set.
      }
      if (attempt < attempts - 1)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    this.invalidate();
    return false;
  }

  stats() {
    const now = Date.now();
    return {
      activeThreads: this.active.size,
      archivedThreads: this.archived.size,
      liveUpdates: this.live,
      snapshotSequence: this.sequence,
      indexAgeMs: this.loadedAt ? now - this.loadedAt : null,
      lastStreamItemAgeMs: this.lastStreamItemAt
        ? now - this.lastStreamItemAt
        : null,
      streamRestarts: this.streamRestarts,
    };
  }

  /** Stop the stream and watchdog (tests / shutdown). */
  close() {
    this.generation++;
    this.subscriptionAbort?.abort();
    this.subscriptionAbort = undefined;
    this.subscribing = false;
    this.live = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private async ensure(includeArchived: boolean, signal?: AbortSignal) {
    this.checkWatchdog();
    const age = Date.now() - this.loadedAt;
    const stale =
      !this.loadedAt ||
      this.dirty ||
      (this.maxAgeMs > 0 && age > this.maxAgeMs) ||
      (!this.live && age > this.staleAfterMs);
    if (stale) {
      // Clear before loading so an invalidate() that lands mid-refresh
      // (a command dispatched concurrently) survives to the next read.
      this.dirty = false;
      try {
        await this.refresh(signal);
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    }
    if (includeArchived && !this.archivedLoaded) await this.loadArchived();
    this.ensureSubscription();
  }

  private async refresh(signal?: AbortSignal): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.deps
      .loadActive(signal)
      .then((raw) => this.applySnapshot(raw))
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }

  private async loadArchived(): Promise<void> {
    const raw = await this.deps.loadArchived();
    this.archived = new Map(
      raw.threads.map((thread) => {
        const normalized = normalizeShell(thread);
        return [normalized.id, normalized];
      }),
    );
    this.archivedLoaded = true;
    this.sequence = Math.max(this.sequence, raw.snapshotSequence);
    this.updatedAt = Date.now();
  }

  private applySnapshot(raw: RawShellSnapshot, replace = true) {
    if (replace) {
      this.projects = new Map(
        raw.projects.map((project) => [project.id, project]),
      );
      this.active = new Map();
    } else {
      for (const project of raw.projects)
        this.projects.set(project.id, project);
    }
    for (const thread of raw.threads) {
      const normalized = normalizeShell(thread);
      this.active.set(normalized.id, normalized);
      this.archived.delete(normalized.id);
    }
    if (raw.archivedThreads?.length) {
      if (replace) this.archived = new Map();
      for (const thread of raw.archivedThreads) {
        const normalized = normalizeShell(thread);
        this.archived.set(normalized.id, normalized);
        this.active.delete(normalized.id);
      }
      this.archivedLoaded = true;
    }
    this.sequence = Math.max(this.sequence, raw.snapshotSequence);
    if (replace) this.loadedAt = Date.now();
    this.updatedAt = Date.now();
  }

  private ensureSubscription() {
    this.startWatchdog();
    if (this.subscribing) return;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.subscriptionAbort = abort;
    this.subscribing = true;
    this.live = false;
    this.subscribedAt = Date.now();
    this.subscription = this.deps
      .subscribe(
        this.sequence,
        (items) => {
          if (generation !== this.generation) return;
          this.live = true;
          this.lastStreamItemAt = Date.now();
          this.applyItems(items);
        },
        abort.signal,
      )
      .catch(() => undefined)
      .finally(() => {
        if (generation !== this.generation) return;
        this.subscribing = false;
        this.live = false;
      });
    // The assigned promise is intentionally not awaited: it lives for the
    // process lifetime. Keep a reference so it is not garbage-collected.
    void this.subscription;
  }

  private startWatchdog() {
    if (this.watchdog || this.watchdogMs <= 0) return;
    this.watchdog = setInterval(
      () => this.checkWatchdog(),
      Math.min(this.watchdogMs, 60_000),
    );
    this.watchdog.unref?.();
  }

  /** Restart a subscription that has delivered nothing for watchdogMs. */
  private checkWatchdog() {
    if (!this.subscribing || this.watchdogMs <= 0) return;
    const lastSign = Math.max(this.lastStreamItemAt, this.subscribedAt);
    if (Date.now() - lastSign <= this.watchdogMs) return;
    this.streamRestarts++;
    this.generation++;
    this.subscriptionAbort?.abort();
    this.subscriptionAbort = undefined;
    this.subscribing = false;
    this.live = false;
    // Deltas may have been missed while the stream was silent.
    this.dirty = true;
    this.ensureSubscription();
  }

  private applyItems(items: ShellStreamItem[]) {
    for (const item of items) {
      switch (item.kind) {
        case "snapshot":
          if (item.snapshot) this.applySnapshot(item.snapshot, false);
          break;
        case "thread.updated":
          if (!item.thread) break;
          this.upsert(
            item.location === "archive" ? "archive" : "active",
            item.thread,
          );
          break;
        case "thread.removed":
          if (item.threadId) {
            this.active.delete(item.threadId);
            this.archived.delete(item.threadId);
          }
          break;
        case "project.updated":
          if (item.project) this.projects.set(item.project.id, item.project);
          break;
        case "project.removed":
          if (item.projectId) this.projects.delete(item.projectId);
          break;
        case "synchronized":
          break;
        default:
          // Forward-compatible: unknown stream item kinds are ignored.
          break;
      }
      if (typeof item.sequence === "number")
        this.sequence = Math.max(this.sequence, item.sequence);
    }
    this.updatedAt = Date.now();
  }

  private upsert(location: "active" | "archive", raw: RawThreadShell) {
    const thread = normalizeShell(raw);
    if (location === "archive") {
      this.archived.set(thread.id, thread);
      this.active.delete(thread.id);
      this.archivedLoaded = true;
    } else {
      this.active.set(thread.id, thread);
      this.archived.delete(thread.id);
    }
  }
}
