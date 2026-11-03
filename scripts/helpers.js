import { TEMPLATE_ROOT } from "./constants.js";

/** Partial name -> template path. Registered once at init. */
export const PARTIALS = {
    "triad-header": "partials/header.hbs",
    "triad-turn": "partials/turn.hbs",
    "triad-status": "partials/status.hbs",
    "triad-basic-actions": "partials/basic-actions.hbs",
    "triad-strikes": "partials/strikes.hbs",
    "triad-spells": "partials/spells.hbs",
    "triad-abilities": "partials/abilities.hbs",
    "triad-consumables": "partials/consumables.hbs",
    "triad-skills": "partials/skills.hbs",
    "triad-utility": "partials/utility.hbs",
    "triad-section": "partials/section.hbs",
    "triad-row": "partials/row.hbs",
    "triad-strike-row": "partials/strike-row.hbs",
    "triad-spell-row": "partials/spell-row.hbs",
    "triad-ability-row": "partials/ability-row.hbs",
    "triad-consumable-row": "partials/consumable-row.hbs",
    "triad-favorites": "partials/favorites.hbs",
    "triad-toggles": "partials/toggles.hbs",
    "triad-pips": "partials/pips.hbs",
    "triad-actions-tab": "partials/actions-tab.hbs",
    "triad-character-tab": "partials/character-tab.hbs",
    "triad-empty": "partials/empty.hbs"
};

export async function registerTemplates() {
    const paths = Object.fromEntries(
        Object.entries(PARTIALS).map(([name, file]) => [name, `${TEMPLATE_ROOT}/${file}`])
    );
    await foundry.applications.handlebars.loadTemplates(paths);
}

export function registerHelpers() {
    Handlebars.registerHelper("triadSigned", value => signed(value));
}

/** "+3" / "-1" / "+0". Returns "—" for non-numbers. */
export function signed(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n >= 0 ? `+${n}` : `${n}`;
}

/** Builds a pip array for resources like hero points, focus or spell slots. */
export function pips(value, max) {
    const total = Math.max(0, Number(max) || 0);
    const filled = Math.clamp(Number(value) || 0, 0, total);
    return Array.from({ length: total }, (_, i) => ({ index: i, filled: i < filled }));
}

export function percent(value, max) {
    const m = Number(max) || 0;
    if (m <= 0) return 0;
    return Math.clamp(Math.round(((Number(value) || 0) / m) * 100), 0, 100);
}

const GLYPHS = { free: "F", reaction: "R", 0: "F", 1: "1", 2: "2", 3: "3" };

/**
 * Converts a PF2e action cost into a glyph understood by the system's
 * "Pathfinder2eActions" font (`.action-glyph`).
 * Accepts `{ type, value }` (item.actionCost) or a time string ("2", "reaction", "1 to 3").
 */
export function actionGlyph(cost) {
    if (cost === null || cost === undefined || cost === "") return null;
    if (typeof cost === "object") {
        if (cost.type === "action") return GLYPHS[cost.value] ?? null;
        return GLYPHS[cost.type] ?? null;
    }
    const text = String(cost).trim().toLowerCase();
    if (text in GLYPHS) return GLYPHS[text];
    const range = text.match(/^(\d)\s*(?:to|-)\s*(\d)$/);
    if (range) return `${range[1]} – ${range[2]}`;
    if (text === "2 rounds") return "3,3";
    const either = text.match(/^(\d)\s*or\s*(\d)$/);
    if (either) return `${either[1]}/${either[2]}`;
    return null;
}

export function localizeLabel(label) {
    if (typeof label !== "string") return String(label ?? "");
    return game.i18n.has(label) ? game.i18n.localize(label) : label;
}

export async function enrich(text, item) {
    if (!text) return "";
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    return TextEditor.enrichHTML(text, {
        rollData: item?.getRollData?.() ?? {},
        relativeTo: item,
        secrets: item?.isOwner ?? false
    });
}

/** True while an encounter on this world has started (round ≥ 1). */
export function isCombatRunning() {
    return !!game.combat?.started;
}

/** True when this actor's combatant is the one acting right now. */
export function isActorsTurn(actor) {
    return !!actor && isCombatRunning() && game.combat.combatant?.actor?.uuid === actor.uuid;
}
