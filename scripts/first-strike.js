import { FirstStrikeTracker, getActorHP } from "./tracker-app.js";
import { MODULE_ID, getActiveCombat } from "./constants.js";
import { ensureSocket, requestRollInitiative } from "./gm-actions.js";
import { scheduleTurnAlert } from "./turn-alerts.js";

let tracker;
let autoSkipping = false;

/**
 * Tracks, per combat, who was actually active a moment ago. Needed to
 * correct the turn pointer whenever something re-sorts `combat.turns`
 * mid-fight - see `resyncActiveCombatant` below for why.
 */
const lastActiveCombatantId = new Map();

/** Who sat at the top of the turn order (first one who really acts) at the last change. */
const lastTopCombatantId = new Map();

/**
 * Tracks, per combat, the {round, turn} pair from the previous
 * "updateCombat" event, purely so the next one can tell whether the
 * table just moved forward or backward - see `autoSkipCombatants` for
 * why that direction matters.
 */
const lastTurnState = new Map();

/**
 * Compares two {round, turn} snapshots to say which way the table
 * moved. A round change dominates (previousRound/nextRound can leave
 * `turn` pointing anywhere in the new round, so comparing round first
 * is what actually reflects intent); otherwise it's a plain turn
 * comparison within the same round.
 */
function getTurnDirection(previous, current) {
  if (current.round !== previous.round) {
    return current.round > previous.round ? "forward" : "backward";
  }
  if (current.turn !== previous.turn) {
    return current.turn > previous.turn ? "forward" : "backward";
  }
  return "forward";
}

Hooks.once("init", () => {
  console.log("First Strike | Initializing");

  game.settings.register(MODULE_ID, "turnAlerts", {
    name: "Turn alerts",
    hint: "A banner and a soft glow on your screen when it's your turn, plus a smaller banner when you're up next.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      mine: "Only my turns (and when I'm up next)",
      all: "Every turn",
      off: "Off"
    },
    default: "mine"
  });

  game.settings.register(MODULE_ID, "autoRollNPCs", {
    name: "Auto-roll enemy initiative",
    hint: "The moment a creature with no player owner joins an encounter, its initiative is rolled for you (whispered to GMs). Players still roll their own. Turn this off to roll enemies yourself with the dice button.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "maskEnemyNames", {
    name: "Hide enemy names from players",
    hint: "Players see hostile creatures they don't own as \"Unknown creature\" with a blank portrait, in the tracker and in turn banners. The GM always sees the real names.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => renderTracker()
  });

  game.keybindings.register(MODULE_ID, "nextTurn", {
    name: "First Strike: Next Turn",
    editable: [{ key: "BracketRight" }],
    restricted: true,
    onDown: () => {
      getActiveCombat()?.nextTurn();
    }
  });

  game.keybindings.register(MODULE_ID, "previousTurn", {
    name: "First Strike: Previous Turn",
    editable: [{ key: "BracketLeft" }],
    restricted: true,
    onDown: () => {
      getActiveCombat()?.previousTurn();
    }
  });
});

Hooks.once("ready", async () => {
  try {
    await loadTemplates({
      "first-strike-card": "modules/first-strike/templates/card.hbs"
    });
  } catch (err) {
    console.error("First Strike | failed to load row template", err);
  }

  try {
    // Force this here too, on every client including the GM's - the
    // socketlib.ready hook is where this is *supposed* to happen, but
    // it can fire before our listener for it even attaches. Foundry's
    // own "ready" hook fires late enough that socketlib is reliably
    // available by this point, and ensureSocket() is a no-op if
    // already registered.
    ensureSocket();

    if (game.user.isGM && typeof socketlib === "undefined") {
      ui.notifications.error(
        "First Strike requires the socketlib module. Players won't be able to roll their own initiative or act on delayed turns until it's installed and enabled.",
        { permanent: true }
      );
    }
  } catch (err) {
    // Whatever goes wrong with socketlib setup, it must never be able
    // to stop the tracker itself from being created below.
    console.error("First Strike | socketlib setup failed", err);
  }

  tracker = new FirstStrikeTracker();

  // Public API: other modules (Triad's "Roll Initiative" button, for one)
  // can reuse the same GM relay for player initiative rolls.
  game.modules.get(MODULE_ID).api = { tracker, requestRollInitiative };

  // Seed the bookkeeping for a fight that was already running when the
  // page loaded, so the first edit after a refresh behaves correctly.
  try {
    for (const combat of Array.from(game.combats?.values?.() ?? [])) {
      lastActiveCombatantId.set(combat.id, combat.combatant?.id ?? null);
      rememberTopCombatant(combat);
    }
  } catch (err) {
    console.error("First Strike | couldn't read existing combats", err);
  }

  renderTracker();
});

