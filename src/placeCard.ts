import { icon } from "./icons";
import { showSection } from "./panel";
import type { Place } from "./place";
import { toSiteTime } from "./sun";

// Overview tab: a Google Maps–style card for the building — cover photo, name, rating, quick actions
// (Directions open Google Maps; Navigate and Book jump to those tabs) and address / hours / website.

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** "19:00" → "7 pm", "09:30" → "9:30 am". */
function clockLabel(hhmm: string): string {
  const minutes = toMinutes(hhmm);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

function hoursHtml({ opens, closes }: Place["hours"]): string {
  const now = toSiteTime(new Date()).minutes;
  const close = toMinutes(closes);
  if (opens === null) return now < close ? `Closes ${clockLabel(closes)}` : `<span class="closed">Closed</span> · Closes ${clockLabel(closes)}`;
  const open = toMinutes(opens);
  if (now >= open && now < close) return `<span class="open">Open</span> · Closes ${clockLabel(closes)}`;
  return `<span class="closed">Closed</span> · Opens ${clockLabel(opens)}`;
}

function toast(message: string): void {
  const container = document.getElementById("toasts");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("visible")));
  window.setTimeout(() => {
    el.classList.remove("visible");
    window.setTimeout(() => el.remove(), 400);
  }, 2500);
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast(`Couldn't copy the ${what.toLowerCase()}`);
  }
}

export function renderPlaceCard(container: HTMLElement, place: Place, coords: { lat: number; lon: number }): void {
  const googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name}, ${place.address}`)}`;
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lon}`;
  const site = place.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const action = (name: Parameters<typeof icon>[0], label: string, attrs: string, primary = false) =>
    `<${attrs.startsWith("href") ? "a" : "button type=\"button\""} class="place-action${primary ? " primary" : ""}" ${attrs}>
      <span class="place-action-icon">${icon(name)}</span><span>${label}</span>
    </${attrs.startsWith("href") ? "a" : "button"}>`;

  container.innerHTML = `
    <div class="place-cover">
      <img src="${import.meta.env.BASE_URL}${place.cover}" alt="${escapeHtml(place.name)}" />
    </div>
    <div class="place-head">
      <h2>${escapeHtml(place.name)}</h2>
      ${place.localName ? `<p class="place-local">${escapeHtml(place.localName)}</p>` : ""}
      <a class="place-rating" href="${googleUrl}" target="_blank" rel="noopener" title="See reviews on Google Maps">
        <b>${place.rating.toFixed(1)}</b>
        <span class="stars" style="--rating: ${place.rating}" aria-label="${place.rating} out of 5 stars">★★★★★</span>
        <span class="place-count">(${place.reviewCount})</span>
      </a>
      <p class="place-category">${escapeHtml(place.category)}</p>
    </div>
    <div class="place-actions">
      ${action("navigation", "Directions", `href="${directionsUrl}" target="_blank" rel="noopener" title="Directions to the building in Google Maps"`, true)}
      ${action("route", "Navigate inside", `data-section="nav-section" title="Turn-by-turn route between rooms"`)}
      ${action("calendar", "Book a room", `data-section="booking-section" title="Meeting room availability"`)}
      ${action("globe", "Website", `href="${place.website}" target="_blank" rel="noopener"`)}
      ${action("share", "Share", `data-share title="Share this map"`)}
    </div>
    <ul class="place-info">
      <li>
        ${icon("pin")}
        <span>${escapeHtml(place.address)}</span>
        <button type="button" class="icon-btn" data-copy-address title="Copy address" aria-label="Copy address">${icon("copy")}</button>
      </li>
      <li>${icon("clock")}<span class="place-hours">${hoursHtml(place.hours)}</span></li>
      <li>${icon("globe")}<a href="${place.website}" target="_blank" rel="noopener">${escapeHtml(site)}</a></li>
    </ul>`;

  const img = container.querySelector<HTMLImageElement>(".place-cover img")!;
  img.addEventListener("error", () => container.querySelector(".place-cover")!.classList.add("empty"));

  for (const button of container.querySelectorAll<HTMLButtonElement>("[data-section]")) {
    button.addEventListener("click", () => showSection(button.dataset.section!));
  }
  container.querySelector("[data-copy-address]")!.addEventListener("click", () => void copy(place.address, "Address"));
  container.querySelector("[data-share]")!.addEventListener("click", async () => {
    const data = { title: place.name, text: `${place.name} — indoor map`, url: window.location.href };
    if (navigator.share) {
      try {
        await navigator.share(data);
      } catch {
        // Cancelled by the user.
      }
    } else {
      await copy(data.url, "Link");
    }
  });

  // Keep "Closes 7 pm" / "Closed" current while the page stays open.
  const hours = container.querySelector<HTMLElement>(".place-hours")!;
  window.setInterval(() => (hours.innerHTML = hoursHtml(place.hours)), 60_000);
}
