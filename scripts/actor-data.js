/**
 * Reads a PF2e actor and turns it into a plain, template-ready context.
 * Nothing in here mutates documents; every write lives in actor-actions.js.
 */
import { MODULE_ID, BASIC_ACTION_ICONS, SAVE_SLUGS, ATTRIBUTE_SLUGS, RANK_LETTERS } from "./constants.js";
import { getSetting, isSectionEnabled } from "./settings.js";
import { actionGlyph, enrich, localizeLabel, percent, pips, signed } from "./helpers.js";
import { pendingMoveActions } from "./turn-state.js";
import { bombState } from "./alchemical-crossbow.js";

/**
 * @param {object} params
 * @param {Actor} params.actor
 * @param {Token|null} params.token
 * @param {Set<string>} params.expanded  Item UUIDs whose summaries are open
 * @param {Record<string, boolean>} params.collapsed  Section/group keys that are collapsed
 */
export async function buildActorContext({ actor, token, expanded, collapsed, skillPicker = null }) {
    const isCharacter = actor.type === "character";
    const errors = [];
    const summaryFor = async item => expanded.has(item.uuid)
        ? enrich(item.system?.description?.value ?? "", item)
        : null;

    /** Runs one builder in isolation: a failing section is logged and skipped, never blanks the tray. */
    const attempt = async (part, fn, fallback) => {
        try {
            return await fn();
        } catch (error) {
            console.error(`${MODULE_ID} | "${part}" failed for ${actor.name}`, error);
            errors.push({ part, message: error?.message ?? String(error) });
            return fallback;
        }
    };

    const header = await attempt("header", () => buildHeader(actor, isCharacter), fallbackHeader(actor));
    const turn = await attempt("turn", () => buildTurn(actor), { inCombat: false });
    const status = await attempt("status", () => buildStatus(actor), { conditions: [], effects: [], options: [], sustained: [], empty: true });
    const basicActions = await attempt("basicActions", () => buildBasicActions(actor, skillPicker), []);
    const skillChoice = skillPicker
        ? await attempt("skillChoice", () => buildSkillChoices(actor, skillPicker), null)
        : null;

    const toggles = await attempt("toggles", () => buildToggles(actor), []);

    const sections = [];
    const addSection = async (id, builder) => {
        if (!isSectionEnabled(id)) return;
        const data = await attempt(id, builder, []);
        if (!data?.length) return;
        sections.push({ id, label: `TRIAD.Section.${id}`, collapsed: !!collapsed[id], partial: `triad-${id}`, data });
    };
    await addSection("strikes", () => buildStrikes(actor, summaryFor));
    await addSection("spells", () => buildSpellcasting(actor, summaryFor, collapsed));
    await addSection("abilities", () => buildAbilities(actor, summaryFor));
    await addSection("consumables", () => buildConsumables(actor, summaryFor));
    await addSection("skills", () => buildSkills(actor));
    await attempt("favorites", () => applyFavoritesAndMap(actor, sections, turn, collapsed), null);

    return {
        uuid: actor.uuid,
        isCharacter,
        isOwner: actor.isOwner,
        header,
        turn,
        status,
        basicActions,
        skillChoice,
        toggles: isSectionEnabled("toggles") && toggles.length
            ? { items: toggles, collapsed: !!collapsed.toggles }
            : null,
        sections,
        utility: await attempt("utility", () => buildUtility(token), { hasToken: false }),
        character: await attempt("character", () => buildCharacterSheet(actor, isCharacter), { identity: [], attributes: [], speeds: [], tagGroups: [] }),
        errors
    };
}

function fallbackHeader(actor) {
    return {
        name: actor.name,
        img: actor.img,
        level: actor.level ?? "",
        subtitle: "",
        ac: "—",
        perception: "—",
        saves: [],
        hp: { value: 0, max: 0, temp: 0, pct: 0, missingPct: 0, tier: "full" }
    };
}

/* -------------------------------------------- */
/*  Favorites & multiple attack penalty         */
/* -------------------------------------------- */

/**
 * Post-processes the built sections:
 *  - marks which MAP button is next (attacks already made this turn),
 *  - flags favorite rows and builds the Favorites section from them (in pin order).
 */
