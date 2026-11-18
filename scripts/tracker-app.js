import { MODULE_ID } from "./constants.js";
import { requestRollInitiative, requestDelayTurn, requestActNow, requestEndTurn } from "./gm-actions.js";

export { MODULE_ID };
const COLLAPSE_STORAGE_KEY = "first-strike-collapsed";
const COMPACT_STORAGE_KEY = "first-strike-compact";
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

export class FirstStrikeTracker extends HandlebarsApplicationMixin(ApplicationV2) {
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

  /** True while the tracker lives inside Triad's Initiative tab. */
  get isDocked() {
    return !!this._dockHost;
  }

  /**
   * Re-parents the tracker into an external container (Triad's tab).
   * Floating-only behaviour - saved position, viewport clamping, header
   * dragging and collapse - is switched off while docked.
   */
  dock(host) {
    if (!host || this._dockHost === host) return;
    this._dockHost = host;
    if (this.element) {
      host.appendChild(this.element);
      this.element.classList.add("is-docked");
      this.element.style.left = "";
      this.element.style.top = "";
      this.element.style.bottom = "";
    }
    this.requestRender();
  }

  get collapsed() {
    if (this.isDocked) return false;
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true";
  }

  set collapsed(value) {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? "true" : "false");
  }

  get compactMode() {
    return localStorage.getItem(COMPACT_STORAGE_KEY) === "true";
  }

  set compactMode(value) {
    localStorage.setItem(COMPACT_STORAGE_KEY, value ? "true" : "false");
  }

  getSavedPosition() {
    try {
      return JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  setSavedPosition(pos) {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(pos));
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
    const combat = game.combats?.active;

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
          name: combatant.name,
          img: actor?.img || combatant.img || "icons/svg/mystery-man.svg",
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

    const activeEntry = entries.find((e) => e.isActive) ?? null;
    const nextEntry = entries.find((e) => e.isUpcoming) ?? null;

    return {
      hasCombat: true,
      started,
      round: combat.round,
      combatantCount: entries.length,
      combatants: entries,
      activeEntry,
      nextEntry,
      isGM,
      collapsed: this.collapsed,
      compactMode: this.compactMode
    };
  }

  /** @override */
  async _preRender(context, options) {
    await super._preRender(context, options);
    this._preRenderHeight = this.element?.getBoundingClientRect().height ?? null;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    (this._dockHost ?? document.body).appendChild(this.element);
    this.element.classList.toggle("is-docked", this.isDocked);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    if (!this.isDocked) {
      this._applySavedPosition();
      this._clampToViewport();
    }
    this._animateHeightChange();

    this.element.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (event) => this._onControlClick(event));
    });

    const header = this.element.querySelector(".first-strike-tracker__toggle");
    if (!this.isDocked) this._makeHeaderDraggable(header);

    const modeToggle = this.element.querySelector("[data-mode-toggle]");
    modeToggle?.addEventListener("pointerdown", (event) => event.stopPropagation());
    modeToggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.compactMode = !this.compactMode;
      this.requestRender();
    });

    this.element.querySelectorAll(".fs-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("[data-action], [data-mode-toggle], .fs-row__initiative, .fs-row__initiative-input")) return;
        this._onRowClick(row.dataset.combatantId);
      });
    });

    if (game.user.isGM) {
      this.element.querySelectorAll(".fs-row__initiative").forEach((el) => {
        el.addEventListener("click", (event) => event.stopPropagation());
        el.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          this._startInitiativeEdit(el);
        });
      });
    }
  }

  _applySavedPosition() {
    const pos = this.getSavedPosition();
    if (!pos) return;
    this.element.style.left = `${pos.left}px`;
    this.element.style.top = `${pos.top}px`;
    this.element.style.bottom = "auto";
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

    if (left !== rect.left || top !== rect.top) {
      this.element.style.left = `${left}px`;
      this.element.style.top = `${top}px`;
      this.element.style.bottom = "auto";
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
    const row = labelEl.closest(".fs-row");
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
        const combat = game.combats?.active;
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
   * GM convenience: click a row to select and pan to that token on
   * the canvas.
   */
  _onRowClick(combatantId) {
    if (!game.user.isGM) return;
    const combat = game.combats?.active;
    const combatant = combat?.combatants.get(combatantId);
    const token = combatant?.token?.object;
    if (!token) return;

    token.control({ releaseOthers: true });
    canvas.animatePan({ x: token.center.x, y: token.center.y });
  }

  async _onControlClick(event) {
    const action = event.currentTarget.dataset.action;
    const combatantId = event.currentTarget.dataset.combatantId;
    const combat = game.combats?.active;

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
    let combat = game.combats?.active;

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