/* -------------------------------------------- */
/* Rendering                                     */
/* -------------------------------------------- */

function renderTracker() {
  tracker?.requestRender();
}

Hooks.on("updateCombat", async (combat, changed, _options, _userId) => {
  renderTracker();
  // Every client, GM or not: the banner is a local, read-only cue. It
  // waits a beat before showing so a chain of auto-skips (defeated or
  // delaying combatants) settles on who actually acts, instead of
  // flashing a banner for each creature passed over.
  if ("turn" in changed || "round" in changed) scheduleTurnAlert(combat);
  // Record this on every client, not just the GM's - it's pure local
  // bookkeeping (no write), and it needs to stay current regardless of
  // who's logged in so the GM's client always has a true "who was
  // active a moment ago" to compare against in resyncActiveCombatant.
  lastActiveCombatantId.set(combat.id, combat.combatant?.id ?? null);
  rememberTopCombatant(combat);

  if (!game.user.isGM) return;
  if ("turn" in changed || "round" in changed) {
    const previous = lastTurnState.get(combat.id) ?? { round: combat.round, turn: combat.turn };
    const current = { round: combat.round, turn: combat.turn };
    lastTurnState.set(combat.id, current);
    const direction = getTurnDirection(previous, current);
    await autoSkipCombatants(combat, direction);
  } else {
    lastTurnState.set(combat.id, { round: combat.round, turn: combat.turn });
  }
  if ("round" in changed && combat.round > 1) {
    clearSurprisedFlags(combat);
  }
});

Hooks.on("createCombat", renderTracker);
Hooks.on("deleteCombat", (combat) => {
  renderTracker();
  lastActiveCombatantId.delete(combat.id);
  lastTurnState.delete(combat.id);
  // Hook point for the loot module: loot should only be generated once
  // the encounter is actually over, not mid-fight.
  Hooks.callAll("firstStrike.combatEnded", combat);
});

/**
 * Auto-roll for enemies: combatants without a player owner that join an
 * encounter are queued, then rolled together a beat later (adding a whole
 * group of tokens fires one create event per token). Runs only on the
 * active GM's client so a table with two GMs doesn't roll everything
 * twice, and only touches combatants that still have no initiative.
 */
const pendingAutoRolls = new Map();
let autoRollTimer = null;

function isActiveGM() {
  if (!game.user.isGM) return false;
  const active = game.users.activeGM;
  return !active || active.isSelf;
}

function queueAutoRoll(combatant) {
  if (!game.settings.get(MODULE_ID, "autoRollNPCs") || !isActiveGM()) return;
  if (combatant.hasPlayerOwner || combatant.initiative != null) return;
  const combat = combatant.combat;
  if (!combat) return;

  if (!pendingAutoRolls.has(combat)) pendingAutoRolls.set(combat, new Set());
  pendingAutoRolls.get(combat).add(combatant.id);

  clearTimeout(autoRollTimer);
  autoRollTimer = setTimeout(flushAutoRolls, 150);
}

async function flushAutoRolls() {
  const batches = [...pendingAutoRolls];
  pendingAutoRolls.clear();
  for (const [combat, ids] of batches) {
    const todo = [...ids].filter((id) => combat.combatants.get(id)?.initiative == null);
    if (!todo.length) continue;
    try {
      // Whispered so the table doesn't see the monsters' numbers in
      // chat. V14 renamed the option; older versions use rollMode.
      const opts = { skipDialog: true };
      if (game.release.generation >= 14) opts.messageMode = "gm";
      else opts.messageOptions = { rollMode: "gmroll" };
      await combat.rollInitiative(todo, opts);
    } catch (err) {
      console.error("First Strike | auto-roll of enemy initiative failed", err);
    }
  }
}

