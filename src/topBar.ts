import { icon } from "./icons";
import { PLACE } from "./place";
import { TIPS, setTipsEnabled, tipsEnabled } from "./panel";

// Top bar shortcuts (markup in index.html): Fullscreen, Help, Settings and Profile.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let openMenu: { menu: HTMLElement; button: HTMLElement } | null = null;

function closeMenu(): void {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.button.setAttribute("aria-expanded", "false");
  openMenu = null;
}

/** A popover under a top bar button; clicking the button again, outside it, or pressing Esc closes it. */
function toggleMenu(button: HTMLElement, build: (menu: HTMLElement) => void): void {
  const wasOpen = openMenu?.button === button;
  closeMenu();
  if (wasOpen) return;
  const menu = document.createElement("div");
  menu.className = "tb-menu";
  build(menu);
  document.body.appendChild(menu);
  button.setAttribute("aria-expanded", "true");
  openMenu = { menu, button };
}

function menuRow(tag: "button" | "a" | "label", html: string): HTMLElement {
  const row = document.createElement(tag);
  row.innerHTML = html;
  return row;
}

function showHelp(): void {
  closeMenu();
  const backdrop = document.createElement("div");
  backdrop.className = "help-backdrop";
  const tabs = Object.values(TIPS)
    .map((tip) => `<dt>${tip.title}</dt><dd>${tip.text}</dd>`)
    .join("");
  backdrop.innerHTML = `
    <div class="help-dialog" role="dialog" aria-modal="true" aria-label="Help">
      <h2>How to use the indoor map</h2>
      <p>Explore the ${PLACE.name} building in 3D, find rooms and get directions.</p>
      <h3>Panel tabs</h3>
      <dl>${tabs}</dl>
      <h3>Moving around</h3>
      <dl>
        <dt>Pan</dt><dd>Drag the map.</dd>
        <dt>Zoom</dt><dd>Scroll, or use + / −.</dd>
        <dt>Rotate &amp; tilt</dt><dd>Right-drag (or Ctrl-drag), or use the rotate buttons on the right.</dd>
        <dt>Floors</dt><dd>Use the floor switcher on the right. Only one floor shows at a time.</dd>
        <dt>Rooms &amp; chairs</dt><dd>Click one for details, directions and booking.</dd>
        <dt>Home</dt><dd>The house button returns to the starting view.</dd>
      </dl>
      <button class="help-close" type="button">Got it</button>
    </div>`;
  const close = () => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector(".help-close")!.addEventListener("click", close);
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(backdrop);
  backdrop.querySelector<HTMLElement>(".help-close")!.focus();
}

export function setupTopBar(): void {
  const fullscreen = $<HTMLButtonElement>("tb-fullscreen");
  const syncFullscreen = () => {
    const on = document.fullscreenElement !== null;
    fullscreen.innerHTML = icon(on ? "minimize" : "maximize");
    fullscreen.title = fullscreen.ariaLabel = on ? "Exit fullscreen" : "Fullscreen";
  };
  if (document.fullscreenEnabled) {
    fullscreen.addEventListener("click", () => {
      closeMenu();
      void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined);
    });
    document.addEventListener("fullscreenchange", syncFullscreen);
  } else {
    fullscreen.hidden = true;
  }

  $("tb-help").addEventListener("click", showHelp);

  const settings = $("tb-settings");
  settings.addEventListener("click", () =>
    toggleMenu(settings, (menu) => {
      menu.innerHTML = "<h3>Settings</h3>";
      const tips = menuRow("label", `<span>Tab tips<small>Explain each tab when you open it</small></span><input type="checkbox" class="switch" ${tipsEnabled() ? "checked" : ""} />`);
      tips.querySelector("input")!.addEventListener("change", (event) => setTipsEnabled((event.target as HTMLInputElement).checked));
      const view = menuRow("button", "<span>Reset view<small>Back to the starting camera</small></span>");
      view.addEventListener("click", () => {
        closeMenu();
        $("rotate-reset").click();
      });
      const debug = menuRow("button", "<span>Debug tools<small>Adjust layers and edit GeoJSON</small></span>");
      debug.addEventListener("click", () => {
        closeMenu();
        $("debug-toggle").click();
      });
      menu.append(tips, view, debug);
    })
  );

  const profile = $("tb-profile");
  profile.addEventListener("click", () =>
    toggleMenu(profile, (menu) => {
      const user = document.createElement("div");
      user.className = "tb-user";
      user.innerHTML = `<span class="tb-badge">${icon("user")}</span><span><strong>Guest</strong><small>Sign-in isn't set up yet</small></span>`;
      const site = menuRow("a", `<span>${PLACE.name}<small>${PLACE.website.replace(/^https?:\/\//, "")}</small></span>${icon("globe")}`) as HTMLAnchorElement;
      site.href = PLACE.website;
      site.target = "_blank";
      site.rel = "noopener";
      menu.append(user, document.createElement("hr"), site);
    })
  );

  document.addEventListener("click", (event) => {
    const target = event.target as Node;
    if (openMenu && !openMenu.menu.contains(target) && !openMenu.button.contains(target)) closeMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  syncFullscreen();
}
