import { MODULE_ID, getActiveCombat } from "./constants.js";

const SETTLE_MS = 300;
let timer = null;

/**
 * Called on every turn or round change. Waits for any auto-skipping to
 * settle, then (if the user turned "follow the turn" on) glides the map to
 * whoever is acting.
 */
export function scheduleCameraFollow(combat) {
  clearTimeout(timer);
  timer = setTimeout(() => panToActive(combat), SETTLE_MS);
}

/**
 * Centers the map on the acting combatant's token. A player is only taken
 * to a token they can actually see, so the camera never gives away where a
 * hidden creature is. `force` is for the on-screen button, which should
 * work even when the setting is off.
 */
export function panToActive(combat = getActiveCombat(), { force = false } = {}) {
  try {
    if (!force && !game.settings.get(MODULE_ID, "followCamera")) return;
    if (!combat?.started || !canvas?.ready) return;
    const current = combat.combatant;
    if (!current?.token || current.token.parent?.id !== canvas.scene?.id) return;
    const token = current.token.object;
    if (!token) return;
    if (!game.user.isGM && !token.visible) return;
    canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 600 });
  } catch (err) {
    console.error("First Strike | camera follow failed", err);
  }
}
