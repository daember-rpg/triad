/**
 * Every operation the tray performs on PF2e documents.
 * Each function receives the resolved actor (and token where relevant) and
 * delegates to the PF2e system API so other modules see a normal workflow.
 */
import { MODULE_ID, LEGACY_ACTION_FUNCTIONS } from "./constants.js";
import { findCombatant, loadedAmmoCount, compatibleAmmo } from "./actor-data.js";
import { turnOp, requestEndTurn } from "./relay.js";

const warn = key => ui.notifications.warn(game.i18n.localize(key));

/* -------------------------------------------- */
/*  Checks                                      */
/* -------------------------------------------- */

export function rollSave(actor, slug, event) {
    return actor.saves?.[slug]?.roll({ event });
}

export function rollPerception(actor, event) {
    return actor.perception?.roll({ event });
}

export function rollSkill(actor, slug, event) {
    return actor.skills?.[slug]?.roll({ event });
}

/* -------------------------------------------- */
/*  Strikes                                     */
/* -------------------------------------------- */

function getStrike(actor, index, alt) {
    const strike = actor.system.actions?.[index];
    if (!strike) return null;
    if (alt === null || alt === undefined || alt === "") return strike;
    return strike.altUsages?.[Number(alt)] ?? null;
}

export function rollStrike(actor, { index, alt, variant }, event) {
    const strike = getStrike(actor, index, alt);
    if (!strike) return;
    return strike.variants?.[Number(variant) || 0]?.roll({ event });
}

export function rollStrikeDamage(actor, { index, alt, critical }, event) {
    const strike = getStrike(actor, index, alt);
    if (!strike) return;
    const fn = critical ? strike.critical : strike.damage;
    return fn?.({ event });
}

/* -------------------------------------------- */
/*  Reload                                      */
/* -------------------------------------------- */

/** Ammo that can still be loaded (not depleted). */
export function loadableAmmo(actor, weaponId) {
    const weapon = actor.items.get(weaponId);
    if (!weapon) return [];
    return compatibleAmmo(weapon).filter(a => a.quantity > 0 && !(a.isOfType("ammo") && a.uses?.max > 1 && a.uses.value === 0));
}

/**
 * Same behaviour as PF2e's WeaponReloader: attach 1 (or as many as fit) to the weapon,
 * then post the Interact (Reload) message while in an encounter.
 */
export async function reloadWeapon(actor, weaponId, ammoId, { all = false } = {}) {
    const weapon = actor.items.get(weaponId);
    const ammo = actor.inventory?.get(ammoId) ?? actor.items.get(ammoId);
    if (!weapon || !ammo) return;
    const capacity = Number(weapon.system.ammo?.capacity) || 0;
    const remaining = Math.max(0, capacity - loadedAmmoCount(weapon));
    if (remaining <= 0) return warn("TRIAD.Reload.Full");
    const quantity = all ? Math.min(remaining, ammo.quantity) : 1;
    await weapon.attach(ammo, { quantity, stack: true });
    await postReloadMessage(actor, weapon, ammo);
}

async function postReloadMessage(actor, weapon, ammo) {
    if (!game.combat) return;
    const repeating = weapon.system.traits?.value?.includes("repeating");
    const actions = repeating ? 3 : Number(weapon.reload);
    const glyph = { 1: "1", 2: "2", 3: "3" }[actions] ?? null;
    const traits = [{ name: "manipulate", label: game.i18n.localize(CONFIG.PF2E.actionTraits?.manipulate ?? "Manipulate"), description: CONFIG.PF2E.traitsDescriptions?.manipulate }];
    try {
        const render = foundry.applications.handlebars.renderTemplate;
        const flavor = await render(`systems/${game.system.id}/templates/chat/action/flavor.hbs`, {
            action: { title: "PF2E.Actions.Interact.Title", subtitle: "PF2E.Actions.Interact.Reload.Title", glyph },
            traits
        });
        const content = await render(`systems/${game.system.id}/templates/chat/action/content.hbs`, {
            imgPath: weapon.img,
            message: game.i18n.format("PF2E.Actions.Interact.Reload.Description", { actor: actor.name, weapon: weapon.name, ammo: ammo.name })
        });
        const token = actor.getActiveTokens(false, true).shift();
        await ChatMessage.implementation.create({
            content,
            flavor,
            speaker: ChatMessage.implementation.getSpeaker({ actor, token }),
            style: CONST.CHAT_MESSAGE_STYLES.EMOTE
        });
    } catch (error) {
        console.warn(`${MODULE_ID} | Reload message failed`, error);
    }
}

