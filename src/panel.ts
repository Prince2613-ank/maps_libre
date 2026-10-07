// Side panel: tabs, collapse, and the layout variables the map controls use to stay clear of it.
// Each tab's content is a <details> element that is open while its tab is selected.

const TAB_KEY = "indoor.panel-tab";
const PHONE = window.matchMedia("(max-width: 640px)");

// What each tab is for, shown as a short tip when someone clicks it.
const TIPS: Record<string, { title: string; text: string }> = {
  "overview-section": { title: "Overview", text: "See the place at a glance: its details, rooms and how busy it is. Click a room to see more." },
  "layers-section": { title: "Layers", text: "Turn parts of the 3D model on or off: building exterior and each floor, with its chairs and cameras." },
  "nav-section": { title: "Navigate", text: "Get directions. Pick a start and a destination room to draw the walking route across floors, or find a route from outside." },
  "booking-section": { title: "Booking", text: "Check meeting-room availability and see each room's upcoming bookings from the calendar." },
  "sun-section": { title: "Sun", text: "Light the building with the real sun for any date and time, with shadows, the sun's path and a day / night map." }
};
const TIP_SECONDS = 7;

function showTip(id: string): void {
  const tip = TIPS[id];
  if (!tip) return;
  let el = document.getElementById("tab-tip");
  if (!el) {
    el = document.createElement("div");
    el.id = "tab-tip";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
    el.addEventListener("click", () => el!.classList.remove("show"));
  }
  el.innerHTML = "";
  el.append(Object.assign(document.createElement("strong"), { textContent: tip.title }), Object.assign(document.createElement("span"), { textContent: tip.text }));
  el.classList.add("show");
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(window.setTimeout(() => el!.classList.remove("show"), TIP_SECONDS * 1000));
}

let activateSection: ((id: string) => void) | null = null;

/** Select a panel section's tab (e.g. "nav-section") and make sure the panel is expanded. */
export function showSection(id: string): void {
  activateSection?.(id);
}

export function setupPanel(): void {
  const panel = document.getElementById("panel")!;
  const collapse = document.getElementById("panel-collapse") as HTMLButtonElement;
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const sections = tabs.map((tab) => document.getElementById(tab.dataset.tab!) as HTMLDetailsElement);

  const setCollapsed = (collapsed: boolean) => {
    panel.classList.toggle("collapsed", collapsed);
    document.body.classList.toggle("panel-collapsed", collapsed);
    collapse.setAttribute("aria-expanded", String(!collapsed));
    collapse.title = collapsed ? "Expand panel" : "Collapse panel";
  };

  const activate = (id: string) => {
    for (const section of sections) section.open = section.id === id;
    for (const tab of tabs) {
      const selected = tab.dataset.tab === id;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    setCollapsed(false);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      // Remembering the tab is only a convenience.
    }
  };

  for (const tab of tabs) tab.addEventListener("click", () => {
    activate(tab.dataset.tab!);
    showTip(tab.dataset.tab!);
  });
  // Arrow keys move between tabs, as in any tab list.
  panel.querySelector('[role="tablist"]')!.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    const next = tabs[(current + (key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    activate(next.dataset.tab!);
    showTip(next.dataset.tab!);
    next.focus();
  });
  activateSection = activate;
  collapse.addEventListener("click", () => setCollapsed(!panel.classList.contains("collapsed")));

  let saved: string | null = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch {
    // Fall back to the first tab.
  }
  activate(sections.some((s) => s.id === saved) ? saved! : sections[0].id);
  // On a phone the panel is a bottom sheet; start it folded so the map is visible.
  if (PHONE.matches) setCollapsed(true);

  // Phones: bottom map controls sit above the sheet. Desktop: the base map switcher moves aside when the panel
  // reaches down to it (it is about 100px tall with the scale bar).
  const layout = () => {
    document.documentElement.style.setProperty("--panel-h", `${panel.offsetHeight}px`);
    document.body.classList.toggle("panel-tall", panel.getBoundingClientRect().bottom > window.innerHeight - 110);
  };
  new ResizeObserver(layout).observe(panel);
  window.addEventListener("resize", layout);
}