function applyFavoritesAndMap(actor, sections, turn, collapsed) {
    const favorites = actor.getFlag(MODULE_ID, "favorites");
    const pinned = new Set(Array.isArray(favorites) ? favorites : []);
    const nextVariant = turn?.isTurn ? Math.min(Number(turn.attacks) || 0, 2) : 0;
    const byUuid = new Map();
    const section = id => sections.find(s => s.id === id)?.data ?? [];

    for (const strike of section("strikes")) {
        strike.nextVariant = nextVariant;
        for (const variant of strike.variants) variant.isNext = variant.index === nextVariant;
        strike.isFavorite = pinned.has(strike.uuid);
        if (strike.alt === null && strike.uuid && !byUuid.has(strike.uuid)) byUuid.set(strike.uuid, { kind: "strike", row: strike });
    }
    for (const entry of section("spells")) {
        for (const group of entry.groups) {
            for (const spell of group.spells) {
                spell.entryId = entry.id;
                spell.isFavorite = pinned.has(spell.uuid);
                if (!byUuid.has(spell.uuid)) byUuid.set(spell.uuid, { kind: "spell", row: spell });
            }
        }
    }
    for (const group of section("abilities")) {
        for (const row of group.rows) {
            row.isFavorite = pinned.has(row.uuid);
            byUuid.set(row.uuid, { kind: "ability", row });
        }
    }
    for (const row of section("consumables")) {
        row.isFavorite = pinned.has(row.uuid);
        byUuid.set(row.uuid, { kind: "consumable", row });
    }

    if (!isSectionEnabled("favorites")) return;
    const data = [...pinned].map(uuid => byUuid.get(uuid)).filter(Boolean).map(entry => ({
        ...entry,
        isStrike: entry.kind === "strike",
        isSpell: entry.kind === "spell",
        isAbility: entry.kind === "ability",
        isConsumable: entry.kind === "consumable"
    }));
    if (!data.length) return;
    sections.unshift({ id: "favorites", label: "TRIAD.Section.favorites", collapsed: !!collapsed.favorites, partial: "triad-favorites", data });
}

/* -------------------------------------------- */
/*  Header                                      */
/* -------------------------------------------- */

function buildHeader(actor, isCharacter) {
    const hp = actor.system.attributes?.hp ?? {};
    const hpValue = Number(hp.value) || 0;
    const hpMax = Number(hp.max) || 0;
    const subtitleParts = isCharacter
        ? [actor.ancestry?.name, actor.class?.name]
        : [localizeLabel(CONFIG.PF2E.creatureTraits?.[actor.system.details?.creatureType] ?? ""), localizeLabel(CONFIG.PF2E.actorSizes?.[actor.size] ?? "")];

    const saves = SAVE_SLUGS.map(slug => ({
        slug,
        label: game.i18n.localize(`TRIAD.Save.${slug}`),
        short: game.i18n.localize(`TRIAD.SaveShort.${slug}`),
        mod: signed(actor.saves?.[slug]?.mod)
    }));

    const dying = actor.attributes?.dying ?? { value: 0, max: 4 };
    const wounded = actor.attributes?.wounded ?? { value: 0, max: 3 };
    const doomed = actor.attributes?.doomed ?? { value: 0, max: 3 };

    return {
        name: actor.name,
        img: actor.img,
        level: actor.level,
        subtitle: subtitleParts.filter(Boolean).join(" · "),
        ac: actor.attributes?.ac?.value ?? "—",
        perception: signed(actor.perception?.mod),
        classDC: isCharacter ? actor.classDC?.dc?.value ?? null : null,
        saves,
        hp: {
            value: hpValue,
            max: hpMax,
            temp: Number(hp.temp) || 0,
            pct: percent(hpValue, hpMax),
            missingPct: 100 - percent(hpValue, hpMax),
            tier: hpTier(hpValue, hpMax)
        },
        isDown: hpMax > 0 && hpValue <= 0,
        heroPoints: isCharacter ? pips(actor.heroPoints?.value, actor.heroPoints?.max) : null,
        focus: buildFocus(actor),
        shield: buildShield(actor),
        dying: dying.value > 0 ? { value: dying.value, max: dying.max } : null,
        canRecover: dying.value > 0 && typeof actor.rollRecovery === "function",
        wounded: wounded.value > 0 ? { value: wounded.value } : null,
        doomed: doomed.value > 0 ? { value: doomed.value } : null
    };
}