/* -------------------------------------------- */
/*  Spells                                      */
/* -------------------------------------------- */

export async function castSpell(actor, { entryId, spellId, rank, slotId }) {
    const collection = actor.spellcasting?.collections?.get(entryId);
    const spell = collection?.get(spellId);
    if (!collection || !spell) return;
    const castRank = Number(rank) || spell.rank;
    if (spell.parentItem) return spell.parentItem.consume();
    const options = { rank: castRank };
    if (slotId !== undefined && slotId !== null && slotId !== "") options.slotId = Number(slotId);
    return collection.entry.cast(spell, options);
}

/** Clicking pip N sets the value to N+1, or to N when it was already N+1 (toggle). */
function pipValue(current, index) {
    const target = index + 1;
    return current === target ? index : target;
}

export async function setSpellSlots(actor, { entryId, slotNumber, index }) {
    const entry = actor.items.get(entryId);
    if (!entry || slotNumber === undefined) return;
    const path = `system.slots.slot${slotNumber}.value`;
    const current = foundry.utils.getProperty(entry, path) ?? 0;
    return entry.update({ [path]: pipValue(current, index) });
}

export function setFocusPoints(actor, index) {
    const current = actor.system.resources?.focus?.value ?? 0;
    return actor.update({ "system.resources.focus.value": pipValue(current, index) });
}

export function setHeroPoints(actor, index) {
    const current = actor.system.resources?.heroPoints?.value ?? 0;
    return actor.update({ "system.resources.heroPoints.value": pipValue(current, index) });
}

/* -------------------------------------------- */
/*  Items                                       */
/* -------------------------------------------- */

/** Actions, feats and anything else: same path as the PF2e hotbar macro. */
export function useItem(actor, itemId, event) {
    const item = actor.items.get(itemId);
    if (!item) return;
    if (item.isOfType?.("consumable")) return item.consume();
    if (game.pf2e?.rollItemMacro) return game.pf2e.rollItemMacro(item.uuid, event);
    return item.toMessage?.(event);
}

export function openItemSheet(uuid) {
    const doc = fromUuidSync(uuid);
    return doc?.sheet?.render(true);
}

export function postItem(actor, itemId, event) {
    return actor.items.get(itemId)?.toMessage?.(event);
}

/** Posts an item's card (spell, weapon, action…) to chat without casting or consuming anything. */
export async function postToChat(uuid, event) {
    const doc = await fromUuid(uuid);
    return doc?.toMessage?.(event);
}

/* -------------------------------------------- */
/*  System actions (Seek, Trip, Raise a Shield…)*/
/* -------------------------------------------- */

/** @param {object} [extra]  extra use() options, e.g. { statistic: "arcana" } for Recall Knowledge */
export async function useSystemAction(actor, slug, event, extra = {}) {
    const actions = game.pf2e?.actions;
    const action = actions?.get?.(slug);
    if (action?.use) {
        try {
            return await action.use({ actors: [actor], event, ...extra });
        } catch (error) {
            // PF2e throws for invalid use (e.g. a missing skill); show it instead of failing silently.
            console.error(`${MODULE_ID} | ${slug} failed`, error);
            ui.notifications.error(error?.message ?? String(error));
            return null;
        }
    }

    const legacyName = LEGACY_ACTION_FUNCTIONS[slug] ?? slug.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const legacy = actions?.[legacyName];
    if (typeof legacy === "function") return legacy({ actors: [actor], event });

    ui.notifications.warn(game.i18n.format("TRIAD.Warn.UnknownAction", { slug }));
}

/* -------------------------------------------- */
/*  Conditions & effects                        */
/* -------------------------------------------- */

export function increaseCondition(actor, slug) {
    return actor.increaseCondition?.(slug);
}

export function decreaseCondition(actor, slug) {
    return actor.decreaseCondition?.(slug);
}

export function deleteEffect(actor, itemId) {
    return actor.items.get(itemId)?.delete();
}

/* -------------------------------------------- */
/*  Hit points                                  */
/* -------------------------------------------- */

/**
 * Accepts absolute ("12") or relative ("+5", "-7") input.
 * @param {"value"|"temp"} field
 */
