import { MODULE_ID } from "./constants.js";

/**
 * Round reminders: short notes the GM attaches to a round ("the slow
 * effect ends", "reinforcements arrive") that pop up when that round
 * starts. They live on the Combat document as a flag, so they survive a
 * reload and belong to that fight only.
 */

const FLAG = "reminders";

export function getReminders(combat) {
  const list = combat?.getFlag(MODULE_ID, FLAG);
  return Array.isArray(list) ? list : [];
}

async function saveReminders(combat, list) {
  await combat.setFlag(MODULE_ID, FLAG, list);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** Does this reminder go off when round `k` begins? */
export function isDueInRound(reminder, k) {
  if (k === reminder.round) return true;
  return reminder.repeat > 0 && k > reminder.round && (k - reminder.round) % reminder.repeat === 0;
}

/** Rounds until a one-off reminder goes off (null for repeating ones). */
export function roundsUntil(reminder, currentRound) {
  if (reminder.repeat > 0) return null;
  return reminder.round - currentRound;
}

/** What the tracker shows: pending one-off reminders, soonest first. */
export function getCountdowns(combat, includeGMOnly) {
  const round = combat?.round ?? 0;
  return getReminders(combat)
    .filter((r) => r.repeat === 0 && r.round > round && (includeGMOnly || r.tellPlayers))
    .sort((a, b) => a.round - b.round)
    .map((r) => ({ text: r.text, left: r.round - round }));
}

/**
 * Called by the active GM when the round counter moves forward. Fires
 * every reminder due in the rounds that just began (a skipped round still
 * counts), then drops one-off reminders whose round has passed.
 */
export async function fireDueReminders(combat, fromRound, toRound) {
  const reminders = getReminders(combat);
  if (!reminders.length || !(toRound > fromRound)) return;

  for (let k = fromRound + 1; k <= toRound; k++) {
    for (const reminder of reminders) {
      if (!isDueInRound(reminder, k)) continue;
      try {
        await ChatMessage.create({
          content: `<p><strong>Round ${k}</strong> &middot; ${escapeHtml(reminder.text)}</p>`,
          speaker: { alias: "First Strike" },
          whisper: reminder.tellPlayers ? [] : ChatMessage.getWhisperRecipients("GM").map((u) => u.id)
        });
      } catch (err) {
        console.error("First Strike | couldn't post a reminder", err);
      }
      ui.notifications?.info(`Round ${k}: ${reminder.text}`);
    }
  }

  const remaining = reminders.filter((r) => r.repeat > 0 || r.round > toRound);
  if (remaining.length !== reminders.length) await saveReminders(combat, remaining);

  // Countdowns the players were told about tick down in the chat, one
  // short line per round, so "the ritual completes in 5 rounds" falls
  // 5, 4, 3... in front of everyone.
  const ticking = remaining
    .filter((r) => r.repeat === 0 && r.tellPlayers && r.round > toRound)
    .sort((a, b) => a.round - b.round);
  if (ticking.length) {
    const items = ticking
      .map((r) => `<li>${escapeHtml(r.text)} &mdash; <strong>${r.round - toRound}</strong> round${r.round - toRound === 1 ? "" : "s"} left</li>`)
      .join("");
    try {
      await ChatMessage.create({
        content: `<p><strong>Countdowns</strong></p><ul>${items}</ul>`,
        speaker: { alias: "First Strike" }
      });
    } catch (err) {
      console.error("First Strike | couldn't post the countdowns", err);
    }
  }
}

/* -------------------------------------------- */
/* The panel                                     */
/* -------------------------------------------- */

let closePanel = null;

export function closeRemindersPanel() {
  closePanel?.();
  closePanel = null;
}

function describe(reminder, currentRound = 0) {
  if (reminder.repeat === 0) {
    const left = reminder.round - currentRound;
    const when = left > 0 ? ` (${left} round${left === 1 ? "" : "s"} left)` : "";
    return `Round ${reminder.round}${when}`;
  }
  if (reminder.repeat > 0) {
    return reminder.repeat === 1
      ? `Every round from round ${reminder.round}`
      : `Every ${reminder.repeat} rounds from round ${reminder.round}`;
  }
  return `Round ${reminder.round}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(label, input) {
  const wrap = el("label", "first-strike-panel__field");
  wrap.append(el("span", "first-strike-panel__label", label), input);
  return wrap;
}

/** GM only. Opens the reminder list and the "add one" form below `anchor`. */
export function openRemindersPanel(anchor, getCombat, onChange) {
  closeRemindersPanel();
  const combat = getCombat();
  if (!combat) return;

  const panel = el("div", "first-strike-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Round reminders");

  const header = el("div", "first-strike-panel__header");
  header.append(el("span", "first-strike-panel__title", "Round reminders"));
  const closeButton = el("button", "first-strike-panel__close");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
  closeButton.addEventListener("click", closeRemindersPanel);
  header.append(closeButton);

  const list = el("ul", "first-strike-panel__list");

  const text = el("input", "first-strike-panel__input");
  text.type = "text";
  text.maxLength = 160;
  text.placeholder = "e.g. The slow effect ends";
  const inRounds = el("input", "first-strike-panel__input first-strike-panel__input--short");
  inRounds.type = "number";
  inRounds.min = "0";
  inRounds.value = "1";
  const repeat = el("input", "first-strike-panel__input first-strike-panel__input--short");
  repeat.type = "number";
  repeat.min = "0";
  repeat.value = "0";
  const tell = el("input");
  tell.type = "checkbox";
  const tellLabel = el("label", "first-strike-panel__check");
  tellLabel.append(tell, el("span", "", "Tell the players"));
  const add = el("button", "first-strike-panel__add", "Add reminder");
  add.type = "button";

  const form = el("div", "first-strike-panel__form");
  form.append(
    field("Reminder", text),
    el("div", "first-strike-panel__row"),
    tellLabel,
    add
  );
  form.children[1].append(field("In how many rounds", inRounds), field("Repeat every (0 = once)", repeat));

  async function renderList() {
    const current = getReminders(getCombat());
    list.replaceChildren();
    if (!current.length) {
      list.append(el("li", "first-strike-panel__empty", "No reminders yet."));
      return;
    }
    for (const reminder of [...current].sort((a, b) => a.round - b.round)) {
      const item = el("li", "first-strike-panel__item");
      const body = el("div", "first-strike-panel__body");
      body.append(el("span", "first-strike-panel__text", reminder.text));
      body.append(el("span", "first-strike-panel__meta", `${describe(reminder, getCombat()?.round ?? 0)}${reminder.tellPlayers ? " - players see it" : " - GM only"}`));
      const remove = el("button", "first-strike-panel__remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Delete reminder: ${reminder.text}`);
      remove.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
      remove.addEventListener("click", async () => {
        const live = getCombat();
        await saveReminders(live, getReminders(live).filter((r) => r.id !== reminder.id));
        await renderList();
        onChange?.();
      });
      item.append(body, remove);
      list.append(item);
    }
  }

  add.addEventListener("click", async () => {
    const note = text.value.trim();
    if (!note) {
      text.focus();
      return;
    }
    const live = getCombat();
    if (!live) return;
    const entry = {
      id: foundry.utils.randomID(),
      text: note,
      round: Math.max(0, live.round) + Math.max(0, Math.floor(Number(inRounds.value) || 0)),
      repeat: Math.max(0, Math.floor(Number(repeat.value) || 0)),
      tellPlayers: tell.checked
    };
    await saveReminders(live, [...getReminders(live), entry]);
    text.value = "";
    text.focus();
    await renderList();
    onChange?.();
  });
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter") add.click();
  });

  panel.append(header, list, form);
  document.body.append(panel);

  const margin = 8;
  const rect = panel.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const left = anchorRect.left + anchorRect.width / 2 - rect.width / 2;
  const top = anchorRect.bottom + 10;
  panel.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin))}px`;
  panel.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin))}px`;

  renderList();
  text.focus();

  const onKey = (event) => {
    if (event.key === "Escape") closeRemindersPanel();
  };
  const onPointer = (event) => {
    if (!panel.contains(event.target) && !anchor.contains(event.target)) closeRemindersPanel();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  closePanel = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    panel.remove();
  };
}

