import { EPHEMERAL_EVENTS, newId, type HarnessEvent, type HarnessEventInput } from "@mrog/shared";

type Listener = (event: HarnessEvent) => void;

/** A kept event; `event` is dropped when a later full copy of the same message replaces it. */
interface Slot {
  id: string;
  event: HarnessEvent | null;
}

/** Fan-out of harness events, keeping recent durable ones so a reconnecting stream can catch up. */
export class EventBus {
  private readonly recent: Slot[] = [];
  /** The slot holding each message's latest `message.updated`, which carries the whole message. */
  private readonly latestUpdate = new Map<string, Slot>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly capacity = 1000) {}

  publish(input: HarnessEventInput): HarnessEvent {
    const event = { ...input, id: newId("evt"), at: new Date().toISOString() } as HarnessEvent;
    if (!EPHEMERAL_EVENTS.has(event.type)) this.keep(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[bus] listener failed", error);
      }
    }
    return event;
  }

  /**
   * Adds an event to the replay ring. A long turn publishes a full copy of its message on every tool step, so an
   * older copy of the same message is emptied: replay sends only the newest, and the ring holds one per message.
   */
  private keep(event: HarnessEvent) {
    const slot: Slot = { id: event.id, event };
    if (event.type === "message.updated") {
      const older = this.latestUpdate.get(event.message.id);
      if (older) older.event = null;
      this.latestUpdate.set(event.message.id, slot);
    }
    this.recent.push(slot);
    if (this.recent.length > this.capacity) {
      const gone = this.recent.shift()!;
      if (gone.event?.type === "message.updated" && this.latestUpdate.get(gone.event.message.id) === gone)
        this.latestUpdate.delete(gone.event.message.id);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Durable events after `lastId`, or null when `lastId` is no longer held (the client must resync). */
  since(lastId: string): HarnessEvent[] | null {
    const at = this.recent.findIndex((slot) => slot.id === lastId);
    return at === -1 ? null : this.recent.slice(at + 1).flatMap((slot) => slot.event ?? []);
  }
}
