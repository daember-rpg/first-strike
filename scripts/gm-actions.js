import { MODULE_ID, getActiveCombat } from "./constants.js";

let socket;

Hooks.once("socketlib.ready", () => {
  ensureSocket();
});

/**
 * Registers with socketlib on first use rather than only inside the
 * "socketlib.ready" hook. Relying solely on that hook firing after our
 * listener attaches assumes a load-order that isn't guaranteed - if
 * socketlib finishes initializing before our script runs, the hook
 * fires before we're listening and `socket` is silently left
 * undefined for the rest of the session. Calling this again at the
 * point of use self-heals regardless of when the hook actually fired.
 */
export function ensureSocket() {
  if (socket) return socket;
  if (typeof socketlib === "undefined") return null;
  try {
    socket = socketlib.registerModule(MODULE_ID);
    socket.register("rollInitiative", gmRollInitiative);
    socket.register("setInitiative", gmSetInitiative);
    socket.register("delayTurn", gmDelayTurn);
    socket.register("actNow", gmActNow);
    socket.register("endTurn", gmEndTurn);
    return socket;
  } catch (err) {
    // A registration hiccup here must never be able to take down the
    // rest of the module - calling this unguarded from the ready hook
    // once made the entire tracker fail to load, since the thrown
    // error skipped every line after it, including creating the
    // tracker itself.
    console.error("First Strike | socketlib registration failed, will retry on next use", err);
    socket = null;
    return null;
  }
}

function warnNoSocket() {
  ui.notifications.error(
    "First Strike needs the socketlib module active (and a GM online) for players to act on their own turn."
  );
}

/**
 * WHY THIS MODULE RELAYS THROUGH THE GM AT ALL:
 *
 * Foundry's own Combatant permission model is supposed to let a player
 * write to a Combatant document for a character they own (Combatant's
 * ownership check is "special" - it doesn't just follow the parent
 * Combat document's permission, per Foundry's own docs). That's also
 * why other combat-tracker modules (e.g. Carousel Combat Tracker) can
 * call `combat.rollInitiative()` directly from a player's client with
 * no relay at all, and it normally just works.
 *
 * In this specific world, that direct write is being rejected by the
 * server for players even on characters they own (confirmed: the roll
 * posts to chat fine - chat message creation doesn't need this
 * permission - but the initiative value never actually saves without
 * going through a GM client). That points to an actor/token ownership
 * configuration issue for those characters (see Configure Ownership on
 * the Actor, and the Token's own ownership if it's unlinked) rather
 * than anything this module's code controls. Fixing that ownership
 * would let direct writes work too - but relaying through the GM
 * works regardless of how that's configured, so it's the safe default
 * here rather than something to rely on being fixed.
 */
/**
 * Matches the permission notice broadly rather than one exact string.
 * This has already had to be widened once (originally only matched
 * "lacks permission to update Combatant"), because Foundry/pf2e don't
 * always phrase it the same way - sometimes it names "Combat" instead
 * of "Combatant", sometimes it comes through as a warning rather than
 * an error. Matching on "lacks permission" generally, and patching
 * both error and warn, is safe here because the patch only exists for
 * the duration of this one roll call (see the try/finally below) - it
 * can never accidentally swallow an unrelated notice that happens to
 * show up any other time.
 */
function isExpectedPermissionNotice(message) {
  return typeof message === "string" && /lacks permission/i.test(message);
}

async function withSuppressedPermissionNotice(fn) {
  const originalError = ui.notifications.error.bind(ui.notifications);
  const originalWarn = ui.notifications.warn.bind(ui.notifications);

  ui.notifications.error = (message, options) => {
    if (isExpectedPermissionNotice(message)) {
      console.debug("First Strike | suppressed expected permission notice from pf2e's internal roll step:", message);
      return;
    }
    return originalError(message, options);
  };
  ui.notifications.warn = (message, options) => {
    if (isExpectedPermissionNotice(message)) {
      console.debug("First Strike | suppressed expected permission notice from pf2e's internal roll step:", message);
      return;
    }
    return originalWarn(message, options);
  };

  try {
    return await fn();
  } finally {
    ui.notifications.error = originalError;
    ui.notifications.warn = originalWarn;
  }
}

/* -------------------------------------------- */
/* Public entry points - called from the UI      */
/* -------------------------------------------- */

/**
 * For rolling specifically, the roll and its dialog/chat message still
 * happen locally on the player's own client via pf2e's
 * `actor.initiative.roll()` - the same call `EncounterPF2e.rollInitiative`
 * makes per-combatant internally - so the dialog and chat card show up
 * in the right place, correctly attributed. Only the resulting number
 * is then relayed to the GM to persist, which is the one part that
 * actually needs elevated permission in this world.
 */
