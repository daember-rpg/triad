/**
 * Alchemical Crossbow: load a lesser alchemical bomb into the bracket.
 *
 * PF2e reloads the crossbow's bolts itself, but has nothing for the bomb. Loading takes one Interact
 * action, uses up the bomb, and adds 1d6 damage of the bomb's type to the next three attacks with
 * that crossbow. The three attacks must fall within a minute of the first, so the first one starts a
 * one-minute clock. Splash and the bomb's other effects never apply.
 *
 * The loaded bomb is an effect on the actor: a DamageDice rule aimed at this one weapon, and a counter
 * badge with the attacks left. Attack rolls with the crossbow, from the tray or the sheet, count down.
 */
import { MODULE_ID } from "./constants.js";

const FLAG = "loadedBomb";
const USES = 3;
/** Damage types a bomb must deal for the bracket to take it. */
const ENERGY = new Set(["acid", "cold", "electricity", "fire", "sonic", "force", "vitality", "void"]);

const t = key => game.i18n.localize(key);
const f = (key, data) => game.i18n.format(key, data);

export function isAlchemicalCrossbow(weapon) {
    if (!weapon?.isOfType?.("weapon")) return false;
    const slug = weapon.slug ?? weapon.system?.slug ?? "";
    const base = weapon.system?.baseItem ?? "";
    return slug === "alchemical-crossbow" || base === "alchemical-crossbow" || /alchemical crossbow/i.test(weapon.name ?? "");
}

/** Why the bracket refuses a bomb, as a localization key, or null when it takes it. */
function refusal(item) {
    if (!ENERGY.has(item.system?.damage?.damageType)) return "TRIAD.Bomb.NotEnergy";
    const level = Number(item.level ?? item.system?.level?.value ?? 0);
    const lesser = level <= 1 || /lesser/i.test(item.name ?? "") || /-lesser$/.test(item.slug ?? "");
    return lesser ? null : "TRIAD.Bomb.NotLesser";
}

