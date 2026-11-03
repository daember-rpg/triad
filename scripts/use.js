/**
 * "Use" entry points shared by clicks and by drag-to-token.
 * Each one performs the PF2e action, then spends the matching action pips
 * (only during the actor's own turn) or marks the reaction as used.
 */
import { getSetting } from "./settings.js";
import { isActorsTurn, isCombatRunning } from "./helpers.js";
import * as Ops from "./actor-actions.js";
import { turnOp } from "./relay.js";
import { prepayKind, prepayBudget } from "./movement.js";

/**
 * Normalizes a PF2e cost into what the tracker needs.
 * Accepts item.actionCost ({type, value}), Action.cost (1 | "reaction" | "free"),
 * or a spell time string ("2", "reaction", "1 to 3", "10 minutes").
 * @returns {{actions: number}|{reaction: true}|null}  null = nothing to spend
 */
export function costOf(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "object") {
        if (raw.type === "reaction") return { reaction: true };
        if (raw.type === "action") return costOf(raw.value);
        return null;
    }
    const text = String(raw).trim().toLowerCase();
    if (text === "reaction") return { reaction: true };
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= 3) return { actions: n };
    return null; // free, variable ("1 to 3") or exploration time — the player marks it by hand
}

function canSpendNow(actor) {
    return getSetting("trackActions") && getSetting("autoSpendActions") && isCombatRunning() && isActorsTurn(actor) && actor.isOwner;
}

export async function spend(actor, cost) {
    if (!cost || !getSetting("trackActions") || !getSetting("autoSpendActions")) return;
    if (!isCombatRunning()) return;
    if (cost.reaction) return Ops.markReactionSpent(actor);
    if (cost.actions && isActorsTurn(actor)) return Ops.spendActions(actor, cost.actions);
}

/** Which MAP variant (0, 1, 2) the next Strike should use this turn. */
export function nextStrikeVariant(actor) {
    if (!isActorsTurn(actor)) return 0;
    const attacks = Number(actor.getFlag("triad", "turn")?.attacks) || 0;
    return Math.min(attacks, 2);
}

export async function strike(actor, { index, alt, variant }, event) {
    const result = await Ops.rollStrike(actor, { index, alt, variant }, event);
    if (result) await spend(actor, { actions: 1 });
    return result;
}

export async function cast(actor, { entryId, spellId, rank, slotId }) {
    const spell = actor.spellcasting?.collections?.get(entryId)?.get(spellId);
    await Ops.castSpell(actor, { entryId, spellId, rank, slotId });
    if (spell) await spend(actor, costOf(spell.system?.time?.value));
}

export async function useItem(actor, itemId, event) {
    const item = actor.items.get(itemId);
    const result = await Ops.useItem(actor, itemId, event);
    if (item?.actionCost && result !== null && result !== false) await spend(actor, costOf(item.actionCost));
    return result;
}

/**
 * Recall Knowledge with a chosen skill. Uses PF2e's own action (secret roll, target's
 * identification DC); if that refuses to run, falls back to a secret check of the skill
 * so the player is never left with nothing.
 */
export async function recallKnowledge(actor, statistic, event) {
    const action = game.pf2e?.actions?.get?.("recall-knowledge");
    let rolled = false;
    if (action?.use) {
        try {
            await action.use({ actors: [actor], event, statistic });
            rolled = true;
        } catch (error) {
            console.warn("triad | Recall Knowledge action failed, rolling the skill instead", error);
        }
    }
    if (!rolled) {
        await actor.skills?.[statistic]?.roll({
            event,
            rollMode: "blindroll",
            extraRollOptions: ["action:recall-knowledge", `action:recall-knowledge:${statistic}`],
            traits: ["concentrate", "secret"]
        });
    }
    await spend(actor, { actions: 1 });
}

export async function systemAction(actor, slug, event, extra = {}) {
    if (slug === "recall-knowledge" && extra.statistic) return recallKnowledge(actor, extra.statistic, event);
    const action = game.pf2e?.actions?.get?.(slug);
    const result = await Ops.useSystemAction(actor, slug, event, extra);
    // Stride/Step with movement tracking: pay now, the next movement on the map uses it.
    const kind = prepayKind(slug);
    if (kind && getSetting("movementCostsActions") && canSpendNow(actor)) {
        await turnOp(actor, { type: "prepay", kind, budget: prepayBudget(actor, kind) });
        return result;
    }
    // Legacy macros (Raise a Shield) have no cost metadata but are single actions.
    const cost = action ? costOf(action.cost) : slug === "raise-a-shield" ? { actions: 1 } : null;
    await spend(actor, cost);
    return result;
}

export async function reload(actor, weaponId, ammoId, options) {
    await Ops.reloadWeapon(actor, weaponId, ammoId, options);
    const weapon = actor.items.get(weaponId);
    const repeating = weapon?.system?.traits?.value?.includes("repeating");
    await spend(actor, costOf(repeating ? 3 : weapon?.reload));
}

export async function sustain(actor, event) {
    await Ops.useSystemAction(actor, "sustain", event);
    await spend(actor, { actions: 1 });
}
