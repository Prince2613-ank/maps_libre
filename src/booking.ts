import { currentUser, googleApi } from "./google";

// Room booking against the shared Google room calendars, ported from the Cesium app (cesium_demo/src/booking.ts).

/** Shared room calendars — all bookings are written to and read from these (cesium_demo/src/config.ts). */
export const ROOM_CALENDARS: Record<string, string> = {
  Dojo: "c_18844fj9dapfqiqkis358k72s6qu6@resource.calendar.google.com",
  Manthan: "c_188f0m5k240tajcghiklsvkpk1osq@resource.calendar.google.com",
  Eureka: "c_188e1suqr4kriiu9l3etqtf5qm6ps@resource.calendar.google.com",
  "Meeting Room": "c_188bvfn5afmqaj3djm0hbjqlfpkac@resource.calendar.google.com",
  "Conference Room": "c_18811n8dsq2v8haakdhev0subolt4@resource.calendar.google.com"
};

export const BOOKABLE_ROOM_NAMES = Object.keys(ROOM_CALENDARS);
const POLL_INTERVAL_MS = 8000;
const CACHE_TTL_MS = 5000;
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";

export type RoomEvent = {
  id: string;
  room: string;
  title: string;
  start: Date;
  end: Date;
  /** Organizer's email name (before the @), as shown in the Cesium app. */
  organizer: string;
  organizerEmail: string;
};

/** Booking-calendar room name for a room-shape name (cesium_demo/src/booking.ts matchRoomName). */
export function matchRoomName(raw: string): string | null {
  const n = raw.toLowerCase();
  if (n.includes("dojo")) return "Dojo";
  if (n.includes("eureka")) return "Eureka";
  if (n.includes("manthan")) return "Manthan";
  if (n.includes("meeting room") || (n.includes("meeting") && !n.includes("eureka"))) return "Meeting Room";
  if (n.includes("conference room") || n.includes("conference")) return "Conference Room";
  return null;
}

const calendarUrl = (calendarId: string, path = "") => `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events${path}`;

let cache: { events: RoomEvent[]; ts: number } | null = null;

function normalize(raw: any, room: string): RoomEvent {
  const organizerEmail: string = raw.organizer?.email ?? raw.creator?.email ?? "";
  return {
    id: raw.id ?? `${room}-${Date.now()}`,
    room,
    title: raw.summary ?? "Meeting",
    start: new Date(raw.start?.dateTime ?? raw.start?.date ?? ""),
    end: new Date(raw.end?.dateTime ?? raw.end?.date ?? ""),
    organizer: organizerEmail.split("@")[0] || "Unknown",
    organizerEmail
  };
}

/** Today's remaining events in every room calendar (from now to midnight). */
export async function fetchRoomEvents(force = false): Promise<RoomEvent[]> {
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.events;
  const now = new Date();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const query = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "200"
  });

  const results = await Promise.allSettled(
    Object.entries(ROOM_CALENDARS).map(async ([room, calendarId]) => {
      const data = await googleApi<{ items?: any[] }>(`${calendarUrl(calendarId)}?${query}`);
      return (data.items ?? []).filter((item) => item.status !== "cancelled").map((item) => normalize(item, room));
    })
  );

  const seen = new Set<string>();
  const events: RoomEvent[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.warn(`[Booking] Could not read the ${BOOKABLE_ROOM_NAMES[i]} calendar:`, result.reason);
      return;
    }
    for (const event of result.value) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  });
  // Every calendar failing means we can't see anything (e.g. no access) — report it rather than show "free".
  if (results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  events.sort((a, b) => a.start.valueOf() - b.start.valueOf());
  cache = { events, ts: Date.now() };
  return events;
}

export function findConflict(room: string, start: Date, end: Date, events: RoomEvent[]): RoomEvent | null {
  return events.find((e) => e.room === room && !(end <= e.start || start >= e.end)) ?? null;
}