/* -------------------------------------------- */
/* Effects that are about to run out              */
/* -------------------------------------------- */

const SECONDS_PER_ROUND = 6;

/**
 * Rounds left on an effect, or null when it has no end to speak of.
 * PF2e effects report `remainingDuration` in seconds of game time
 * (Infinity when unlimited or "until the end of the encounter"), and a
 * round is 6 seconds. Core Foundry active effects are read as a fallback
 * for other systems.
 */
function roundsLeft(effect) {
  try {
    const pf2e = effect.remainingDuration;
    if (pf2e && typeof pf2e === "object") {
      if (pf2e.expired || !Number.isFinite(pf2e.remaining)) return null;
      return Math.ceil(pf2e.remaining / SECONDS_PER_ROUND);
    }
    const d = effect.duration;
    if (d && !d.expired) {
      if (Number.isFinite(d.secondsRemaining)) return Math.ceil(d.secondsRemaining / SECONDS_PER_ROUND);
      if (d.units === "rounds" && Number.isFinite(d.remaining)) return Math.ceil(d.remaining);
    }
  } catch (err) {
    console.debug("First Strike | couldn't read an effect's duration", err);
  }
  return null;
}

function effectsOf(actor) {
  const items = actor.itemTypes?.effect ?? actor.items?.filter((i) => i.type === "effect") ?? [];
  return [...items, ...(actor.effects?.contents ?? [])];
}

/**
 * Looks at the effects on everyone in the fight and tells the table which
 * ones are about to end. Effects on player characters go to the chat for
 * everybody; effects on everyone else go to the GM alone, so a monster's
 * timers never leak. Runs once per new round, on the active GM's client.
 */
export async function warnEndingEffects(combat) {
  const threshold = Number(game.settings.get(MODULE_ID, "effectWarnRounds"));
  if (!combat || !(threshold > 0)) return;

  const party = [];
  const others = [];
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor) continue;
    const bucket = combatant.hasPlayerOwner ? party : others;
    for (const effect of effectsOf(actor)) {
      const left = roundsLeft(effect);
      if (left === null || left < 1 || left > threshold) continue;
      bucket.push({ who: combatant.name, name: effect.name ?? effect.label ?? "Effect", left });
    }
  }

  const post = async (entries, title, whisper) => {
    if (!entries.length) return;
    const items = entries
      .map((e) => `<li>${escapeHtml(e.who)}: ${escapeHtml(e.name)} &mdash; <strong>${e.left}</strong> round${e.left === 1 ? "" : "s"} left</li>`)
      .join("");
    try {
      await ChatMessage.create({
        content: `<p><strong>${title}</strong></p><ul>${items}</ul>`,
        speaker: { alias: "First Strike" },
        whisper
      });
    } catch (err) {
      console.error("First Strike | couldn't post the ending-effects warning", err);
    }
  };

  await post(party, "Effects ending soon", []);
  await post(others, "Effects ending soon (GM only)", ChatMessage.getWhisperRecipients("GM").map((u) => u.id));
}
