import {
  BOOKABLE_ROOM_NAMES,
  BookingPoller,
  cancelBooking,
  createBooking,
  isOwnBooking,
  matchRoomName,
  roomStatus,
  type RoomEvent
} from "./booking";
import { ALLOWED_DOMAIN, currentUser, onUserChange, restoreSession, signIn, signOut } from "./google";
import type { RoomBookingStatus } from "./interaction";
import { showSection } from "./panel";

// Room booking UI, following the Cesium app (cesium_demo/src/ui.ts openBookingPanel, main.ts book button,
// booking.ts toasts): sign in with Google, see each meeting room's bookings for today, book a slot, cancel your own.

export type BookingHooks = {
  /** Catalog floor (group id) a booking room is on, if known. */
  floorOf: (room: string) => string | undefined;
  /** Show the room's floor and fly to it. */
  focusRoom: (room: string, floor: string) => void;
  /** Booking data changed (re-tint rooms, repaint). */
  onChange: () => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const toTimeInput = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FLOOR_LABEL: Record<string, string> = { second: "2nd Floor", third: "3rd Floor" };

export class BookingUi {
  private readonly account = $<HTMLElement>("booking-account");
  private readonly roomList = $<HTMLElement>("booking-rooms");
  private readonly sectionMessage = $<HTMLElement>("booking-message");
  private readonly card = $<HTMLElement>("booking-card");
  private readonly cardTitle = $<HTMLElement>("booking-card-title");
  private readonly cardMeta = $<HTMLElement>("booking-card-meta");
  private readonly cardList = $<HTMLElement>("booking-card-list");
  private readonly form = $<HTMLFormElement>("booking-form");
  private readonly titleInput = $<HTMLInputElement>("booking-title");
  private readonly startInput = $<HTMLInputElement>("booking-start");
  private readonly endInput = $<HTMLInputElement>("booking-end");
  private readonly bookButton = $<HTMLButtonElement>("booking-submit");
  private readonly cardMessage = $<HTMLElement>("booking-card-message");
  private readonly toasts = $<HTMLElement>("toasts");

  private readonly poller: BookingPoller;
  private loaded = false;
  private openRoom: string | null = null;
  private signingIn = false;
  private submitting = false;

  constructor(private readonly hooks: BookingHooks) {
    this.poller = new BookingPoller(
      (events, added, removed) => {
        this.loaded = true;
        // Your own new bookings already got a toast when you made them.
        for (const e of added) if (!isOwnBooking(e)) this.toast(`${e.room} booked by ${e.organizer} at ${time(e.start)}`, "info");
        for (const e of removed) this.toast(`${e.room} is now available`, "success");
        this.sectionMessage.textContent = "";
        this.render();
      },
      (error) => {
        this.sectionMessage.textContent = `Could not read room calendars: ${error.message}`;
      }
    );

    onUserChange((user) => {
      this.loaded = false;
      if (user) this.poller.start();
      else this.poller.stop();
      this.render();
    });

    $("booking-card-close").addEventListener("click", () => this.closeRoom());
    $("booking-card-show").addEventListener("click", () => {
      const floor = this.openRoom && this.hooks.floorOf(this.openRoom);
      if (this.openRoom && floor) this.hooks.focusRoom(this.openRoom, floor);
    });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.book();
    });
    for (const button of this.form.querySelectorAll<HTMLButtonElement>("[data-duration]")) {
      button.addEventListener("click", () => {
        const start = this.parseTime(this.startInput.value);
        if (start) this.endInput.value = toTimeInput(new Date(start.valueOf() + Number(button.dataset.duration) * 60_000));
      });
    }

    this.render();
    void restoreSession();
  }

  /** Popup status for a room shape name: undefined = not bookable, null = unknown (signed out / loading). */
  statusFor(shapeName: string): RoomBookingStatus | undefined {
    const room = matchRoomName(shapeName);
    if (!room || !BOOKABLE_ROOM_NAMES.includes(room)) return undefined;
    if (!currentUser() || !this.loaded) return null;
    const s = roomStatus(room, this.poller.events);
    return { busy: s.busy, label: s.label };
  }

  /** Tint for a room shape name: "busy"/"free" for bookable rooms once bookings are known. */
  tintFor(shapeName: string): "free" | "busy" | null {
    const status = this.statusFor(shapeName);
    return status ? (status.busy ? "busy" : "free") : null;
  }

  /** Open the booking card for a room (by room-shape or calendar name). */
  openFor(shapeName: string): void {
    const room = matchRoomName(shapeName);
    if (!room) return;
    this.openRoom = room;
    const now = new Date();
    const start = new Date(Math.ceil(now.valueOf() / 1_800_000) * 1_800_000); // next half hour
    this.startInput.value = toTimeInput(start);
    this.endInput.value = toTimeInput(new Date(start.valueOf() + 3_600_000));
    this.titleInput.value = "";
    this.cardMessage.textContent = "";
    this.cardMessage.className = "";
    this.card.hidden = false;
    showSection("booking-section");
    this.render();
  }

  private closeRoom(): void {
    this.openRoom = null;
    this.card.hidden = true;
  }

  // --- Rendering

  private render(): void {
    const user = currentUser();
    this.account.innerHTML = user
      ? `<span class="booking-user" title="${escapeHtml(user.email)}">👤 ${escapeHtml(user.name)}</span><button id="booking-signout">Sign out</button>`
      : `<button id="booking-signin" class="primary">${this.signingIn ? "Signing in…" : "Sign in with Google"}</button><span class="booking-hint">@${ALLOWED_DOMAIN} accounts</span>`;
    this.account.querySelector("#booking-signout")?.addEventListener("click", () => signOut());
    this.account.querySelector("#booking-signin")?.addEventListener("click", () => void this.signIn());

    this.roomList.replaceChildren(
      ...BOOKABLE_ROOM_NAMES.map((room) => {
        const row = document.createElement("button");
        row.className = "booking-room";
        const status = user && this.loaded ? roomStatus(room, this.poller.events) : null;
        const floor = this.hooks.floorOf(room);
        row.innerHTML = `
          <span class="dot ${status ? (status.busy ? "busy" : "free") : "unknown"}"></span>
          <span class="name">${escapeHtml(room)}<small>${floor ? FLOOR_LABEL[floor] ?? "" : ""}</small></span>
          <span class="state">${status ? escapeHtml(status.label) : user ? "Loading…" : ""}</span>`;
        row.addEventListener("click", () => {
          this.openFor(room);
          if (floor) this.hooks.focusRoom(room, floor);
        });
        return row;
      })
    );

    this.renderCard();
    this.hooks.onChange();
  }

  private renderCard(): void {
    const room = this.openRoom;
    if (!room) return;
    const user = currentUser();
    const floor = this.hooks.floorOf(room);
    this.cardTitle.textContent = room;

    if (!user) {
      this.cardMeta.innerHTML = `${floor ? FLOOR_LABEL[floor] + " · " : ""}<span class="muted">Sign in to see and make bookings</span>`;
      this.cardList.innerHTML = "";
      this.bookButton.disabled = true;
      return;
    }
    const status = roomStatus(room, this.poller.events);
    this.cardMeta.innerHTML = `${floor ? FLOOR_LABEL[floor] + " · " : ""}<span class="status ${status.busy ? "occupied" : "available"}">${
      this.loaded ? escapeHtml(status.label) : "Loading…"
    }</span>`;
    this.bookButton.disabled = !this.loaded || this.submitting;

    const today = this.poller.events.filter((e) => e.room === room && e.end > new Date());
    this.cardList.replaceChildren(
      ...(today.length
        ? today.map((e) => this.bookingRow(e))
        : [Object.assign(document.createElement("p"), { className: "booking-empty", textContent: this.loaded ? "No more bookings today" : "" })])
    );
  }

  private bookingRow(event: RoomEvent): HTMLElement {
    const row = document.createElement("div");
    row.className = "booking-item" + (isOwnBooking(event) ? " own" : "");
    row.innerHTML = `<div><b>${time(event.start)}–${time(event.end)}</b> · ${escapeHtml(event.organizer)}<br/><span class="muted">${escapeHtml(event.title)}</span></div>`;
    if (isOwnBooking(event)) {
      const cancel = document.createElement("button");
      cancel.className = "danger";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        cancel.textContent = "Cancelling…";
        try {
          await cancelBooking(event.id);
          this.toast("Booking cancelled", "success");
          row.remove();
          await this.poller.refresh();
        } catch (error) {
          this.toast(error instanceof Error ? error.message : "Failed to cancel", "error");
          cancel.disabled = false;
          cancel.textContent = "Cancel";
        }
      });
      row.appendChild(cancel);
    }
    return row;
  }

  // --- Actions

  private async signIn(): Promise<void> {
    this.signingIn = true;
    this.render();
    try {
      const user = await signIn();
      this.toast(`Signed in as ${user.email}`, "success");
    } catch (error) {
      this.toast(error instanceof Error ? error.message : "Sign-in failed", "error");
    } finally {
      this.signingIn = false;
      this.render();
    }
  }

  private parseTime(value: string): Date | null {
    if (!value) return null;
    const [h, m] = value.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  private async book(): Promise<void> {
    const room = this.openRoom;
    if (!room) return;
    const start = this.parseTime(this.startInput.value);
    const end = this.parseTime(this.endInput.value);
    const fail = (text: string) => {
      this.cardMessage.textContent = text;
      this.cardMessage.className = "error";
    };
    if (!currentUser()) return fail("Sign in with Google first.");
    if (!start || !end) return fail("Set a start and end time.");
    if (end <= start) return fail("End time must be after start time.");
    if (end <= new Date()) return fail("That time has already passed.");

    this.submitting = true;
    this.bookButton.disabled = true;
    this.bookButton.textContent = "Booking…";
    this.cardMessage.textContent = "";
    try {
      await createBooking(room, start, end, this.titleInput.value);
      this.toast(`${room} booked ${time(start)}–${time(end)}`, "success");
      this.cardMessage.textContent = "Booked! It's in your Google Calendar.";
      this.cardMessage.className = "success";
      this.titleInput.value = "";
      await this.poller.refresh();
    } catch (error) {
      fail(error instanceof Error ? error.message : "Booking failed");
    } finally {
      this.submitting = false;
      this.bookButton.textContent = "Book room";
      this.bookButton.disabled = false;
    }
  }

  private toast(message: string, type: "info" | "success" | "error"): void {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    this.toasts.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("visible")));
    window.setTimeout(() => {
      toast.classList.remove("visible");
      window.setTimeout(() => toast.remove(), 400);
    }, 4500);
  }
}