/** Every bomb in the inventory, carried and not empty. */
function carriedBombs(actor) {
    return (actor?.itemTypes?.weapon ?? [])
        .filter(item => item.system?.group === "bomb" && !item.isStowed && item.quantity > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Lesser bombs that deal energy damage: the ones the bracket accepts. */
export function eligibleBombs(actor) {
    return carriedBombs(actor).filter(item => refusal(item) === null);
}

function bombEffect(weapon) {
    return weapon?.actor?.itemTypes?.effect?.find(e => e.flags?.[MODULE_ID]?.[FLAG]?.weaponId === weapon.id) ?? null;
}

function damageLabel(type) {
    const key = CONFIG.PF2E?.damageTypes?.[type];
    return key ? t(key) : type;
}

/** What the tray shows on the crossbow's row. */
export function bombState(weapon) {
    if (!isAlchemicalCrossbow(weapon)) return null;
    const effect = bombEffect(weapon);
    const data = effect?.flags?.[MODULE_ID]?.[FLAG];
    // Every bomb is listed so the alchemist chooses; the ones the bracket refuses say why.
    const options = carriedBombs(weapon.actor).map(bomb => {
        const reason = refusal(bomb);
        return {
            id: bomb.id,
            name: bomb.name,
            img: bomb.img,
            quantity: bomb.quantity,
            damage: damageLabel(bomb.system.damage.damageType),
            disabled: reason !== null,
            reason: reason ? t(reason) : null
        };
    }).sort((a, b) => a.disabled - b.disabled);
    return {
        weaponId: weapon.id,
        loaded: effect
            ? {
                name: data.bombName,
                damage: damageLabel(data.damageType),
                remaining: Number(data.remaining ?? effect.system?.badge?.value ?? 0),
                max: USES,
                fired: !!data.fired
            }
            : null,
        options
    };
}

export async function loadBomb(actor, weaponId, bombId) {
    const weapon = actor?.items.get(weaponId);
    const bomb = actor?.items.get(bombId);
    if (!weapon || !bomb) return;
    if (bombEffect(weapon)) return ui.notifications.warn(t("TRIAD.Bomb.AlreadyLoaded"));

    const damageType = bomb.system.damage.damageType;
    const source = bomb.toObject();
    delete source._id;
    source.system.quantity = 1;

    if (bomb.quantity > 1) await bomb.update({ "system.quantity": bomb.quantity - 1 });
    else await bomb.delete();

    await actor.createEmbeddedDocuments("Item", [{
        type: "effect",
        name: f("TRIAD.Bomb.EffectName", { bomb: bomb.name }),
        img: bomb.img,
        system: {
            slug: `triad-loaded-bomb-${weapon.id}`,
            badge: { type: "counter", value: USES },
            duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
            tokenIcon: { show: true },
            description: {
                value: `<p>${f("TRIAD.Bomb.EffectDescription", { weapon: weapon.name, damage: damageLabel(damageType) })}</p>`
            },
            rules: [{
                key: "DamageDice",
                selector: `${weapon.id}-damage`,
                diceNumber: 1,
                dieSize: "d6",
                damageType,
                label: bomb.name
            }]
        },
        flags: { [MODULE_ID]: { [FLAG]: { weaponId: weapon.id, bombName: bomb.name, damageType, bombSource: source, fired: false, spent: false, remaining: USES } } }
    }]);

    await postInteract(actor, weapon, f("TRIAD.Bomb.LoadMessage", { actor: actor.name, bomb: bomb.name, weapon: weapon.name }));
}

/** Takes the bomb out. Unfired, it goes back into the inventory; fired, what is left is wasted. */
export async function unloadBomb(actor, weaponId) {
    const weapon = actor?.items.get(weaponId);
    const effect = bombEffect(weapon);
    if (!effect) return;
    const data = effect.flags[MODULE_ID][FLAG];

    if (!data.fired && data.bombSource) {
        const source = data.bombSource;
        const stack = actor.itemTypes.weapon.find(i =>
            i.system?.group === "bomb" && (i.slug ?? i.name) === (source.system?.slug ?? source.name) && !i.isStowed);
        if (stack) await stack.update({ "system.quantity": stack.quantity + 1 });
        else await actor.createEmbeddedDocuments("Item", [source]);
    }
    await effect.delete();
}

/**
 * Counts an attack roll with a loaded crossbow. Run by the client that made the roll.
 * The third attack leaves the effect at zero rather than deleting it, so that attack's damage roll
 * still gets the die; the effect goes on the crossbow's next damage roll or attack, or when its minute runs out.
 */
export async function onChatMessage(message) {
    if (!message.isAuthor) return;
    const type = message.flags?.pf2e?.context?.type;
    if (type !== "attack-roll" && type !== "damage-roll") return;

    const actor = message.actor;
    if (!actor?.isOwner) return;
    const item = message.item ?? (message.flags?.pf2e?.origin?.uuid ? fromUuidSync(message.flags.pf2e.origin.uuid) : null);
    const weapon = item?.isOfType?.("weapon") && item.actor === actor ? item : null;
    if (!weapon || !isAlchemicalCrossbow(weapon)) return;

    const effect = bombEffect(weapon);
    if (!effect) return;
    const data = effect.flags[MODULE_ID][FLAG];

    try {
        if (type === "damage-roll") {
            if (data.spent) await effect.delete();
            return;
        }
        if (data.spent) {
            await effect.delete();
            return;
        }
        const remaining = Math.max(0, Number(data.remaining ?? USES) - 1);
        const update = {
            // A counter badge at zero would be removed by the system before the last damage roll.
            "system.badge.value": Math.max(remaining, 1),
            [`flags.${MODULE_ID}.${FLAG}.remaining`]: remaining,
            [`flags.${MODULE_ID}.${FLAG}.fired`]: true,
            [`flags.${MODULE_ID}.${FLAG}.spent`]: remaining === 0
        };
        if (remaining === 0) update.name = f("TRIAD.Bomb.SpentName", { bomb: data.bombName });
        if (!data.fired) {
            // The first attack starts the minute in which the other two must be made.
            Object.assign(update, {
                "system.duration": { value: 1, unit: "minutes", expiry: "turn-end", sustained: false },
                "system.start": { value: game.time.worldTime, initiative: game.combat?.combatant?.initiative ?? null }
            });
        }
        await effect.update(update);
    } catch (error) {
        console.warn(`${MODULE_ID} | could not count the alchemical crossbow attack`, error);
    }
}

async function postInteract(actor, weapon, message) {
    if (!game.combat) return;
    const traits = [{ name: "manipulate", label: t(CONFIG.PF2E.actionTraits?.manipulate ?? "Manipulate"), description: CONFIG.PF2E.traitsDescriptions?.manipulate }];
    try {
        const render = foundry.applications.handlebars.renderTemplate;
        const flavor = await render(`systems/${game.system.id}/templates/chat/action/flavor.hbs`, {
            action: { title: "PF2E.Actions.Interact.Title", subtitle: "TRIAD.Bomb.Load", glyph: "1" },
            traits
        });
        const content = await render(`systems/${game.system.id}/templates/chat/action/content.hbs`, { imgPath: weapon.img, message });
        const token = actor.getActiveTokens(false, true).shift();
        await ChatMessage.implementation.create({
            content,
            flavor,
            speaker: ChatMessage.implementation.getSpeaker({ actor, token }),
            style: CONST.CHAT_MESSAGE_STYLES.EMOTE
        });
    } catch (error) {
        console.warn(`${MODULE_ID} | Load bomb message failed`, error);
    }
}