export async function requestRollInitiative(combatantId) {
  const combat = getActiveCombat();
  if (!combat) return;
  const userId = game.user.id;

  if (game.user.isGM) return gmRollInitiative(combat.id, combatantId, userId);

  const combatant = combat.combatants.get(combatantId);
  const initiativeStat = combatant?.actor?.initiative;

  if (initiativeStat?.roll) {
    try {
      const result = await withSuppressedPermissionNotice(() => initiativeStat.roll({}));
      const total = result?.total ?? result?.roll?.total;
      if (typeof total === "number") {
        return requestSetInitiative(combatantId, total);
      }
      console.warn("First Strike | initiative roll didn't return a usable total, falling back to full GM relay", result);
    } catch (err) {
      console.warn("First Strike | local initiative roll failed, falling back to full GM relay", err);
    }
  }

  // Fallback for systems without a comparable per-actor roll API (or
  // if the above didn't pan out) - the roll happens on the GM's
  // screen, but it still works and still persists correctly.
  const s = ensureSocket();
  if (!s) return warnNoSocket();
  return s.executeAsGM("rollInitiative", combat.id, combatantId, userId);
}

async function requestSetInitiative(combatantId, value) {
  const combat = getActiveCombat();
  if (!combat) return;
  if (game.user.isGM) return gmSetInitiative(combat.id, combatantId, value);
  const s = ensureSocket();
  if (!s) return warnNoSocket();
  return s.executeAsGM("setInitiative", combat.id, combatantId, value);
}

export async function requestDelayTurn(combatantId) {
  const combat = getActiveCombat();
  if (!combat) return;
  if (game.user.isGM) return gmDelayTurn(combat.id, combatantId);
  const s = ensureSocket();
  if (!s) return warnNoSocket();
  return s.executeAsGM("delayTurn", combat.id, combatantId);
}

export async function requestActNow(combatantId) {
  const combat = getActiveCombat();
  if (!combat) return;
  if (game.user.isGM) return gmActNow(combat.id, combatantId);
  const s = ensureSocket();
  if (!s) return warnNoSocket();
  return s.executeAsGM("actNow", combat.id, combatantId);
}

/**
 * "End turn" / "pass turn" - the player whose turn it is advances the
 * table to the next combatant themselves, instead of waiting on the
 * GM to click next. `combat.nextTurn()` ends in a `combat.update()`
 * same as initiative, so it hits the same permission wall for players
 * in this world and needs the same GM relay.
 */
export async function requestEndTurn(combatantId) {
  const combat = getActiveCombat();
  if (!combat) return;
  if (game.user.isGM) return gmEndTurn(combat.id, combatantId);
  const s = ensureSocket();
  if (!s) return warnNoSocket();
  return s.executeAsGM("endTurn", combat.id, combatantId);
}

/* -------------------------------------------- */
/* GM-side implementations                       */
/* -------------------------------------------- */

/**
 * Runs on whichever GM client picks up the request. Without passing
 * `messageOptions.user`, the resulting chat card would be authored by
 * that GM (since it's their browser actually creating the
 * ChatMessage document), even though the roll is the player's. This
 * makes it show up as the requesting player's roll instead.
 */
async function gmRollInitiative(combatId, combatantId, requestingUserId) {
  const combat = game.combats?.get(combatId);
  if (!combat) return;
  await combat.rollInitiative([combatantId], {
    messageOptions: { user: requestingUserId }
  });
}

async function gmSetInitiative(combatId, combatantId, value) {
  const combat = game.combats?.get(combatId);
  const combatant = combat?.combatants.get(combatantId);
  if (combatant) await combatant.update({ initiative: value });
}

async function gmDelayTurn(combatId, combatantId) {
  const combat = game.combats?.get(combatId);
  if (!combat) return;
  const combatant = combat.combatants.get(combatantId);
  if (combatant) await combatant.setFlag(MODULE_ID, "delayed", true);
  await combat.nextTurn();
}

/**
 * A delayed combatant re-enters the order right after whoever is
 * currently acting, and the turn jumps to them immediately - "I held
 * my action, now I'm using it."
 *
 * Initiative change and flag removal are bundled into a single
 * document update on purpose - doing them as two separate awaited
 * updates previously left a brief window where a hook fired by the
 * first update could still see the old "delayed" flag and misfire
 * auto-skip against this combatant before the second update cleared it.
 */
async function gmActNow(combatId, combatantId) {
  const combat = game.combats?.get(combatId);
  if (!combat) return;
  const combatant = combat.combatants.get(combatantId);
  if (!combatant) return;

  const current = combat.combatant;
  const updateData = { [`flags.${MODULE_ID}.-=delayed`]: null };
  if (current && current.id !== combatantId) {
    updateData.initiative = (current.initiative ?? 0) + 0.01;
  }
  await combatant.update(updateData);

  const newIndex = combat.turns.findIndex((c) => c.id === combatantId);
  if (newIndex >= 0) await combat.update({ turn: newIndex });
}

/**
 * Only advances if `combatantId` is still actually the active
 * combatant when this runs on the GM's client. A relayed request is
 * never instant - guards against a stale click (e.g. the GM had
 * already moved the turn on, or auto-skip did) firing a second,
 * unwanted advance.
 */
async function gmEndTurn(combatId, combatantId) {
  const combat = game.combats?.get(combatId);
  if (!combat) return;
  if (combat.combatant?.id !== combatantId) return;
  await combat.nextTurn();
}
