import { icon } from "./icons";
import type { RoomChoice } from "./navigation";

// Search bar at the top of the panel: finds rooms by name (and floor), flies to the one you pick, or starts
// indoor directions to it. While a query is typed, the results replace the panel's tabs.

export type SearchHooks = {
  rooms: () => readonly RoomChoice[];
  floorLabel: (floor: string) => string;
  /** undefined = not a bookable room, null = bookable but status unknown. */
  bookingStatus: (roomName: string) => { busy: boolean; label: string } | null | undefined;
  focus: (room: RoomChoice) => void;
  routeTo: (room: RoomChoice) => void;
};

const MAX_RESULTS = 8;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function setupSearch(hooks: SearchHooks): void {
  const panel = document.getElementById("panel")!;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const clear = document.getElementById("search-clear") as HTMLButtonElement;
  const results = document.getElementById("search-results")!;
  let matches: RoomChoice[] = [];

  const reset = () => {
    input.value = "";
    render();
  };

  const choose = (room: RoomChoice, route: boolean) => {
    if (route) hooks.routeTo(room);
    else hooks.focus(room);
    reset();
    input.blur();
  };

  const row = (room: RoomChoice): HTMLElement => {
    const status = hooks.bookingStatus(room.roomName);
    const meta = [hooks.floorLabel(room.floor)];
    if (status !== undefined) meta.push(status ? `<span class="${status.busy ? "busy" : "free"}">${escapeHtml(status.label)}</span>` : "Meeting room");
    const el = document.createElement("div");
    el.className = "search-result";
    el.innerHTML = `
      <button type="button" class="search-main">
        <span class="search-icon">${icon("door")}</span>
        <span class="search-text"><b>${escapeHtml(room.roomName)}</b><small>${meta.join(" · ")}</small></span>
      </button>
      <button type="button" class="icon-btn" title="Directions to ${escapeHtml(room.roomName)}" aria-label="Directions to ${escapeHtml(room.roomName)}">${icon("route")}</button>`;
    const [main, route] = el.querySelectorAll("button");
    main.addEventListener("click", () => choose(room, false));
    route.addEventListener("click", () => choose(room, true));
    return el;
  };

  function render(): void {
    const query = input.value.trim().toLowerCase();
    const searching = query.length > 0;
    panel.classList.toggle("searching", searching);
    clear.hidden = !searching;
    results.hidden = !searching;
    matches = [];
    if (!searching) return results.replaceChildren();

    const rooms = hooks.rooms();
    if (!rooms.length) {
      results.innerHTML = `<p class="search-empty">Loading rooms…</p>`;
      return;
    }
    const terms = query.split(/\s+/);
    matches = rooms
      .filter((room) => {
        const haystack = `${room.label} ${hooks.floorLabel(room.floor)}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      // Names that start with the query first, then alphabetical.
      .sort((a, b) => Number(!a.roomName.toLowerCase().startsWith(query)) - Number(!b.roomName.toLowerCase().startsWith(query)) || a.label.localeCompare(b.label))
      .slice(0, MAX_RESULTS);
    if (!matches.length) {
      results.innerHTML = `<p class="search-empty">No rooms match “${escapeHtml(input.value.trim())}”</p>`;
      return;
    }
    results.replaceChildren(...matches.map(row));
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && matches[0]) choose(matches[0], false);
    else if (event.key === "Escape") reset();
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      results.querySelector<HTMLButtonElement>(".search-main")?.focus();
    }
  });
  // Arrow keys move through the results; Escape returns to the box.
  results.addEventListener("keydown", (event) => {
    const buttons = [...results.querySelectorAll<HTMLButtonElement>(".search-main")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") input.focus();
    if (index < 0 || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && index === 0) input.focus();
    else buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))].focus();
  });
  clear.addEventListener("click", () => {
    reset();
    input.focus();
  });
}
