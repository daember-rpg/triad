/**
 * GM relay for writes players can't make themselves in this world
 * (combat turn changes, turn-tracker flags). Players send a request through
 * socketlib; the active GM's client checks ownership and performs the write.
 * The GM — or any client when socketlib is missing — writes directly.
 */
import { MODULE_ID } from "./constants.js";
import { reduceMove, reduceUndoMove, reducePrepay, closeMove } from "./turn-state.js";

let socket = null;

/** Registers on first use too, in case "socketlib.ready" fired before this module loaded. */
export function ensureSocket() {
    if (socket) return socket;
    if (typeof socketlib === "undefined") return null;
    try {
        socket = socketlib.registerModule(MODULE_ID);
        socket.register("turnOp", gmTurnOp);
        socket.register("endTurn", gmEndTurn);
        return socket;
    } catch (error) {
        console.error(`${MODULE_ID} | socketlib registration failed`, error);
        socket = null;
        return null;
    }
}

Hooks.once("socketlib.ready", () => ensureSocket());

function relayAvailable() {
    return !game.user.isGM && !!ensureSocket() && !!game.users.activeGM;
}

/* -------------------------------------------- */
/*  Turn state: operations, not snapshots       */
/* -------------------------------------------- */

/**
 * The turn tracker is changed by small operations applied to the *latest* state,
 * one at a time per actor. Sending whole snapshots let near-simultaneous writes
 * (spend an action + count an attack) overwrite each other.
 *
 * Ops: { type: "spend", count } | { type: "setSpent", index } | { type: "reaction" }
 *      | { type: "toggleReaction" } | { type: "attack" } | { type: "reset" }
 *      | { type: "move", id, segments } | { type: "undoMove" } | { type: "prepay", kind, budget }
 * Spending an action (or attacking) closes the open movement segment — charging it if it was
 * still pending — so the next move is a new Stride.
 */
export function reduceTurn(state, op) {
    const spent = Number(state.spent) || 0;
    switch (op?.type) {
        case "spend": {
            const closed = closeMove(state);
            return { ...closed, spent: Math.min(5, closed.spent + (Number(op.count) || 0)) };
        }
        case "setSpent": {
            // Clicking pip N sets N+1 spent, or N when it was already N+1 (toggle).
            const target = (Number(op.index) || 0) + 1;
            return { ...state, spent: spent === target ? target - 1 : target };
        }
        case "reaction": return { ...state, reaction: true };
        case "toggleReaction": return { ...state, reaction: !state.reaction };
        case "attack": return { ...closeMove(state), attacks: (Number(state.attacks) || 0) + 1 };
        case "move": return reduceMove(state, op);
        case "undoMove": return reduceUndoMove(state);
        case "prepay": return reducePrepay(state, op);
        case "reset": return { spent: 0, reaction: false, attacks: 0, move: null, moveLog: [] };
        default: return state;
    }
}

const queues = new Map();

/** Applies ops for the same actor strictly in order, each on top of the previous result. */
function applyQueued(actor, op) {
    const key = actor.uuid;
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
        const state = actor.getFlag(MODULE_ID, "turn") ?? {};
        const updated = reduceTurn(state, op);
        if (JSON.stringify(updated) === JSON.stringify(state)) return;
        await actor.update({ [`flags.${MODULE_ID}.turn`]: updated });
    });
    queues.set(key, next);
    next.finally(() => {
        if (queues.get(key) === next) queues.delete(key);
    });
    return next;
}

/* -------------------------------------------- */
/*  Public: called from the tray                */
/* -------------------------------------------- */

/** Changes the turn tracker ({ spent, reaction, attacks }) of an actor. */
export async function turnOp(actor, op) {
    if (!actor) return;
    if (relayAvailable()) return socket.executeAsGM("turnOp", actor.uuid, op, game.user.id);
    return applyQueued(actor, op);
}

/** Ends the current turn. Players may only end a turn whose combatant they own. */
export async function requestEndTurn() {
    const combat = game.combat;
    if (!combat) return;
    if (relayAvailable()) return socket.executeAsGM("endTurn", combat.id, game.user.id);
    return combat.nextTurn();
}

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

async function gmTurnOp(actorUuid, op, userId) {
    const actor = await fromUuid(actorUuid);
    const user = game.users.get(userId);
    if (!actor || !user || !actor.testUserPermission(user, "OWNER")) return;
    await applyQueued(actor, op);
}

async function gmEndTurn(combatId, userId) {
    const combat = game.combats.get(combatId);
    const user = game.users.get(userId);
    const actor = combat?.combatant?.actor;
    if (!combat || !user || !actor?.testUserPermission(user, "OWNER")) return;
    await combat.nextTurn();
}
