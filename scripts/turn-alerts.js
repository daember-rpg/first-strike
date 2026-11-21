import { MODULE_ID } from "./constants.js";
import { getDisplayInfo } from "./tracker-app.js";

const BANNER_ID = "first-strike-banner";
const GLOW_ID = "first-strike-glow";
const SETTLE_MS = 250;

let settleTimer = null;
let lastAnnouncedKey = null;

/**
 * Same notion of "gets skipped" the auto-skip uses: someone defeated,
 * hidden, delaying, or surprised in round 1 never actually takes the
 * turn, so they never get a banner either.
 */
function isSkippable(combatant, combat) {
  const hidden = combatant.token?.hidden ?? false;
  const delayed = combatant.getFlag(MODULE_ID, "delayed") ?? false;
  const surprised = (combatant.getFlag(MODULE_ID, "surprised") ?? false) && combat.round === 1;
  return combatant.isDefeated || hidden || delayed || surprised;
}

function isMine(combatant) {
  return !game.user.isGM && !!combatant.actor?.isOwner;
}

/** First combatant after the active one who would really take a turn. */
function findUpNext(combat, current) {
  const turns = combat.turns;
  const start = turns.findIndex((c) => c.id === current.id);
  if (start < 0) return null;
  for (let step = 1; step < turns.length; step++) {
    const candidate = turns[(start + step) % turns.length];
    if (!isSkippable(candidate, combat)) return candidate;
  }
  return null;
}

/**
 * Called on every turn/round change. Waits for the change to settle
 * (the GM's client may still be auto-skipping past defeated/hidden
 * combatants) and then shows at most one banner for whoever really
 * ended up active.
 */
export function scheduleTurnAlert(combat) {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => announce(combat), SETTLE_MS);
}

function announce(combat) {
  try {
    const mode = game.settings.get(MODULE_ID, "turnAlerts");
    if (mode === "off") return;
    if (!combat?.started || game.combats?.active?.id !== combat.id) return;

    const current = combat.combatant;
    if (!current || isSkippable(current, combat)) return;

    const key = `${combat.id}:${combat.round}:${current.id}`;
    if (key === lastAnnouncedKey) return;
    lastAnnouncedKey = key;

    if (isMine(current)) {
      const info = getDisplayInfo(current);
      showBanner({ variant: "mine", label: "Your turn", name: info.name, img: info.img, glow: true });
      return;
    }

    if (!game.user.isGM) {
      const next = findUpNext(combat, current);
      if (next && isMine(next)) {
        const info = getDisplayInfo(next);
        showBanner({ variant: "next", label: "You're up next", name: info.name, img: info.img, glow: false });
        return;
      }
    }

    if (mode === "all") {
      const info = getDisplayInfo(current);
      showBanner({ variant: "other", label: "Now acting", name: info.name, img: info.img, glow: false });
    }
  } catch (err) {
    // A cosmetic cue must never be able to break turn handling.
    console.error("First Strike | turn alert failed", err);
  }
}

function ensureElement(id, className) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.className = className;
    document.body.appendChild(el);
  }
  return el;
}

/** Restarts a one-shot CSS animation by toggling its class across a reflow. */
function replay(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function showBanner({ variant, label, name, img, glow }) {
  const banner = ensureElement(BANNER_ID, "first-strike-banner");
  banner.classList.remove("is-mine", "is-next", "is-other");
  banner.classList.add(`is-${variant}`);

  const portrait = document.createElement("div");
  portrait.className = "first-strike-banner__portrait";
  if (img) portrait.style.backgroundImage = `url(${JSON.stringify(img)})`;

  const text = document.createElement("div");
  text.className = "first-strike-banner__text";
  const labelEl = document.createElement("span");
  labelEl.className = "first-strike-banner__label";
  labelEl.textContent = label;
  const nameEl = document.createElement("span");
  nameEl.className = "first-strike-banner__name";
  nameEl.textContent = name;
  text.append(labelEl, nameEl);

  banner.replaceChildren(portrait, text);
  replay(banner, "is-visible");

  if (glow) replay(ensureElement(GLOW_ID, "first-strike-glow"), "is-visible");
}
