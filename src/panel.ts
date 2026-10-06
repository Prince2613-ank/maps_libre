// Side panel: tabs, collapse, and the layout variables the map controls use to stay clear of it.
// Each tab's content is a <details> element that is open while its tab is selected.

const TAB_KEY = "indoor.panel-tab";
const PHONE = window.matchMedia("(max-width: 640px)");

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

  for (const tab of tabs) tab.addEventListener("click", () => activate(tab.dataset.tab!));
  // Arrow keys move between tabs, as in any tab list.
  panel.querySelector('[role="tablist"]')!.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    const current = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    const next = tabs[(current + (key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    activate(next.dataset.tab!);
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
