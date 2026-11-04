import { MODULE_ID } from "./constants.js";
import { registerSettings, getSetting } from "./settings.js";
import { registerHelpers, registerTemplates } from "./helpers.js";
import { resetTurnState, recordAttack } from "./actor-actions.js";
import { isActorsTurn } from "./helpers.js";
import { ensureSocket } from "./relay.js";
import { registerMovementHooks } from "./movement.js";
import { TriadTray, isCombatRunning } from "./tray.js";

let templatesLoaded = Promise.resolve();

Hooks.once("init", () => {
    registerSettings();
    registerKeybindings();
    registerHelpers();
    templatesLoaded = registerTemplates();
});

Hooks.once("ready", async () => {
    if (game.system.id !== "pf2e") {
        console.warn(`${MODULE_ID} | Triad requires the Pathfinder 2e system; tray disabled.`);
        return;
    }
    await templatesLoaded;
    ensureSocket();
    if (game.user.isGM && typeof socketlib === "undefined") {
        ui.notifications.warn(game.i18n.localize("TRIAD.Warn.NoSocketlib"));
    }
    const tray = new TriadTray();
    const api = {
        open: () => tray.setOpen(true),
        close: () => tray.setOpen(false),
        toggle: () => tray.toggle(),
        focusTab: tab => tray.focusTab(tab),
        registerDock: config => tray.registerDock(config),
        hasDock: id => tray.hasDock(id),
        setDockBadge: (id, value) => tray.setDockBadge(id, value),
        registerTool: config => tray.registerTool(config),
        hasTool: id => tray.hasTool(id)
    };
    game.triad = { tray, api };
    await tray.render({ force: true });
    tray.applyRestingState();
    registerRefreshHooks(tray);
    registerMovementHooks();
    // Integration point: other modules (First Strike) register their docks here.
    Hooks.callAll("triad.ready", api);
});

/* -------------------------------------------- */
/*  Scene control (native on-screen entry point)*/
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", controls => {
    const tokens = controls.tokens ?? controls.token;
    if (!tokens?.tools) return;
    tokens.tools.triad = {
        name: "triad",
        title: "TRIAD.Controls.Toggle",
        icon: "fa-solid fa-hand-fist",
        order: Object.keys(tokens.tools).length + 1,
        button: true,
        visible: true,
        onChange: () => game.triad?.tray?.toggle()
    };
});

/* -------------------------------------------- */
/*  Keybindings                                 */
/* -------------------------------------------- */

function registerKeybindings() {
    const bind = (action, key, modifiers, handler) => game.keybindings.register(MODULE_ID, action, {
        name: `TRIAD.Keybindings.${action}`,
        editable: [{ key, modifiers }],
        precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
        onDown: () => {
            const tray = game.triad?.tray;
            if (!tray) return false;
            handler(tray);
            return true;
        }
    });
    bind("toggleTray", "KeyE", ["Shift"], tray => tray.toggle());
    bind("actionsTab", "KeyA", ["Alt"], tray => tray.showTab("actions"));
    bind("characterTab", "KeyC", ["Alt"], tray => tray.showTab("character"));
}

/* -------------------------------------------- */
/*  Live updates                                */
/* -------------------------------------------- */

function registerRefreshHooks(tray) {
    const forActor = actor => {
        if (tray.isRelevant(actor)) tray.refresh();
    };

    // Switching tokens fires release + control back to back; debounce so we only react once.
    const onSelection = foundry.utils.debounce(() => tray.onTokenSelected(), 40);
    Hooks.on("controlToken", () => {
        tray.refresh();
        onSelection();
    });
    Hooks.on("canvasReady", () => tray.refresh());

    Hooks.on("updateActor", forActor);
    for (const hook of ["createItem", "updateItem", "deleteItem"]) {
        Hooks.on(hook, item => forActor(item.actor));
    }
    Hooks.on("updateToken", tokenDoc => {
        if (tokenDoc.id === tray.token?.document?.id) tray.refresh();
    });
    // Own targets matter for the tray's own token and for Recall Knowledge suggestions.
    Hooks.on("targetToken", user => {
        if (user.isSelf) tray.refresh();
    });

    for (const hook of ["createCombat", "createCombatant", "updateCombatant", "deleteCombatant"]) {
        Hooks.on(hook, () => tray.refresh());
    }

    Hooks.on("updateCombat", (combat, changes) => {
        tray.refresh();
        const turnChanged = "turn" in changes || "round" in changes;
        const justStarted = changes.round === 1 && (combat.turn ?? 0) === 0 && combat.started;

        // "combatStart" only fires on the client that pressed Begin; updateCombat reaches everyone.
        if (justStarted && combat === game.combat) {
            tray.applyRestingState();
            // Everyone lands on the initiative tab to roll.
            if (getSetting("openOnCombat") && tray.hasDock("initiative")) tray.focusTab("initiative");
        } else if (turnChanged && !game.user.isGM && tray.tab === "initiative") {
            // A player's own turn begins: take them to their actions.
            if (combat.combatant?.actor?.isOwner) tray.focusTab("actions");
        }

        if (!isResponsibleGM() || !getSetting("trackActions")) return;
        if (justStarted) {
            for (const combatant of combat.combatants) resetTurnState(combatant.actor);
        } else if (turnChanged) {
            resetTurnState(combat.combatant?.actor);
        }
    });

    // Multiple attack penalty: count attack rolls made on the actor's own turn (from the tray or the sheet).
    Hooks.on("createChatMessage", message => {
        if (!message.isAuthor) return;
        const type = message.flags?.pf2e?.context?.type;
        if (type !== "attack-roll" && type !== "spell-attack-roll") return;
        const actor = message.actor;
        if (actor?.isOwner && isActorsTurn(actor)) recordAttack(actor);
    });

    Hooks.on("deleteCombat", () => {
        tray.refresh();
        if (!isCombatRunning()) tray.applyRestingState();
    });
}

function isResponsibleGM() {
    return game.users.activeGM?.isSelf ?? game.user.isGM;
}
