import { MODULE_ID, DEFAULT_BASIC_ACTIONS } from "./constants.js";

const rerender = () => game.triad?.tray?.refresh();
const relayout = () => game.triad?.tray?.applyLayout();

/** Each section of the Actions tab can be hidden individually. */
export const SECTIONS = ["toggles", "favorites", "strikes", "spells", "abilities", "consumables", "skills"];

export function registerSettings() {
    const reg = (key, data) => game.settings.register(MODULE_ID, key, {
        name: `TRIAD.Settings.${key}.Name`,
        hint: `TRIAD.Settings.${key}.Hint`,
        ...data
    });

    reg("openOnCombat", {
        scope: "client",
        config: true,
        type: Boolean,
        default: true
    });

    // Out of combat the tray remembers whether this user left it open or closed.
    game.settings.register(MODULE_ID, "openOutOfCombat", {
        scope: "client",
        config: false,
        type: Boolean,
        default: false
    });

    reg("trayWidth", {
        scope: "client",
        config: true,
        type: Number,
        range: { min: 260, max: 440, step: 10 },
        default: 320,
        onChange: relayout
    });

    reg("pushInterface", {
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: relayout
    });

    reg("useAssignedCharacter", {
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: rerender
    });

    reg("showUnreadyStrikes", {
        scope: "client",
        config: true,
        type: Boolean,
        default: false,
        onChange: rerender
    });

    for (const section of SECTIONS) {
        game.settings.register(MODULE_ID, `section.${section}`, {
            name: `TRIAD.Section.${section}`,
            hint: "TRIAD.Settings.section.Hint",
            scope: "client",
            config: true,
            type: Boolean,
            default: true,
            onChange: rerender
        });
    }

    reg("basicActions", {
        scope: "world",
        config: true,
        type: String,
        default: DEFAULT_BASIC_ACTIONS,
        onChange: rerender
    });

    reg("trackActions", {
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: rerender
    });

    reg("autoSpendActions", {
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: rerender
    });

    reg("movementCostsActions", {
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: rerender
    });

    // Internal UI state, persisted per client.
    game.settings.register(MODULE_ID, "collapsed", {
        scope: "client",
        config: false,
        type: Object,
        default: {}
    });
}

export function getSetting(key) {
    return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
    return game.settings.set(MODULE_ID, key, value);
}

export function isSectionEnabled(section) {
    return getSetting(`section.${section}`) !== false;
}