function hpTier(value, max) {
    if (max <= 0) return "full";
    const ratio = value / max;
    if (ratio <= 0) return "down";
    if (ratio <= 0.25) return "critical";
    if (ratio <= 0.5) return "bloodied";
    return "healthy";
}

function buildFocus(actor) {
    const focus = actor.system.resources?.focus;
    if (!focus?.max) return null;
    return pips(focus.value, focus.max);
}

function buildShield(actor) {
    const shield = actor.attributes?.shield;
    if (!shield?.itemId) return null;
    return {
        name: shield.name,
        ac: shield.ac,
        hardness: shield.hardness,
        hp: shield.hp?.value ?? 0,
        maxHp: shield.hp?.max ?? 0,
        pct: percent(shield.hp?.value, shield.hp?.max),
        raised: !!shield.raised,
        broken: !!shield.broken
    };
}

/* -------------------------------------------- */
/*  Turn & action economy                       */
/* -------------------------------------------- */

export function findCombatant(actor) {
    const combat = game.combat;
    if (!combat || !actor) return null;
    return combat.combatants.find(c => c.actor?.uuid === actor.uuid) ?? null;
}

function buildTurn(actor) {
    const combatant = findCombatant(actor);
    if (!combatant) return { inCombat: false };

    const isTurn = game.combat.combatant?.id === combatant.id;
    const track = getSetting("trackActions");
    const state = actor.getFlag(MODULE_ID, "turn") ?? {};
    const quickened = actor.conditions?.bySlug?.("quickened", { active: true })?.length ? 1 : 0;
    const slowed = actor.conditions?.slowed?.value ?? 0;
    const stunned = actor.conditions?.stunned?.value ?? 0;
    const maxActions = Math.max(0, 3 + quickened - slowed);
    const spent = Math.clamp(Number(state.spent) || 0, 0, maxActions);
    // A Stride in progress (not at its full Speed yet) will cost one more action.
    const pending = isTurn && track && getSetting("movementCostsActions") ? pendingMoveActions(state) : 0;

    return {
        inCombat: true,
        isTurn,
        needsInitiative: combatant.initiative === null || combatant.initiative === undefined,
        initiative: combatant.initiative,
        track,
        actions: Array.from({ length: maxActions }, (_, i) => ({ index: i, spent: i < spent, pending: i >= spent && i < spent + pending })),
        reactionSpent: !!state.reaction,
        attacks: Number(state.attacks) || 0,
        move: buildMove(state.move, isTurn && track),
        quickened: !!quickened,
        slowed,
        stunned
    };
}

/** The open movement segment ("Stride 15/25 ft"), shown while it still has distance left. */
function buildMove(move, visible) {
    if (!visible || !move?.budget || !getSetting("movementCostsActions")) return null;
    const used = Math.round(Number(move.used) || 0);
    return {
        label: game.i18n.localize(`TRIAD.Move.${move.kind}`),
        used,
        budget: move.budget,
        left: Math.max(0, move.budget - used),
        pending: !move.paid
    };
}

/* -------------------------------------------- */
/*  Conditions & effects                        */
/* -------------------------------------------- */

function buildStatus(actor) {
    const conditions = (actor.conditions?.active ?? []).map(condition => ({
        id: condition.id,
        slug: condition.slug,
        name: condition.name,
        img: condition.img,
        value: condition.value ?? null,
        locked: !!condition.isLocked
    }));
    const sustained = (actor.itemTypes?.effect ?? [])
        .filter(effect => effect.system?.duration?.sustained)
        .map(effect => ({ id: effect.id, uuid: effect.uuid, name: effect.name, img: effect.img }));
    const effects = (actor.itemTypes?.effect ?? []).map(effect => ({
        id: effect.id,
        uuid: effect.uuid,
        name: effect.name,
        img: effect.img,
        badge: effect.badge?.value ?? null
    }));
    const options = statusEffectList()
        .filter(status => status.id && (status.img ?? status.icon))
        .map(status => ({
            id: status.id,
            name: localizeLabel(status.name ?? status.label ?? status.id),
            img: status.img ?? status.icon
        }))
        .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return { conditions, effects, options, sustained, empty: !conditions.length && !effects.length };
}

