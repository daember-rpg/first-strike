import { MODULE_ID, getActiveCombat } from "./constants.js";
import { getReminders, openRemindersPanel, closeRemindersPanel } from "./reminders.js";
import { panToActive } from "./camera.js";
import { requestRollInitiative, requestDelayTurn, requestActNow, requestEndTurn } from "./gm-actions.js";

export { MODULE_ID };
const COLLAPSE_STORAGE_KEY = "first-strike-collapsed";
const VIEW_STORAGE_KEY = "first-strike-view";
const POSITION_STORAGE_KEY = "first-strike-position";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Reads current/max HP from an actor. Tries the pf2e path first (this
 * campaign's system), then falls back to a couple of common
 * alternatives. Systems that don't expose a value/max HP resource at
 * all just get no HP bar.
 */
export function getActorHP(actor) {
  if (!actor) return null;

  const candidates = [
    actor.system?.attributes?.hp,
    actor.system?.hp
  ];

  for (const hp of candidates) {
    if (hp && typeof hp.value === "number" && typeof hp.max === "number") {
      return { value: hp.value, max: hp.max };
    }
  }

  return null;
}

/**
 * The GM sees everything. A player sees exact HP for actors they own,
 * and for the rest of the party (friendly-disposition combatants) so
 * the table can tell who needs healing without asking out loud.
 * Monster HP stays hidden from players either way.
 */
export function canSeeHP(actor, disposition) {
  if (game.user.isGM) return true;
  if (actor?.isOwner) return true;
  return disposition === "friendly";
}

export function getHPBand(pct) {
  if (pct === null) return "unknown";
  if (pct <= 10) return "low";
  if (pct >= 100) return "high";
  return "mid";
}

/**
 * Friendly/neutral/hostile, read off the combatant's token disposition.
 */
export function getDisposition(combatant) {
  const disposition = combatant.token?.disposition;
  if (disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) return "friendly";
  if (disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE) return "hostile";
  return "neutral";
}

/**
 * Up to 4 status effect icons to surface under the name.
 */
export function getStatusIcons(actor) {
  if (!actor) return [];
  const effects = actor.temporaryEffects ?? actor.effects?.contents ?? [];
  return effects
    .filter((e) => e.img && !e.disabled)
    .slice(0, 4)
    .map((e) => ({ img: e.img, label: e.name }));
}

/**
 * What a combatant looks like to the current user. With the "hide enemy
 * names" world setting on, players see hostile creatures they don't own
 * as an anonymous entry; the GM, and anyone who owns the creature, always
 * sees the real thing. Shared by the tracker and the turn banners so the
 * two can never disagree about what's being revealed.
 */
export function getDisplayInfo(combatant, disposition = getDisposition(combatant)) {
  const actor = combatant.actor;
  const masked =
    !game.user.isGM &&
    disposition === "hostile" &&
    !actor?.isOwner &&
    game.settings.get(MODULE_ID, "maskEnemyNames");

  if (masked) return { name: "Unknown creature", img: "icons/svg/mystery-man.svg", masked: true };
  return {
    name: combatant.name,
    img: actor?.img || combatant.img || "icons/svg/mystery-man.svg",
    masked: false
  };
}

export class FirstStrikeTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Leader ids of enemy stacks the user has opened up (a view-only choice). */
  expandedStacks = new Set();

  static DEFAULT_OPTIONS = {
    id: "first-strike-tracker",
    tag: "div",
    window: {
      frame: false,
      positioned: false
    },
    classes: ["first-strike-tracker"]
  };

  static PARTS = {
    tracker: {
      template: "modules/first-strike/templates/tracker.hbs"
    }
  };

  get collapsed() {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true";
  }

  set collapsed(value) {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? "true" : "false");
  }

  /** The tracker is always the horizontal strip of round portraits. */
  get viewMode() {
    return "strip";
  }

  get isStrip() {
    return true;
  }

  /** Each view remembers where the player dragged it, independently. */
  get positionKey() {
    return this.isStrip ? `${POSITION_STORAGE_KEY}-strip` : POSITION_STORAGE_KEY;
  }

  getSavedPosition() {
    try {
      return JSON.parse(localStorage.getItem(this.positionKey));
    } catch {
      return null;
    }
  }

  setSavedPosition(pos) {
    localStorage.setItem(this.positionKey, JSON.stringify(pos));
  }

  /**
   * Every render request goes through here instead of calling
   * render() directly, so a burst of hooks firing in quick succession
   * (auto-skip advancing several turns, several players rolling at
   * once) can't leave a slower render painting stale data over a
   * newer one. See the "wrong combatant stuck highlighted" bug this
   * was written to fix.
   */
  async requestRender() {
    if (this._rendering) {
      this._renderQueued = true;
      return;
    }
    this._rendering = true;
    try {
      await this.render(true);
    } catch (err) {
      // Never fail silently: an unhandled render error used to leave the
      // screen simply empty with nothing to say why.
      console.error("First Strike | failed to render the tracker", err);
      if (!this._renderErrorShown) {
        this._renderErrorShown = true;
        ui.notifications?.error("First Strike couldn't draw the tracker. Details are in the browser console (F12).");
      }
    } finally {
      this._rendering = false;
      if (this._renderQueued) {
        this._renderQueued = false;
        this.requestRender();
      }
    }
  }

  /** @override */
  async _prepareContext(_options) {
    const combat = getActiveCombat();

    /**
     * A combat can get combatants without going through First Strike's
     * own "Begin encounter" button at all - the native right-click
     * token context menu / combat-tracker toggle creates the Combat
     * and Combatants directly, and only `combat.started` stays false
     * until something actually presses play. Gating on `started` here
     * used to mean the tracker stayed on its empty "no active
     * encounter" state the whole time that combat was being set up,
     * even though there was plenty to show. Gating on "does this
     * combat have any combatants" instead means the tracker picks up
     * an encounter however it was created, and shows a "Begin
     * encounter" control inline for whoever still needs to start it.
     */
    if (!combat || combat.turns.length === 0) {
      return {
        hasCombat: false,
        isGM: game.user.isGM,
        round: 0,
        combatants: [],
        collapsed: this.collapsed
      };
    }

    const isGM = game.user.isGM;
    const started = combat.started;

    // Built as a plain loop with a try/catch per combatant, not a
    // single .map() - a freshly-added combatant (added via Foundry's
    // own context menu/tracker, mid-fight) can briefly have
    // incomplete data (actor not yet synced client-side, etc.), and
    // one bad entry throwing used to take the whole _prepareContext
    // down with it, silently leaving the panel stuck on stale data
    // with no error visible to the GM or players. Skipping just that
    // one row keeps everyone else's turn order working.
    let entries = [];
    for (const combatant of combat.turns) {
      try {
        const actor = combatant.actor;
        const disposition = getDisposition(combatant);
        const info = getDisplayInfo(combatant, disposition);
        const hp = getActorHP(actor);
        const hasHpResource = !!hp;
        const visible = canSeeHP(actor, disposition);
        const pct = hp && hp.max > 0 ? Math.round((hp.value / hp.max) * 100) : null;
        const isDefeated = combatant.isDefeated;
        const isHidden = combatant.token?.hidden ?? false;
        const isDelayed = combatant.getFlag(MODULE_ID, "delayed") ?? false;
        const surprised = combatant.getFlag(MODULE_ID, "surprised") ?? false;
        const hasInitiative = combatant.initiative !== null;
        const canRoll = isGM || actor?.isOwner;

        entries.push({
          id: combatant.id,
          name: info.name,
          img: info.img,
          initiative: combatant.initiative,
          hasInitiative,
          canRoll,
          isActive: combatant.id === combat.combatant?.id,
          isUpcoming: false, // filled in below
          isDefeated,
          isHidden,
          isDelayed,
          surprisedActive: surprised && combat.round === 1,
          canToggleSurprise: isGM && combat.round === 1,
          disposition,
          actorKey: actor?.id ?? null,
          hasPlayerOwner: !!combatant.hasPlayerOwner,
          statusIcons: getStatusIcons(actor),
          hasHp: hasHpResource,
          hpVisible: visible && hasHpResource,
          hp: hp ? { value: hp.value, max: hp.max, pct, band: getHPBand(pct) } : null
        });
      } catch (err) {
        console.error("First Strike | failed to build tracker row, skipping this combatant", combatant?.id, combatant?.name, err);
      }
    }

    // Hidden tokens are invisible to everyone except the GM.
    entries = entries.filter((e) => isGM || !e.isHidden);

    // `combat.turns` is supposed to already be sorted by initiative
    // (highest first, unrolled last) - that's Foundry's own job, via
    // `setupTurns()`. In practice that resort doesn't always land
    // before this renders: rolling a combatant's initiative through
    // Foundry's *native* sidebar tracker (its own die icon, not First
    // Strike's roll button) has been seen leaving `combat.turns` in
    // the pre-roll order, so a combatant who just rolled high stays
    // stuck wherever they happened to be added, instead of moving up
    // to where that roll actually puts them. Re-sorting defensively
    // here means the tracker always shows the right order no matter
    // what left `combat.turns` stale, without needing to chase down
    // why Foundry's own resort didn't happen in time. `initiative`
    // ties/nulls keep their relative order (stable sort) rather than
    // shuffling combatants who are tied or still unrolled.
    entries = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const ai = a.entry.initiative;
        const bi = b.entry.initiative;
        if (ai === bi) return a.index - b.index;
        if (ai === null) return 1;
        if (bi === null) return -1;
        return bi - ai;
      })
      .map(({ entry }) => entry);

    // Mark the next 2 combatants who would actually take a turn (i.e.
    // skipping anyone who'd just get auto-skipped anyway) as
    // "upcoming", for a subtle highlight beyond just the active row.
    const activeIndex = entries.findIndex((e) => e.isActive);
    if (activeIndex >= 0) {
      const skippable = (e) => e.isDefeated || e.isHidden || e.isDelayed || e.surprisedActive;
      let marked = 0;
      for (let step = 1; step <= entries.length && marked < 2; step++) {
        const idx = (activeIndex + step) % entries.length;
        if (idx === activeIndex) break;
        if (!skippable(entries[idx])) {
          entries[idx].isUpcoming = true;
          marked++;
        }
      }
    }

    // The list highlights the next two to act, but the strip marks only
    // the very next one - two "Next" tags side by side just read as
    // noise.
    const firstUpcoming = entries.find((e) => e.isUpcoming);
    if (firstUpcoming) firstUpcoming.isNext = true;

    // Delay / End turn sit right in the bar for whoever can act for the
    // active combatant (the owning player, or the GM), so passing a turn
    // never means hunting for a tiny icon on a card.
    const activeEntry = entries.find((e) => e.isActive) ?? null;
    const turnBar =
      started &&
      activeEntry &&
      activeEntry.canRoll &&
      activeEntry.hasInitiative &&
      !activeEntry.isDelayed &&
      !activeEntry.isDefeated
        ? { id: activeEntry.id, label: isGM ? `${activeEntry.name}'s turn` : "Your turn" }
        : null;

    return {
      hasCombat: true,
      started,
      round: combat.round,
      combatantCount: entries.length,
      combatants: this._stackEntries(entries),
      activeName: activeEntry?.name ?? null,
      turnBar,
      isGM,
      collapsed: this.collapsed,
      stripMode: this.isStrip,
      reminderCount: isGM ? getReminders(combat).length : 0,
      followCamera: game.settings.get(MODULE_ID, "followCamera")
    };
  }

  /**
   * Runs of identical enemies that sit next to each other in the order
   * (same actor, hostile, no player owner, all rolled, nobody defeated or
   * delaying) collapse into one portrait with a count, so a pack of
   * goblins doesn't fill the bar. The order itself is never rearranged:
   * only neighbours are merged. A run that contains whoever is acting is
   * always shown open so the current turn is exact, and a click opens any
   * other run.
   */
  _stackEntries(entries) {
    const withRange = (e) => ({ ...e, initMin: e.initiative, initMax: e.initiative });
    if (!game.settings.get(MODULE_ID, "stackEnemies")) return entries.map(withRange);

    const stackable = (e) =>
      e.disposition === "hostile" &&
      !e.hasPlayerOwner &&
      !e.isDefeated &&
      !e.isDelayed &&
      e.hasInitiative &&
      !!e.actorKey;

    const out = [];
    let i = 0;
    while (i < entries.length) {
      const first = entries[i];
      let j = i + 1;
      if (stackable(first)) {
        while (j < entries.length && stackable(entries[j]) && entries[j].actorKey === first.actorKey) j++;
      }
      const run = entries.slice(i, j);
      i = j;

      if (run.length < 2) {
        out.push(withRange(run[0]));
        continue;
      }

      const values = run.map((r) => r.initiative);
      const range = { initMin: Math.min(...values), initMax: Math.max(...values) };
      const holdsActive = run.some((r) => r.isActive);
      const open = holdsActive || this.expandedStacks.has(run[0].id);

      if (open) {
        run.forEach((r, k) => {
          out.push({ ...r, initMin: r.initiative, initMax: r.initiative, ...(k === 0 ? { canCollapse: !holdsActive } : {}) });
        });
        continue;
      }

      out.push({
        ...run[0],
        ...range,
        stackCount: run.length,
        stackIds: run.map((r) => r.id).join(","),
        isNext: run.some((r) => r.isNext),
        isUpcoming: run.some((r) => r.isUpcoming),
        hpVisible: false,
        hasHp: false,
        hp: null,
        canToggleSurprise: false,
        surprisedActive: false
      });
    }
    return out;
  }

  /** @override */
  async _preRender(context, options) {
    await super._preRender(context, options);
    this._preRenderHeight = this.element?.getBoundingClientRect().height ?? null;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    document.body.appendChild(this.element);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.classList.toggle("is-strip", this.isStrip);
    this._applySavedPosition();
    this._clampToViewport();
    this._animateHeightChange();

    this.element.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (event) => this._onControlClick(event));
      // Everything clickable is a real keyboard target too: focusable,
      // announced as a button with the same text as its tooltip, and
      // triggered by Enter or Space.
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
      if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
      if (!el.hasAttribute("aria-label") && el.title) el.setAttribute("aria-label", el.title);
      el.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        this._onControlClick({ currentTarget: el });
      });
    });

    const header = this.element.querySelector(".first-strike-tracker__toggle");
    this._makeHeaderDraggable(header);

    // The header doubles as the collapse button; expose that to
    // keyboards and screen readers (dragging stays pointer-only).
    if (header) {
      header.setAttribute("role", "button");
      header.tabIndex = 0;
      header.setAttribute("aria-expanded", String(!this.collapsed));
      header.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.collapsed = !this.collapsed;
        this.requestRender();
      });
    }

    this.element.querySelectorAll(".fs-row, .fs-card").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (
          event.target.closest(
            "[data-action], [data-mode-toggle], .fs-row__initiative, .fs-card__init, .fs-row__initiative-input"
          )
        ) {
          return;
        }
        if (row.dataset.stack) {
          this.expandedStacks.add(row.dataset.combatantId);
          this.requestRender();
          return;
        }
        this._onRowClick(row.dataset.combatantId);
      });
    });

    // A collapsed group is a keyboard control too.
    this.element.querySelectorAll(".fs-card[data-stack]").forEach((card) => {
      card.tabIndex = 0;
      card.setAttribute("aria-expanded", "false");
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.expandedStacks.add(card.dataset.combatantId);
        this.requestRender();
      });
    });

    this._setupStrip();

    if (game.user.isGM) {
      this._setupCardDragging();
      this.element.querySelectorAll(".fs-card").forEach((card) => {
        card.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          if (card.dataset.stack) return;
          this._openCardMenu(event, card);
        });
      });
      this.element.querySelectorAll(".fs-row__initiative, .fs-card__init").forEach((el) => {
        el.addEventListener("click", (event) => event.stopPropagation());
        el.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          this._startInitiativeEdit(el);
        });
      });
    }
  }

  /**
   * Clears whatever inline position the previous render (or the other
   * view) left behind, so the stylesheet's default - top-center for the
   * strip, bottom-left for the list - applies, then layers the player's
   * own dragged position for the current view on top if there is one.
   */
  _applySavedPosition() {
    const style = this.element.style;
    style.left = "";
    style.top = "";
    style.bottom = "";
    style.transform = "";

    const pos = this.getSavedPosition();
    if (!pos) return;
    style.left = `${pos.left}px`;
    style.top = `${pos.top}px`;
    style.bottom = "auto";
    style.transform = "none";
  }

  /**
   * Strip view only: keeps the active card centered in the scrollable
   * row (a long fight can be wider than the screen), and lets a plain
   * mouse wheel scroll it sideways.
   */
  _setupStrip() {
    const strip = this.element.querySelector(".fs-strip");
    if (!strip) return;

    const overflowing = strip.scrollWidth > strip.clientWidth + 1;
    // The soft edge fade only makes sense when something is cut off.
    strip.classList.toggle("is-overflowing", overflowing);
    // When everything fits, let glows and name labels spill past the
    // strip instead of being clipped by it.
    strip.classList.toggle("is-free", !overflowing);

    const active = strip.querySelector(".fs-card--active");
    if (active && overflowing) {
      strip.scrollLeft = active.offsetLeft - strip.clientWidth / 2 + active.offsetWidth / 2;
    }

    strip.addEventListener(
      "wheel",
      (event) => {
        if (strip.scrollWidth <= strip.clientWidth) return;
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        strip.scrollLeft += event.deltaY;
        event.preventDefault();
      },
      { passive: false }
    );
  }

  /**
   * If a saved (or just-applied) position would put any part of the
   * panel off-screen - e.g. the window got smaller, or the list grew
   * enough to push the bottom edge past the viewport - pull it back
   * on-screen. The list itself also scrolls internally past a max
   * height, so this is a second safety net for the panel as a whole.
   */
  _clampToViewport() {
    const rect = this.element.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;

    left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - rect.width));
    top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - rect.height));

    if (Math.abs(left - rect.left) > 0.5 || Math.abs(top - rect.top) > 0.5) {
      this.element.style.left = `${left}px`;
      this.element.style.top = `${top}px`;
      this.element.style.bottom = "auto";
      this.element.style.transform = "none";
    }
  }

  /**
   * Groups appearing/collapsing and combatants entering/leaving the
   * "upcoming" highlight can change how many rows are on screen from
   * one render to the next, which made the whole panel visibly pop
   * to a different height. This measures the height right before the
   * new content swapped in (captured in _preRender) against the
   * height right after, and animates between the two instead of
   * snapping.
   */
  _animateHeightChange() {
    const before = this._preRenderHeight;
    this._preRenderHeight = null;
    if (before == null) return;

    const after = this.element.getBoundingClientRect().height;
    if (Math.abs(after - before) < 1) return;

    this.element.style.overflow = "hidden";
    this.element.style.height = `${before}px`;
    // Force layout so the browser registers the starting height
    // before we change it, or there's nothing to transition from.
    void this.element.offsetHeight;

    this.element.style.transition = "height 160ms ease";
    this.element.style.height = `${after}px`;

    this.element.addEventListener(
      "transitionend",
      () => {
        this.element.style.transition = "";
        this.element.style.height = "";
        this.element.style.overflow = "";
      },
      { once: true }
    );
  }

  /**
   * Drag-to-move on the header, without stealing the click that
   * toggles collapse. A pointerdown that never moves past a small
   * threshold is treated as a click; anything past that becomes a
   * drag and the click is suppressed.
   */
  _makeHeaderDraggable(header) {
    if (!header) return;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onPointerDown = (event) => {
      if (event.target.closest("[data-mode-toggle]")) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      const rect = this.element.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
    };

    const onPointerMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;

      const rect = this.element.getBoundingClientRect();
      const left = Math.min(Math.max(0, originLeft + dx), Math.max(0, window.innerWidth - rect.width));
      const top = Math.min(Math.max(0, originTop + dy), Math.max(0, window.innerHeight - rect.height));
      this.element.style.left = `${left}px`;
      this.element.style.top = `${top}px`;
      this.element.style.bottom = "auto";
      this.element.style.transform = "none";
    };

    const onPointerUp = () => {
      dragging = false;
      window.removeEventListener("pointermove", onPointerMove);
      if (moved) {
        const rect = this.element.getBoundingClientRect();
        this.setSavedPosition({ left: rect.left, top: rect.top });
      } else {
        this.collapsed = !this.collapsed;
        this.requestRender();
      }
    };

    header.addEventListener("pointerdown", onPointerDown);
  }

  /**
   * Turns the initiative number into a small numeric input in place.
   * Commits on blur/Enter, cancels on Escape. GM only.
   */
  _startInitiativeEdit(labelEl) {
    const row = labelEl.closest(".fs-row, .fs-card");
    const combatantId = row?.dataset.combatantId;
    const originalValue = labelEl.textContent.trim();

    const input = document.createElement("input");
    input.type = "number";
    input.className = "fs-row__initiative-input";
    input.value = originalValue;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const value = Number(input.value);
      if (!Number.isNaN(value)) {
        const combat = getActiveCombat();
        await combat?.combatants.get(combatantId)?.update({ initiative: value });
      }
      this.requestRender();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        committed = true;
        this.requestRender();
      }
    });
    input.addEventListener("blur", commit);
  }

  /**
   * GM: drag a portrait to a new spot in the row and the initiative
   * number is worked out for you - halfway between the two neighbours it
   * lands between (or one above/below at either end). Groups can't be
   * dragged; open one first.
   */
  _setupCardDragging() {
    const strip = this.element.querySelector(".fs-strip");
    if (!strip) return;
    const cards = () => [...strip.querySelectorAll(".fs-card")];
    const clearMarks = () =>
      cards().forEach((c) => c.classList.remove("is-drop-before", "is-drop-after", "is-dragging"));

    let draggedId = null;

    cards().forEach((card) => {
      if (card.dataset.stack) return;
      card.draggable = true;
      card.addEventListener("dragstart", (event) => {
        draggedId = card.dataset.combatantId;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedId);
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragend", () => {
        draggedId = null;
        clearMarks();
      });
    });

    const dropTarget = (clientX) => {
      const others = cards().filter((c) => c.dataset.combatantId !== draggedId);
      for (const card of others) {
        const rect = card.getBoundingClientRect();
        if (clientX < rect.left + rect.width / 2) return { card, before: true, others };
      }
      return { card: others[others.length - 1] ?? null, before: false, others };
    };

    strip.addEventListener("dragover", (event) => {
      if (!draggedId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const { card, before } = dropTarget(event.clientX);
      cards().forEach((c) => c.classList.remove("is-drop-before", "is-drop-after"));
      card?.classList.add(before ? "is-drop-before" : "is-drop-after");
    });

    strip.addEventListener("drop", async (event) => {
      if (!draggedId) return;
      event.preventDefault();
      const id = draggedId;
      const { card, before, others } = dropTarget(event.clientX);
      clearMarks();
      draggedId = null;
      if (!card) return;

      const position = others.indexOf(card) + (before ? 0 : 1);
      const number = (c) => {
        const min = Number(c.dataset.initMin);
        const max = Number(c.dataset.initMax);
        return { min: Number.isFinite(min) && c.dataset.initMin !== "" ? min : null, max: Number.isFinite(max) && c.dataset.initMax !== "" ? max : null };
      };
      // Nearest rolled neighbour on each side (unrolled ones are skipped).
      let above = null;
      for (let k = position - 1; k >= 0 && above === null; k--) above = number(others[k]).min;
      let below = null;
      for (let k = position; k < others.length && below === null; k++) below = number(others[k]).max;

      const value = this._initiativeBetween(above, below);
      if (value === null) return;
      if (value === undefined) {
        ui.notifications?.info(
          "Those two share the same initiative, so there's no number between them. Give one of them a different number first (double-click it)."
        );
        return;
      }
      const combatant = getActiveCombat()?.combatants.get(id);
      if (combatant && combatant.initiative !== value) await combatant.update({ initiative: value });
    });
  }

  /**
   * A number that sorts between `above` (higher, earlier in the row) and
   * `below` (lower, later). Returns null when there's nothing to compare
   * against, and undefined when the neighbours are tied (no number fits).
   */
  _initiativeBetween(above, below) {
    if (above === null && below === null) return null;
    if (above === null) return Math.floor(below) + 1;
    if (below === null) return Math.ceil(above) - 1;
    if (above === below) return undefined;
    if (above < below) return undefined;
    const gap = above - below;
    if (gap >= 2) return Math.floor((above + below) / 2);
    return Math.round(((above + below) / 2) * 100) / 100;
  }

  /**
   * Right-click a portrait (GM only) for the things you otherwise have to
   * dig for: set or reroll initiative, mark defeated, hide, open the
   * sheet, remove from the fight. A small hand-built menu keeps it
   * independent of Foundry's own context-menu API, which changes
   * between versions.
   */
  _openCardMenu(event, card) {
    this._closeCardMenu();
    const combat = getActiveCombat();
    const combatant = combat?.combatants.get(card.dataset.combatantId);
    if (!combatant) return;

    const hidden = combatant.token?.hidden ?? false;
    const hasInitiative = combatant.initiative !== null && combatant.initiative !== undefined;
    const items = [
      {
        icon: "fa-pen",
        label: hasInitiative ? "Edit initiative" : "Set initiative",
        run: () => {
          const target = card.querySelector(".fs-card__init, .fs-card__pending");
          if (target) this._startInitiativeEdit(target);
        }
      },
      {
        icon: "fa-dice-d20",
        label: hasInitiative ? "Reroll initiative" : "Roll initiative",
        run: () => requestRollInitiative(combatant.id)
      },
      {
        icon: "fa-skull",
        label: combatant.isDefeated ? "Mark as alive" : "Mark as defeated",
        run: async () => {
          const defeated = !combatant.isDefeated;
          await combatant.update({ defeated });
          await combatant.actor?.toggleStatusEffect?.(CONFIG.specialStatusEffects.DEFEATED, {
            active: defeated,
            overlay: true
          });
        }
      },
      {
        icon: hidden ? "fa-eye" : "fa-eye-slash",
        label: hidden ? "Reveal to players" : "Hide from players",
        run: () => combatant.token?.update({ hidden: !hidden })
      },
      {
        icon: "fa-user",
        label: "Open sheet",
        run: () => combatant.actor?.sheet?.render(true)
      },
      {
        icon: "fa-xmark",
        label: "Remove from encounter",
        danger: true,
        run: () => combatant.delete()
      }
    ];

    const menu = document.createElement("div");
    menu.className = "first-strike-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", combatant.name);

    const title = document.createElement("div");
    title.className = "first-strike-menu__title";
    title.textContent = combatant.name;
    menu.append(title);

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `first-strike-menu__item${item.danger ? " is-danger" : ""}`;
      button.setAttribute("role", "menuitem");
      const icon = document.createElement("i");
      icon.className = `fa-solid ${item.icon}`;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = item.label;
      button.append(icon, label);
      button.addEventListener("click", async () => {
        this._closeCardMenu();
        try {
          await item.run();
        } catch (err) {
          console.error("First Strike | menu action failed", err);
          ui.notifications?.error("First Strike: that action failed. Details are in the console (F12).");
        }
      });
      menu.append(button);
    }

    document.body.append(menu);
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - rect.height - margin))}px`;
    menu.querySelector("button")?.focus();

    const close = (e) => {
      if (e?.type === "keydown" && e.key !== "Escape") return;
      if (e?.type === "pointerdown" && menu.contains(e.target)) return;
      this._closeCardMenu();
    };
    this._menuCleanup = () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
      menu.remove();
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
  }

  _closeCardMenu() {
    this._menuCleanup?.();
    this._menuCleanup = null;
  }

  /**
   * Click a row/card to find that token on the map. The GM also selects
   * it. A player is only taken to tokens they can already see (their
   * own, or ones in their line of sight) - panning to a token hidden in
   * fog would give away where it is - and selects it only if they own it.
   */
  _onRowClick(combatantId) {
    const combat = getActiveCombat();
    const combatant = combat?.combatants.get(combatantId);
    const token = combatant?.token?.object;
    if (!token) return;

    const isGM = game.user.isGM;
    if (!isGM && !token.visible) return;

    if (isGM || token.isOwner) token.control({ releaseOthers: true });
    canvas.animatePan({ x: token.center.x, y: token.center.y });
  }

  async _onControlClick(event) {
    const action = event.currentTarget.dataset.action;
    const combatantId = event.currentTarget.dataset.combatantId;
    const combat = getActiveCombat();

    if (action === "begin-encounter") {
      await this._beginEncounter();
      return;
    }

    if (action === "roll-initiative") {
      if (combatantId) await requestRollInitiative(combatantId);
      this.requestRender();
      return;
    }

    if (action === "roll-npc") {
      if (combat) await combat.rollNPC();
      this.requestRender();
      return;
    }

    if (action === "toggle-surprised") {
      const combatant = combat?.combatants.get(combatantId);
      if (combatant) {
        const current = combatant.getFlag(MODULE_ID, "surprised") ?? false;
        await combatant.setFlag(MODULE_ID, "surprised", !current);
      }
      return;
    }

    if (action === "delay-turn") {
      await requestDelayTurn(combatantId);
      return;
    }

    if (action === "act-now") {
      await requestActNow(combatantId);
      this.requestRender();
      return;
    }

    if (action === "end-turn") {
      await requestEndTurn(combatantId);
      this.requestRender();
      return;
    }

    if (action === "open-reminders") {
      openRemindersPanel(event.currentTarget, () => getActiveCombat(), () => this.requestRender());
      return;
    }

    if (action === "toggle-follow") {
      const on = !game.settings.get(MODULE_ID, "followCamera");
      await game.settings.set(MODULE_ID, "followCamera", on);
      if (on) panToActive(combat, { force: true });
      return;
    }

    if (action === "collapse-stack") {
      this.expandedStacks.delete(combatantId);
      this.requestRender();
      return;
    }

    if (!combat) return;

    switch (action) {
      case "next-turn":
        await combat.nextTurn();
        break;
      case "previous-turn":
        await combat.previousTurn();
        break;
      case "next-round":
        await combat.nextRound();
        break;
      case "previous-round":
        await combat.previousRound();
        break;
      case "end-combat": {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "End encounter" },
          content: "<p>End this encounter for everyone?</p>"
        });
        if (confirmed) await combat.endCombat();
        break;
      }
    }
  }

  /**
   * GM presses "Begin encounter": adds whatever tokens are currently
   * selected on the canvas to the active combat (creating one if
   * there isn't one yet), then starts it. Initiative is deliberately
   * NOT auto-rolled here - each combatant gets a roll button in the
   * tracker so players roll their own dice, and there's a separate
   * "roll all NPCs" shortcut for the GM's side of the table.
   *
   * This button also doubles as "start the encounter I already set up
   * some other way" - a combat created through Foundry's own
   * right-click token menu / combat-tracker toggle already has
   * combatants by the time this runs, so no tokens need to be
   * selected for that case; this just needs to flip `started`. If the
   * GM *also* has tokens selected, those get folded into the same
   * combat first, same as before.
   */
  async _beginEncounter() {
    const tokens = canvas.tokens?.controlled ?? [];
    let combat = getActiveCombat();

    if (!combat) {
      if (!tokens.length) {
        ui.notifications.warn("Select at least one token before beginning the encounter.");
        return;
      }
      combat = await Combat.create({ scene: canvas.scene.id });
      await combat.activate();
    }

    if (tokens.length) {
      const existingTokenIds = new Set(combat.combatants.map((c) => c.tokenId));
      const newTokens = tokens.filter((t) => !existingTokenIds.has(t.id));
      if (newTokens.length) {
        await combat.createEmbeddedDocuments(
          "Combatant",
          newTokens.map((t) => ({ tokenId: t.id, sceneId: canvas.scene.id }))
        );
      }
    }

    if (!combat.turns.length) {
      ui.notifications.warn("Add at least one combatant before beginning the encounter.");
      return;
    }

    if (!combat.started) await combat.startCombat();
  }
}
