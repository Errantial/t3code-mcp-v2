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
  ): Promise<void>;
}

/**
 * In-memory index of T3 thread shells.
 *
 * The first read pays for one shell snapshot; a subscription to
 * orchestration.subscribeShell then applies thread/project deltas in place.
 * Tools never rebuild the full 600-thread list per call, and a single-thread
 * read does not touch this index at all.
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
  private subscribing = false;
  private live = false;
  private dirty = false;
  private generation = 0;

  constructor(
    private readonly deps: ShellIndexDeps,
    private readonly staleAfterMs = 1_500,
  ) {}

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

  stats() {
    return {
      activeThreads: this.active.size,
      archivedThreads: this.archived.size,
      liveUpdates: this.live,
      snapshotSequence: this.sequence,
    };
  }

  private async ensure(includeArchived: boolean, signal?: AbortSignal) {
    const stale =
      !this.loadedAt ||
      this.dirty ||
      (!this.live && Date.now() - this.loadedAt > this.staleAfterMs);
    if (stale) {
      await this.refresh(signal);
      this.dirty = false;
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
    this.loadedAt = Date.now();
    this.updatedAt = this.loadedAt;
  }

  private ensureSubscription() {
    if (this.subscribing) return;
    const generation = ++this.generation;
    this.subscribing = true;
    this.live = false;
    this.subscription = this.deps
      .subscribe(this.sequence, (items) => {
        if (generation !== this.generation) return;
        this.live = true;
        this.applyItems(items);
      })
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