/** CONFIG.statusEffects is an array in V13 but may be a keyed object or Map in later versions. */
function statusEffectList() {
    const raw = CONFIG.statusEffects;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw instanceof Map) return [...raw.entries()].map(([id, status]) => ({ id, ...status }));
    return Object.entries(raw).map(([id, status]) => ({ id, ...status }));
}

/* -------------------------------------------- */
/*  Roll option toggles (the sheet's checkboxes) */
/* -------------------------------------------- */

/**
 * Every toggleable RollOption the PF2e sheet shows (Sorcerous Potency, Champion's Aura,
 * Hunted Prey precision, Deadly Aim…), with their suboption dropdowns.
 */
function buildToggles(actor) {
    const domains = actor.synthetics?.toggles ?? {};
    return Object.values(domains)
        .flatMap(domain => Object.values(domain ?? {}))
        .map(toggle => {
            const suboptions = (toggle.suboptions ?? []).map(sub => ({
                value: sub.value,
                label: localizeLabel(sub.label),
                selected: !!sub.selected
            }));
            return {
                itemId: toggle.itemId,
                domain: toggle.domain,
                option: toggle.option,
                label: localizeLabel(toggle.label),
                checked: !!toggle.checked,
                enabled: toggle.enabled !== false,
                alwaysActive: !!toggle.alwaysActive,
                suboptions,
                hasChoice: suboptions.length > 1
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/* -------------------------------------------- */
/*  Basic actions                               */
/* -------------------------------------------- */

/** Actions the PF2e system can't run without a chosen skill. */
export const SKILL_CHOICE_ACTIONS = new Set(["recall-knowledge"]);

function buildBasicActions(actor, skillPicker) {
    const slugs = String(getSetting("basicActions") ?? "")
        .split(",").map(s => s.trim()).filter(Boolean);
    return slugs.map(slug => {
        const action = game.pf2e?.actions?.get?.(slug);
        const needsSkill = SKILL_CHOICE_ACTIONS.has(slug);
        return {
            slug,
            name: action ? localizeLabel(action.name) : humanizeSlug(slug),
            icon: BASIC_ACTION_ICONS[slug] ?? "fa-solid fa-bolt",
            glyph: actionGlyph(action?.cost),
            needsSkill,
            active: needsSkill && skillPicker === slug
        };
    });
}

/**
 * Skill choices for Recall Knowledge: the action's own skills plus every Lore.
 * With an NPC targeted, the skills that identify it are marked as recommended.
 */
function buildSkillChoices(actor, slug) {
    const action = game.pf2e?.actions?.get?.(slug);
    const allowed = new Set(Array.isArray(action?.statistic) ? action.statistic : []);
    const target = game.user.targets?.first?.()?.actor ?? null;
    const identification = target?.type === "npc" ? target.identificationDCs : null;
    const recommended = new Set(identification?.skills ?? []);
    const choices = Object.values(actor.skills ?? {})
        .filter(skill => skill && (allowed.has(skill.slug) || skill.lore))
        .map(skill => ({
            slug: skill.slug,
            label: localizeLabel(skill.label),
            mod: signed(skill.mod),
            rankLetter: typeof skill.rank === "number" ? RANK_LETTERS[skill.rank] : null,
            rank: skill.rank,
            lore: !!skill.lore,
            recommended: recommended.has(skill.slug)
        }))
        .sort((a, b) => (b.recommended - a.recommended) || (a.lore - b.lore) || a.label.localeCompare(b.label, game.i18n.lang));
    return { slug, name: action ? localizeLabel(action.name) : humanizeSlug(slug), targetName: target?.name ?? null, choices };
}

const MINOR_WORDS = new Set(["a", "an", "the", "of", "for", "to", "in", "on"]);

function humanizeSlug(slug) {
    return slug.split("-")
        .map((word, i) => (i > 0 && MINOR_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(" ");
}

/* -------------------------------------------- */
/*  Strikes                                     */
/* -------------------------------------------- */

async function buildStrikes(actor, summaryFor) {
    const showUnready = getSetting("showUnreadyStrikes");
    const actions = actor.system.actions ?? [];
    const result = [];

    for (const [index, strike] of actions.entries()) {
        if (strike?.type !== "strike" || strike.visible === false) continue;
        if (!strike.ready && !showUnready) continue;
        result.push(await strikeRow(strike, { index, alt: null }, summaryFor));
        for (const [altIndex, alt] of (strike.altUsages ?? []).entries()) {
            if (alt?.type !== "strike") continue;
            result.push(await strikeRow(alt, { index, alt: altIndex }, summaryFor, strike));
        }
    }
    return result;
}

async function strikeRow(strike, { index, alt }, summaryFor, parent = null) {
    const item = strike.item;
    const usage = parent ? altUsageLabel(strike) : null;
    return {
        index,
        alt,
        uuid: item?.uuid ?? null,
        name: usage ? `${parent.label} (${usage})` : strike.label,
        img: item?.img ?? strike.imageUrl ?? "icons/svg/sword.svg",
        glyph: actionGlyph(strike.glyph) ?? "1",
        ready: strike.ready !== false,
        rowClass: strike.ready === false ? "is-unready" : "",
        canAttack: strike.canAttack !== false,
        traits: (strike.traits ?? []).slice(0, 4).map(t => localizeLabel(t.label ?? t.name ?? t)),
        variants: (strike.variants ?? []).map((variant, i) => ({
            index: i,
            value: variantValue(strike, variant),
            title: variant.label
        })),
        hasDamage: typeof strike.damage === "function",
        hasCritical: typeof strike.critical === "function",
        reload: parent ? null : buildReload(item),
        bomb: parent ? null : bombState(item),
        summary: item ? await summaryFor(item) : null
    };
}

/* -------------------------------------------- */
/*  Reload                                      */
/* -------------------------------------------- */

/** True for weapons that are loaded one shot at a time (reload ≠ 0, or repeating). */
export function needsReload(weapon) {
    if (!weapon?.isOfType?.("weapon") || !weapon.system?.ammo?.capacity) return false;
    const reload = weapon.reload ?? weapon.system?.reload?.value ?? null;
    return (reload !== null && reload !== "0") || weapon.system.traits?.value?.includes("repeating");
}

/** Ammunition currently inside the weapon (magazines count their remaining uses). */
export function loadedAmmoCount(weapon) {
    return (weapon.subitems ?? [])
        .filter(i => i.isOfType?.("ammo") || (i.isOfType?.("weapon") && i.isAmmoFor?.(weapon)))
        .reduce((sum, ammo) => sum + (ammo.isMagazine ? Number(ammo.system?.uses?.value) || 0 : Number(ammo.quantity) || 0), 0);
}

/** Ammo the actor can load into this weapon — the same filter as PF2e's own reloader. */
export function compatibleAmmo(weapon) {
    const actor = weapon.actor;
    if (!actor) return [];
    return [
        ...(actor.itemTypes?.ammo ?? []).filter(i => !i.isStowed),
        ...(actor.itemTypes?.weapon ?? []).filter(w => w.system?.usage?.canBeAmmo)
    ].filter(a => a.isAmmoFor?.(weapon));
}

function buildReload(weapon) {
    if (!needsReload(weapon)) return null;
    const max = Number(weapon.system.ammo.capacity) || 1;
    const loaded = loadedAmmoCount(weapon);
    const repeating = weapon.system.traits?.value?.includes("repeating");
    const actions = repeating ? 3 : Number(weapon.reload ?? weapon.system?.reload?.value);
    const options = compatibleAmmo(weapon).map(ammo => {
        const uses = ammo.isOfType?.("ammo") && ammo.uses?.max > 1 ? ammo.uses : null;
        return {
            id: ammo.id,
            name: ammo.name,
            img: ammo.img,
            quantity: ammo.quantity,
            uses: uses ? `${uses.value}/${uses.max}` : null,
            depleted: ammo.quantity === 0 || (uses ? uses.value === 0 : false),
            canLoadAll: max > 1
        };
    }).sort((a, b) => a.depleted - b.depleted);
    return {
        weaponId: weapon.id,
        loaded,
        max,
        full: loaded >= max,
        glyph: Number.isInteger(actions) && actions > 0 ? actionGlyph(actions) : null,
        loadedName: (weapon.subitems ?? []).find(i => i.isOfType?.("ammo", "weapon"))?.name ?? null,
        options
    };
}

function variantValue(strike, variant) {
    if (typeof variant.penalty === "number" && Number.isFinite(strike.totalModifier)) {
        return signed(strike.totalModifier + variant.penalty);
    }
    const match = String(variant.label ?? "").match(/[+-]\d+/);
    return match ? match[0] : variant.label;
}

function altUsageLabel(strike) {
    const options = strike.options ?? [];
    if (options.includes("thrown") || strike.item?.isThrown) return game.i18n.localize("TRIAD.Strike.Thrown");
    if (strike.item?.isMelee) return game.i18n.localize("TRIAD.Strike.Melee");
    return game.i18n.localize("TRIAD.Strike.Ranged");
}

/* -------------------------------------------- */
/*  Spellcasting                                */
/* -------------------------------------------- */

/**
 * Range, area, targets, duration and defense of a spell: a short line under its name
 * ("30 ft · 15-foot cone · 1 minute · basic Reflex") and the full list when expanded.
 */
function spellFacts(spell, summary) {
    const sys = spell.system ?? {};
    const text = value => String(value ?? "").trim();
    let area = "";
    let defense = "";
    try { area = spell.area?.label ?? ""; } catch { area = ""; }
    try { defense = spell.defense?.label ?? ""; } catch { defense = ""; }
    const range = text(sys.range?.value);
    const targets = text(sys.target?.value);
    const duration = text(sys.duration?.value);
    const sustained = !!sys.duration?.sustained;
    const durationLabel = sustained
        ? [game.i18n.localize("TRIAD.Spell.Sustained"), duration].filter(Boolean).join(", ")
        : duration;
    const rawTime = text(sys.time?.value);
    const time = /^[123]$/.test(rawTime)
        ? game.i18n.format(rawTime === "1" ? "TRIAD.Spell.OneAction" : "TRIAD.Spell.Actions", { n: rawTime })
        : rawTime === "reaction" ? game.i18n.localize("TRIAD.Ability.reaction")
        : rawTime === "free" ? game.i18n.localize("TRIAD.Ability.free")
        : rawTime;
    const traits = (sys.traits?.value ?? [])
        .map(t => localizeLabel(CONFIG.PF2E?.spellTraits?.[t] ?? t))
        .filter(Boolean);
    const L = key => game.i18n.localize(`TRIAD.Spell.${key}`);
    const details = [
        { label: L("Time"), value: time },
        { label: L("Range"), value: range },
        { label: L("Area"), value: area },
        { label: L("Targets"), value: targets },
        { label: L("Defense"), value: defense },
        { label: L("Duration"), value: durationLabel },
        { label: L("Cost"), value: text(sys.cost?.value) },
        { label: L("Requirements"), value: text(sys.requirements) },
        { label: L("Traits"), value: traits.join(", ") }
    ].filter(d => d.value);
    const meta = [range, area, durationLabel, defense].filter(Boolean).join(" · ");
    // Details only while the row is expanded (summary is null when collapsed).
    const open = summary !== null && summary !== undefined;
    return { meta, details: open ? details : [], summary: open ? (summary || " ") : null };
}

async function buildSpellcasting(actor, summaryFor, collapsed) {
    const collections = actor.spellcasting?.collections;
    if (!collections?.size) return [];
    const entries = [];

    for (const collection of collections) {
        const entry = collection.entry;
        let data;
        try {
            data = await entry.getSheetData({ spells: collection });
        } catch (error) {
            console.warn(`${MODULE_ID} | Could not read spellcasting entry ${entry?.name}`, error);
            continue;
        }
        if (!data || data.isRitual) continue;

        const groups = [];
        for (const group of data.groups ?? []) {
            const spells = [];
            for (const [slotId, slot] of (group.active ?? []).entries()) {
                if (!slot?.spell) continue;
                const spell = slot.spell;
                spells.push({
                    id: spell.id,
                    uuid: spell.uuid,
                    name: spell.name,
                    img: spell.img,
                    glyph: actionGlyph(spell.system?.time?.value),
                    time: actionGlyph(spell.system?.time?.value) ? null : spell.system?.time?.value,
                    castRank: slot.castRank ?? spell.rank,
                    slotId: data.isPrepared ? slotId : null,
                    expended: !!slot.expended,
                    rowClass: slot.expended ? "is-expended" : "",
                    signature: !!slot.signature,
                    ...spellFacts(spell, await summaryFor(spell))
                });
            }
            if (!spells.length) continue;

            const isCantrip = group.id === "cantrips";
            const uses = group.uses;
            const groupKey = `spells.${collection.id}.${group.id}`;
            groups.push({
                id: group.id,
                key: groupKey,
                collapsed: !!collapsed[groupKey],
                label: group.label,
                isCantrip,
                slotNumber: group.number ?? (isCantrip ? null : group.id),
                slots: !isCantrip && uses && uses.value !== undefined && uses.max > 0 && !data.isFocusPool
                    ? pips(uses.value, uses.max)
                    : null,
                spells
            });
        }
        if (!groups.length) continue;

        entries.push({
            id: collection.id,
            name: data.name,
            dc: data.statistic?.dc?.value ?? null,
            attack: data.statistic?.check ? signed(data.statistic.check.mod) : null,
            isFocusPool: !!data.isFocusPool,
            focus: data.isFocusPool ? buildFocus(actor) : null,
            groups
        });
    }
    return entries;
}

/* -------------------------------------------- */
/*  Actions, reactions & free actions           */
/* -------------------------------------------- */

async function buildAbilities(actor, summaryFor) {
    const items = [...(actor.itemTypes?.action ?? []), ...(actor.itemTypes?.feat ?? [])]
        .filter(item => item.actionCost);
    const buckets = { action: [], reaction: [], free: [] };

    for (const item of items) {
        const cost = item.actionCost;
        const bucket = cost.type === "reaction" ? "reaction" : cost.type === "free" ? "free" : "action";
        const frequency = item.system?.frequency;
        buckets[bucket].push({
            id: item.id,
            uuid: item.uuid,
            name: item.name,
            img: item.img,
            glyph: actionGlyph(cost),
            sort: item.sort,
            frequency: frequency?.max ? { value: frequency.value ?? 0, max: frequency.max } : null,
            summary: await summaryFor(item)
        });
    }

    const groups = [];
    for (const [key, rows] of Object.entries(buckets)) {
        if (!rows.length) continue;
        rows.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
        groups.push({ key, label: `TRIAD.Ability.${key}`, rows });
    }
    return groups;
}

/* -------------------------------------------- */
/*  Consumables                                 */
/* -------------------------------------------- */

async function buildConsumables(actor, summaryFor) {
    const rows = [];
    for (const item of actor.itemTypes?.consumable ?? []) {
        const uses = item.uses ?? item.system?.uses;
        rows.push({
            id: item.id,
            uuid: item.uuid,
            name: item.name,
            img: item.img,
            quantity: item.quantity ?? item.system?.quantity ?? 1,
            uses: uses?.max > 1 ? { value: uses.value ?? 0, max: uses.max } : null,
            summary: await summaryFor(item)
        });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

/* -------------------------------------------- */
/*  Skills                                      */
/* -------------------------------------------- */

function buildSkills(actor) {
    const isNpc = actor.type === "npc";
    return Object.values(actor.skills ?? {})
        .filter(skill => skill && (!isNpc || skill.proficient))
        .map(skill => ({
            slug: skill.slug,
            label: localizeLabel(skill.label),
            mod: signed(skill.mod),
            rank: typeof skill.rank === "number" ? skill.rank : null,
            rankLetter: typeof skill.rank === "number" ? RANK_LETTERS[skill.rank] : null,
            lore: !!skill.lore
        }))
        .sort((a, b) => (a.lore - b.lore) || a.label.localeCompare(b.label, game.i18n.lang));
}

/* -------------------------------------------- */
/*  Token utility                               */
/* -------------------------------------------- */

function buildUtility(token) {
    const doc = token?.document;
    return {
        hasToken: !!doc,
        elevation: Math.round((Number(doc?.elevation) || 0) * 100) / 100,
        // Elevation is the GM's call: players don't get the field.
        canEditElevation: !!doc && game.user.isGM,
        inCombat: !!doc?.inCombat,
        canConfigure: !!doc?.isOwner
    };
}

/* -------------------------------------------- */
/*  Character tab                               */
/* -------------------------------------------- */

function buildCharacterSheet(actor, isCharacter) {
    const identity = isCharacter
        ? ["ancestry", "heritage", "class", "background", "deity"]
            .map(key => {
                const item = actor[key];
                if (!item) return null;
                return {
                    key,
                    label: game.i18n.localize(`TRIAD.Identity.${key}`),
                    name: item.name,
                    img: item.img,
                    uuid: item.uuid
                };
            })
            .filter(Boolean)
        : [];

    const abilities = isCharacter ? actor.abilities : actor.system.abilities;
    const attributes = ATTRIBUTE_SLUGS.map(slug => ({
        slug,
        label: slug.toUpperCase(),
        mod: signed(abilities?.[slug]?.mod)
    }));

    const speeds = buildSpeeds(actor);
    const traits = (actor.system.traits?.value ?? [])
        .map(t => localizeLabel(CONFIG.PF2E.creatureTraits?.[t] ?? t))
        .slice(0, 12);

    const tagGroups = [
        { id: "senses", icon: "fa-solid fa-eye", tags: buildSenses(actor) },
        { id: "immunities", icon: "fa-solid fa-shield", tags: iwrTags(actor.attributes?.immunities) },
        { id: "resistances", icon: "fa-solid fa-shield-virus", tags: iwrTags(actor.attributes?.resistances) },
        { id: "weaknesses", icon: "fa-solid fa-heart-crack", tags: iwrTags(actor.attributes?.weaknesses) },
        { id: "languages", icon: "fa-solid fa-language", tags: buildLanguages(actor) },
        { id: "traits", icon: "fa-solid fa-tags", tags: isCharacter ? [] : traits.map(label => ({ label })) }
    ]
        .filter(group => group.tags.length)
        .map(group => ({ ...group, label: `TRIAD.Tags.${group.id}` }));

    return {
        identity,
        attributes,
        speeds,
        tagGroups,
        canRest: isCharacter && !!game.pf2e?.actions?.restForTheNight
    };
}

function buildSpeeds(actor) {
    const speeds = actor.system.movement?.speeds;
    const result = [];
    if (speeds) {
        for (const type of ["land", "fly", "swim", "climb", "burrow"]) {
            const value = speeds[type]?.value;
            if (value) result.push({ type, label: game.i18n.localize(`TRIAD.Speed.${type}`), value });
        }
        return result;
    }
    // Pre-v7 fallback
    const legacy = actor.system.attributes?.speed;
    if (legacy?.total ?? legacy?.value) {
        result.push({ type: "land", label: game.i18n.localize("TRIAD.Speed.land"), value: legacy.total ?? legacy.value });
    }
    for (const other of legacy?.otherSpeeds ?? []) {
        result.push({ type: other.type, label: game.i18n.localize(`TRIAD.Speed.${other.type}`), value: other.total ?? other.value });
    }
    return result;
}

function buildSenses(actor) {
    const senses = actor.system.perception?.senses ?? [];
    return senses.map(sense => {
        const label = sense.label ?? localizeLabel(CONFIG.PF2E.senses?.[sense.type] ?? sense.type);
        const range = Number.isFinite(sense.range) && sense.range > 0 ? `${sense.range} ft` : null;
        return { label, value: range };
    });
}

function iwrTags(list) {
    return (list ?? []).map(entry => ({ label: entry.label ?? localizeLabel(entry.type) }));
}

function buildLanguages(actor) {
    const languages = actor.system.details?.languages?.value ?? [];
    return languages.map(slug => ({ label: localizeLabel(CONFIG.PF2E.languages?.[slug] ?? slug) }));
}
