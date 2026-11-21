export const MODULE_ID = "first-strike";

/**
 * The encounter the tracker should show: the one flagged active, or - if
 * an encounter got started through another module's own flow without
 * being flagged active - whichever one is currently viewed. Without the
 * fallback the tracker would act as if no fight existed at all, which
 * for a player means an empty screen.
 */
export function getActiveCombat() {
  return game.combats?.active ?? game.combat ?? null;
}