const timeText = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Book a room: the event goes in the user's own calendar with the room as a resource attendee (Google then
 * updates the room calendar). If the room declines (double booking), the event is removed again.
 */
export async function createBooking(room: string, start: Date, end: Date, title: string): Promise<void> {
  const user = currentUser();
  if (!user) throw new Error("Sign in with Google to book a room.");
  const roomCalendar = ROOM_CALENDARS[room];
  if (!roomCalendar) throw new Error(`No calendar is set up for "${room}".`);

  const conflict = findConflict(room, start, end, await fetchRoomEvents(true).catch(() => cache?.events ?? []));
  if (conflict) throw new Error(`${room} is already booked ${timeText(conflict.start)}–${timeText(conflict.end)} by ${conflict.organizer}.`);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const created = await googleApi<{ id: string }>(calendarUrl("primary"), {
    method: "POST",
    body: JSON.stringify({
      summary: title.trim() || `${room} – Meeting`,
      location: room,
      start: { dateTime: start.toISOString(), timeZone },
      end: { dateTime: end.toISOString(), timeZone },
      description: `Booked via MapLibre Indoor by ${user.email}`,
      attendees: [{ email: roomCalendar, resource: true }]
    })
  });

  // Give Google a moment to process the room's auto-accept/decline.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const check = await googleApi<{ attendees?: { email: string; responseStatus?: string }[] }>(calendarUrl("primary", `/${created.id}`));
  if (check.attendees?.find((a) => a.email === roomCalendar)?.responseStatus === "declined") {
    await googleApi(calendarUrl("primary", `/${created.id}`), { method: "DELETE" }).catch(() => undefined);
    throw new Error(`${room} is already booked for this time.`);
  }
  cache = null;
}

/** Cancel one of your own bookings. */
export async function cancelBooking(eventId: string): Promise<void> {
  await googleApi(calendarUrl("primary", `/${eventId}`), { method: "DELETE" });
  cache = null;
}

export function isOwnBooking(event: RoomEvent): boolean {
  const user = currentUser();
  if (!user) return false;
  return event.organizerEmail ? event.organizerEmail.toLowerCase() === user.email.toLowerCase() : event.organizer === user.email.split("@")[0];
}

export type RoomStatus = { busy: boolean; label: string; current?: RoomEvent; next?: RoomEvent };

export function roomStatus(room: string, events: RoomEvent[], now = new Date()): RoomStatus {
  const mine = events.filter((e) => e.room === room && e.end > now);
  const current = mine.find((e) => e.start <= now);
  const next = mine.find((e) => e.start > now);
  if (current) return { busy: true, label: `In use until ${timeText(current.end)}`, current, next };
  if (next) return { busy: false, label: `Free until ${timeText(next.start)}`, next };
  return { busy: false, label: "Free for the rest of today" };
}

/** Poll the room calendars; `onUpdate` gets the events plus what appeared/disappeared since last time. */
export class BookingPoller {
  private timer: number | null = null;
  private previous: RoomEvent[] | null = null;
  events: RoomEvent[] = [];

  constructor(private readonly onUpdate: (events: RoomEvent[], added: RoomEvent[], removed: RoomEvent[]) => void, private readonly onError: (error: Error) => void) {}

  start(): void {
    this.stop();
    this.previous = null;
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.events = [];
    this.previous = null;
  }

  async refresh(force = true): Promise<void> {
    if (!currentUser()) return;
    try {
      const events = await fetchRoomEvents(force);
      const prevIds = new Set((this.previous ?? []).map((e) => e.id));
      const nextIds = new Set(events.map((e) => e.id));
      const added = this.previous ? events.filter((e) => !prevIds.has(e.id)) : [];
      const removed = this.previous ? this.previous.filter((e) => !nextIds.has(e.id) && e.end > new Date()) : [];
      this.previous = events;
      this.events = events;
      this.onUpdate(events, added, removed);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
