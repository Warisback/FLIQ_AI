const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const menuToggle = document.querySelector(".menu-toggle");
const landingMenu = document.getElementById("landing-menu");
if (menuToggle && landingMenu) {
  const closeMenu = () => {
    menuToggle.setAttribute("aria-expanded", "false");
    landingMenu.hidden = true;
  };
  menuToggle.addEventListener("click", () => {
    const open = menuToggle.getAttribute("aria-expanded") !== "true";
    menuToggle.setAttribute("aria-expanded", String(open));
    landingMenu.hidden = !open;
  });
  landingMenu.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".floating-header")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !landingMenu.hidden) {
      closeMenu();
      menuToggle.focus();
    }
  });
}
const tiles = [...document.querySelectorAll("[data-depth]")];
if (tiles.length && !reduceMotion) {
  let scheduled = false;
  function renderWall() {
    const y = Math.min(scrollY, innerHeight * 0.22);
    for (const tile of tiles)
      tile.style.setProperty("--drift", `${y * Number(tile.dataset.depth)}px`);
    scheduled = false;
  }
  addEventListener(
    "scroll",
    () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(renderWall);
      }
    },
    { passive: true },
  );
  renderWall();
}
const consequences = {
  refuse:
    "The window is open. The candle is out. Van Helsing stands at the door, too late.",
  truth:
    "Morning light finds you safe. The room is fortified. Van Helsing sleeps in the chair beside you.",
  invite:
    "An empty room. An unslept bed. Jonathan wakes alone beneath the shadow of a bat.",
};
document.querySelectorAll("[data-choice]").forEach((button) =>
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-choice]")
      .forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
    document.getElementById("choice-result").textContent =
      consequences[button.dataset.choice];
  }),
);
document.querySelectorAll("[data-cast]").forEach((button) =>
  button.addEventListener("click", () => {
    location.href = `/play.html?character=${encodeURIComponent(button.dataset.cast)}`;
  }),
);
