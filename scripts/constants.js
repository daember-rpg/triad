export const MODULE_ID = "triad";
export const TEMPLATE_ROOT = `modules/${MODULE_ID}/templates`;

/** Tabs shown in the rail, in order. */
export const TABS = ["actions", "character"];

/** Default PF2e system action slugs offered in the Basic Actions grid. */
export const DEFAULT_BASIC_ACTIONS = [
    "stride", "step", "seek", "take-cover", "raise-a-shield", "interact",
    "demoralize", "grapple", "trip", "shove", "disarm", "escape",
    "hide", "sneak", "tumble-through", "recall-knowledge"
].join(", ");

/** Font Awesome icon per action slug. Unknown slugs fall back to a generic icon. */
export const BASIC_ACTION_ICONS = {
    "stride": "fa-solid fa-person-walking",
    "step": "fa-solid fa-shoe-prints",
    "seek": "fa-solid fa-eye",
    "take-cover": "fa-solid fa-person-shelter",
    "raise-a-shield": "fa-solid fa-shield-halved",
    "interact": "fa-solid fa-hand",
    "demoralize": "fa-solid fa-face-angry",
    "grapple": "fa-solid fa-hands-holding",
    "trip": "fa-solid fa-person-falling",
    "shove": "fa-solid fa-hand-back-fist",
    "disarm": "fa-solid fa-hand-holding",
    "escape": "fa-solid fa-unlock",
    "hide": "fa-solid fa-user-secret",
    "sneak": "fa-solid fa-user-ninja",
    "tumble-through": "fa-solid fa-person-running",
    "recall-knowledge": "fa-solid fa-book-open",
    "feint": "fa-solid fa-masks-theater",
    "aid": "fa-solid fa-handshake-angle",
    "drop-prone": "fa-solid fa-person-praying",
    "stand": "fa-solid fa-person",
    "ready": "fa-solid fa-hourglass-half",
    "delay": "fa-solid fa-clock",
    "leap": "fa-solid fa-person-skiing-nordic",
    "climb": "fa-solid fa-mountain",
    "swim": "fa-solid fa-person-swimming",
    "reposition": "fa-solid fa-arrows-up-down-left-right",
    "sense-motive": "fa-solid fa-brain",
    "point-out": "fa-solid fa-hand-point-right",
    "avoid-notice": "fa-solid fa-ghost",
    "treat-wounds": "fa-solid fa-kit-medical",
    "administer-first-aid": "fa-solid fa-briefcase-medical"
};

/** Legacy `game.pf2e.actions[name]` functions for slugs that are not yet Action objects. */
export const LEGACY_ACTION_FUNCTIONS = {
    "raise-a-shield": "raiseAShield",
    "rest-for-the-night": "restForTheNight",
    "take-a-breather": "takeABreather"
};

export const SAVE_SLUGS = ["fortitude", "reflex", "will"];
export const ATTRIBUTE_SLUGS = ["str", "dex", "con", "int", "wis", "cha"];
export const RANK_LETTERS = ["U", "T", "E", "M", "L"];