Hooks.on("createCombatant", async (combatant) => {
  renderTracker();
  queueAutoRoll(combatant);
  // A monster added mid-fight (via Foundry's own right-click menu or
  // its native combat tracker, not just First Strike's own button)
  // re-sorts the turn order the moment its initiative is set. Without
  // this, that re-sort can silently hand the "active" turn to the
  // wrong combatant - see resyncActiveCombatant for the full story.
  if (game.user.isGM) {
    const moved = await followNewTopCombatant(combatant.combat);
    if (!moved) await resyncActiveCombatant(combatant.combat);
  }
  rememberTopCombatant(combatant.combat);
});
Hooks.on("deleteCombatant", async (combatant) => {
  renderTracker();
  if (game.user.isGM) await resyncActiveCombatant(combatant.combat);
  rememberTopCombatant(combatant.combat);
});
Hooks.on("updateCombatant", async (combatant, changed, _options, _userId) => {
  renderTracker();
  if (!game.user.isGM) return;
  // A reveal/hide toggle, defeated state, delay, or surprise flag can
  // change who should currently be skipped, same as initiative changes.
  if ("initiative" in changed || "flags" in changed || "defeated" in changed) {
    await autoSkipCombatants(combatant.combat);
  }
  if ("initiative" in changed) {
    // Before anyone has acted, the turn belongs to whoever is on top of
    // the order - so changing a number that reshuffles the top hands the
    // turn to the new first, instead of leaving it on the old one.
    const moved = await followNewTopCombatant(combatant.combat);
    if (!moved) {
      await resnapOpeningTurn(combatant.combat);
      await resyncActiveCombatant(combatant.combat);
    }
  }
  rememberTopCombatant(combatant.combat);
});

Hooks.on("updateActor", (actor, changed, _options, _userId) => {
  const hpChanged = foundry.utils.hasProperty(changed, "system.attributes.hp.value");
  if (hpChanged) {
    renderTracker();
    if (game.user.isGM) syncDefeatedState(actor);
  }
});

Hooks.on("updateToken", (tokenDoc, changed) => {
  if ("texture" in changed || "name" in changed) renderTracker();
  if ("hidden" in changed) {
    renderTracker();
    if (game.user.isGM && tokenDoc.combatant) autoSkipCombatants(tokenDoc.combatant.combat);
  }
});

Hooks.on("createActiveEffect", renderTracker);
Hooks.on("deleteActiveEffect", renderTracker);

/** Same notion of "gets skipped" as the auto-skip. */
function isSkippableNow(combatant, combat) {
  const hidden = combatant.token?.hidden ?? false;
  const delayed = combatant.getFlag(MODULE_ID, "delayed") ?? false;
  const surprised = (combatant.getFlag(MODULE_ID, "surprised") ?? false) && combat.round === 1;
  return combatant.isDefeated || hidden || delayed || surprised;
}

function firstActingCombatant(combat) {
  return combat.turns.find((c) => !isSkippableNow(c, combat)) ?? null;
}

function rememberTopCombatant(combat) {
  if (!combat) return;
  lastTopCombatantId.set(combat.id, firstActingCombatant(combat)?.id ?? null);
}

/**
 * In round 1, while the pointer is still on the combatant who was on top
 * of the order (so nobody has taken a turn yet), a changed initiative
 * that reshuffles the top must move the pointer to the new first one.
 * Once anybody has acted this never fires, so editing a number mid-round
 * keeps the turn with whoever is acting (resyncActiveCombatant). Returns
 * true when it moved the turn.
 */