export function updateHitPoints(actor, field, raw) {
    const hp = actor.system.attributes?.hp;
    if (!hp || !actor.isOwner) return;
    const text = String(raw ?? "").trim();
    if (!text) return;
    const current = Number(hp[field]) || 0;
    const delta = Number(text);
    if (!Number.isFinite(delta)) return;
    const next = /^[+-]/.test(text) ? current + delta : delta;
    const value = field === "temp"
        ? Math.max(0, next)
        : Math.clamp(next, 0, Number(hp.max) || 0);
    return actor.update({ [`system.attributes.hp.${field}`]: value });
}

/* -------------------------------------------- */
/*  Combat & turn tracker                       */
/* -------------------------------------------- */

export async function rollInitiative(actor) {
    const combatant = findCombatant(actor);
    // First Strike relays player rolls through the GM (direct combatant writes are rejected in this world).
    const firstStrike = game.modules.get("first-strike");
    if (firstStrike?.active && firstStrike.api?.requestRollInitiative && combatant) {
        return firstStrike.api.requestRollInitiative(combatant.id);
    }
    if (actor.initiative?.roll) return actor.initiative.roll();
    if (combatant) return game.combat.rollInitiative([combatant.id]);
}

export function endTurn() {
    return requestEndTurn();
}

export async function addToCombat(token) {
    const doc = token?.document;
    if (!doc) return warn("TRIAD.Warn.NoToken");
    if (doc.inCombat) return;
    return TokenDocument.implementation.createCombatants([doc]);
}

export function setActionsSpent(actor, index) {
    return turnOp(actor, { type: "setSpent", index });
}

export function toggleReaction(actor) {
    return turnOp(actor, { type: "toggleReaction" });
}

/** Called by the active GM when the turn changes: refresh actions, reaction and attack count. */
export async function resetTurnState(actor) {
    if (!actor?.getFlag(MODULE_ID, "turn")) return;
    return turnOp(actor, { type: "reset" });
}

/** Marks `count` actions as spent (the display caps at the actor's real maximum). */
export function spendActions(actor, count) {
    if (!actor?.isOwner || !(count > 0)) return;
    return turnOp(actor, { type: "spend", count });
}

export function markReactionSpent(actor) {
    if (!actor?.isOwner || actor.getFlag(MODULE_ID, "turn")?.reaction) return;
    return turnOp(actor, { type: "reaction" });
}

/** One more attack this turn → the next Strike uses the next multiple-attack penalty. */
export function recordAttack(actor) {
    if (!actor?.isOwner) return;
    return turnOp(actor, { type: "attack" });
}

/* -------------------------------------------- */
/*  Favorites, recovery, sustain                */
/* -------------------------------------------- */

export function getFavorites(actor) {
    const list = actor?.getFlag(MODULE_ID, "favorites");
    return Array.isArray(list) ? list : [];
}

export function toggleFavorite(actor, uuid) {
    if (!actor?.isOwner || !uuid) return;
    const list = getFavorites(actor);
    const next = list.includes(uuid) ? list.filter(u => u !== uuid) : [...list, uuid];
    return actor.setFlag(MODULE_ID, "favorites", next);
}

/** Same call the PF2e sheet makes for its roll-option checkboxes and suboption selects. */
export function setRollOption(actor, { domain, option, itemId, value, suboption }) {
    if (!actor?.isOwner || !domain || !option) return;
    return actor.toggleRollOption(domain, option, itemId || null, !!value, suboption || null);
}

export function rollRecovery(actor, event) {
    return actor?.rollRecovery?.(event);
}

/* -------------------------------------------- */
/*  Token utility                               */
/* -------------------------------------------- */

/** Sets the token's elevation in scene units (ft). "+10" / "-5" are accepted as relative changes. */
export function setElevation(token, raw) {
    const doc = token?.document;
    if (!doc) return warn("TRIAD.Warn.NoToken");
    const text = String(raw ?? "").trim().replace(",", ".");
    const number = Number(text);
    if (!text || !Number.isFinite(number)) return;
    const current = Number(doc.elevation) || 0;
    const value = /^[+-]/.test(text) ? current + number : number;
    const rounded = Math.round(value * 100) / 100;
    if (rounded === current) return;
    return doc.update({ elevation: rounded });
}

export function openTokenConfig(token) {
    if (!token) return warn("TRIAD.Warn.NoToken");
    return token.document.sheet?.render(true);
}

export function restForTheNight(actor) {
    return game.pf2e?.actions?.restForTheNight?.({ actors: [actor] });
}
