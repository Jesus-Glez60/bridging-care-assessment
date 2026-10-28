// In-memory calendar store. Events belong to an account; ids are globally unique.
// Every change (create, update, delete) increments `version`.

export interface TwEvent {
  id: string;
  accountId: string;
  title: string;
  start: string;
  end: string;
  app_ref: string | null;
  version: number;
}

/** The shape Tidewater returns from the API and includes in webhooks. */
export const publicView = ({ id, version, title, start, end, app_ref }: TwEvent) => ({
  id,
  version,
  title,
  start,
  end,
  app_ref,
});

export class ValidationError extends Error {}

// Tidewater requires an explicit offset ("Z" or "+hh:mm"). Naive local timestamps are rejected.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function checkTimestamp(field: string, value: unknown): string {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO-8601 timestamp with an offset, e.g. 2026-11-03T16:00:00-06:00`);
  }
  return value;
}

type Fields = { title?: string; start?: string; end?: string; app_ref?: string | null };

function parseFields(input: unknown, requireAll: boolean): Fields {
  if (!input || typeof input !== "object") throw new ValidationError("Body must be a JSON object");
  const body = input as Record<string, unknown>;
  const out: Fields = {};
  if (body.title !== undefined || requireAll) {
    if (typeof body.title !== "string" || !body.title.trim()) throw new ValidationError("title must be a non-empty string");
    out.title = body.title;
  }
  if (body.start !== undefined || requireAll) out.start = checkTimestamp("start", body.start);
  if (body.end !== undefined || requireAll) out.end = checkTimestamp("end", body.end);
  if (body.app_ref !== undefined) {
    if (!requireAll) throw new ValidationError("app_ref can only be set when the event is created");
    if (body.app_ref !== null && (typeof body.app_ref !== "string" || body.app_ref.length > 256)) {
      throw new ValidationError("app_ref must be a string of at most 256 characters");
    }
    out.app_ref = body.app_ref as string | null;
  }
  return out;
}

function checkRange(start: string, end: string) {
  if (Date.parse(end) <= Date.parse(start)) throw new ValidationError("end must be after start");
}

export class EventStore {
  private events = new Map<string, TwEvent>();

  load(events: TwEvent[]) {
    this.events.clear();
    for (const e of events) this.events.set(e.id, { ...e });
  }

  all(): TwEvent[] {
    return [...this.events.values()];
  }

  list(accountId: string): TwEvent[] {
    return this.all().filter((e) => e.accountId === accountId);
  }

  get(accountId: string, id: string): TwEvent | undefined {
    const e = this.events.get(id);
    return e && e.accountId === accountId ? e : undefined;
  }

  create(accountId: string, input: unknown, id: string): TwEvent {
    const f = parseFields(input, true);
    checkRange(f.start!, f.end!);
    const event: TwEvent = { id, accountId, title: f.title!, start: f.start!, end: f.end!, app_ref: f.app_ref ?? null, version: 1 };
    this.events.set(id, event);
    return { ...event };
  }

  update(accountId: string, id: string, input: unknown): TwEvent | undefined {
    const current = this.get(accountId, id);
    if (!current) return undefined;
    const f = parseFields(input, false);
    const next: TwEvent = { ...current, ...f, version: current.version + 1 };
    checkRange(next.start, next.end);
    this.events.set(id, next);
    return { ...next };
  }

  /** Removes the event and returns its final state, with the version bumped for the delete. */
  remove(accountId: string, id: string): TwEvent | undefined {
    const current = this.get(accountId, id);
    if (!current) return undefined;
    this.events.delete(id);
    return { ...current, version: current.version + 1 };
  }
}