async function followNewTopCombatant(combat) {
  if (!combat || !combat.started || combat.round !== 1) return false;

  const previousTop = lastTopCombatantId.get(combat.id);
  const activeBefore = lastActiveCombatantId.get(combat.id);
  if (!previousTop || activeBefore !== previousTop) return false;

  const newTop = firstActingCombatant(combat);
  if (!newTop || newTop.id === previousTop) return false;

  const index = combat.turns.findIndex((c) => c.id === newTop.id);
  if (index < 0 || index === combat.turn) return false;

  await combat.update({ turn: index });
  return true;
}

/**
 * Begin Encounter no longer auto-rolls, so it's normal for rolls to
 * trickle in one at a time while combat has already started. Each
 * roll re-sorts `combat.turns`, and the turn pointer should keep
 * tracking whoever actually has the highest initiative right now -
 * for as long as at least one combatant still hasn't rolled.
 *
 * This used to track "has real play started" with an explicit flag
 * set from half a dozen different places (button clicks, keybinds,
 * delay, act-now, auto-skip). That was fragile - it only takes one
 * spot to miss, or one accidental click during the roll-in window, to
 * permanently disable the correction and leave the pointer stuck on
 * whoever happened to be highest at that moment (which is exactly
 * what happened: a stray click froze it on someone who then went on
 * to roll the *lowest* number of the table).
 *
 * Gating on "is anyone still unrolled" instead needs no flag and no
 * list of call sites to keep in sync: as long as someone hasn't
 * rolled, correcting the pointer is always safe and always wanted.
 * The moment the last person rolls, this fires one final correction
 * and then naturally never has a reason to touch it again.
 */
async function resnapOpeningTurn(combat) {
  if (!combat || !combat.started || combat.round !== 1) return;
  // Only correct while the opening roll-in is still happening - once
  // everyone has a number, this stops touching the pointer entirely,
  // so a later manual initiative edit (a supported GM action) doesn't
  // get silently overridden.
  if (!combat.turns.some((c) => c.initiative === null)) return;

  const rolled = combat.turns.filter((c) => c.initiative !== null);
  if (!rolled.length) return;

  const highest = rolled.reduce((a, b) => (b.initiative > a.initiative ? b : a));
  const actualIndex = combat.turns.findIndex((c) => c.id === highest.id);
  if (actualIndex >= 0 && actualIndex !== combat.turn) {
    await combat.update({ turn: actualIndex });
  }
}

/**
 * Mid-fight - any round, not just the opening roll-in - adding a
 * combatant, rolling or editing someone's initiative, or removing a
 * combatant all make Foundry re-sort `combat.turns`. Foundry's own
 * `combat.turn` is just a numeric index into that array; it is NOT
 * tied to a combatant's identity. So when a new entry lands above the
 * active row (a reinforcement monster with a high roll, say), the
 * index that used to point at "whoever's turn it is" can end up
 * pointing at someone else entirely - with no error, no prompt, just
 * the wrong creature quietly marked active. The fix isn't to roll
 * back the sort (the new order is correct) - it's to look up where
 * the combatant who WAS active a moment ago ended up, and point the
 * turn index back at them.
 *
 * `lastActiveCombatantId` is what "a moment ago" means here - it's
 * updated on every `updateCombat` event, including the ones this very
 * function triggers, so it keeps tracking correctly through a chain
 * of changes. If the previously-active combatant was the one just
 * deleted, there's nothing to restore to - Foundry's own clamped
 * index is left as whatever it already resolved to.
 */
async function resyncActiveCombatant(combat) {
  if (!combat || !combat.started) return;

  const expectedId = lastActiveCombatantId.get(combat.id);
  if (!expectedId) return;

  const currentId = combat.combatant?.id ?? null;
  if (currentId === expectedId) return;

  const expectedIndex = combat.turns.findIndex((c) => c.id === expectedId);
  if (expectedIndex < 0) return;

  await combat.update({ turn: expectedIndex });
}

/* -------------------------------------------- */
/* Defeated-state tracking                       */
/* -------------------------------------------- */

/**
 * Keeps the combatant's native "defeated" state - and the actual dead
 * status effect on the token itself - in sync with current HP.
 *
 * This uses Foundry's own mechanism (Combatant#defeated field +
 * Actor#toggleStatusEffect with CONFIG.specialStatusEffects.DEFEATED)
 * rather than a module-specific flag, so:
 *  - the same skull/X overlay shows on the token on the canvas, which
 *    is what "put a dead icon on the token" actually means;
 *  - any other module or macro that already knows how to read
 *    Foundry's standard defeated state (combatant.isDefeated,
 *    actor.statuses) sees this correctly, with nothing First Strike-
 *    specific required.
 *
 * Matching is done on actor UUID, not actor id. For unlinked tokens
 * (three copies of the same "Orc" dragged onto the scene), each
 * token's synthetic actor shares the same base actor id but has a
 * distinct, token-scoped uuid. Matching on id would treat all three
 * orcs as one and defeat/revive them together; uuid keeps each
 * token's HP independent.
 *
 * Note for coordinating with the Plunder module: this can toggle on
 * and off multiple times during a single encounter (defeated, healed,
 * defeated again), since it's purely HP-driven. Plunder should key
 * loot generation off `deleteCombat` / the `firstStrike.combatEnded`
 * hook - not off this status effect appearing - or it risks trying to
 * generate loot mid-fight.
 */
async function syncDefeatedState(actor) {
  const combat = getActiveCombat();
  if (!combat) return;

  const hp = getActorHP(actor);
  if (!hp) return;

  const isDefeated = hp.max > 0 && hp.value <= 0;
  const linkedCombatants = combat.combatants.filter((c) => c.actor?.uuid === actor.uuid);

  for (const combatant of linkedCombatants) {
    if (combatant.isDefeated === isDefeated) continue;
    await combatant.update({ defeated: isDefeated });
    await actor.toggleStatusEffect(CONFIG.specialStatusEffects.DEFEATED, {
      active: isDefeated,
      overlay: true
    });
  }
}

/**
 * The "surprised" mark only matters for round 1. Once round 2 starts
 * there's no more mechanical effect, so clear the flags rather than
 * leave stale data sitting on the combatants.
 */
async function clearSurprisedFlags(combat) {
  for (const combatant of combat.combatants) {
    if (combatant.getFlag(MODULE_ID, "surprised")) {
      await combatant.unsetFlag(MODULE_ID, "surprised");
    }
  }
}

/**
 * If the combatant whose turn it currently is has been flagged as
 * defeated, is delaying, is surprised (round 1 only), or its token is
 * currently hidden, silently advance past them. Guards against
 * re-entrancy and against looping forever when everyone is skippable.
 *
 * `direction` matters: this used to always call `combat.nextTurn()`,
 * which was fine for the normal case (play moving forward lands on a
 * defeated enemy, skip ahead to the next living one) but actively
 * broke the GM's own "previous turn" button - clicking back a turn
 * onto a defeated combatant would immediately auto-skip *forward*
 * again, right back past where the GM was trying to go, making
 * "previous turn" look like it did nothing (or worse, bounced). The
 * fix is simply to keep skipping in whichever direction the table was
 * already moving - forward for next-turn/next-round, backward for
 * previous-turn/previous-round - so stepping back through a dead
 * enemy lands you on the next living one before it, not back where
 * you started.
 */
async function autoSkipCombatants(combat, direction = "forward") {
  if (!combat || !combat.started || autoSkipping) return;

  const shouldSkip = (combatant) => {
    const isHidden = combatant.token?.hidden ?? false;
    const isDelayed = combatant.getFlag(MODULE_ID, "delayed") ?? false;
    const isSurprised = (combatant.getFlag(MODULE_ID, "surprised") ?? false) && combat.round === 1;
    return combatant.isDefeated || isHidden || isDelayed || isSurprised;
  };

  autoSkipping = true;
  try {
    let iterations = 0;
    const maxIterations = combat.turns.length + 1;

    while (iterations < maxIterations) {
      const current = combat.combatant;
      if (!current) break;
      if (!shouldSkip(current)) break;

      const everyoneSkippable = combat.turns.every(shouldSkip);
      if (everyoneSkippable) break;

      if (direction === "backward") {
        await combat.previousTurn();
      } else {
        await combat.nextTurn();
      }
      iterations++;
    }
  } finally {
    autoSkipping = false;
  }
}
