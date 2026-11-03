/**
 * Movement costs actions (players only).
 *
 * PF2e: Stride, Fly, Swim, Climb and Burrow are single actions that move up to the
 * matching Speed; Crawl moves 5 ft; Leap is its own action. So each movement "segment"
 * costs one action and lasts until its distance budget is used up — moving past the
 * budget starts a new segment (one more action). Any other action spent from the tray
 * closes the open segment, so Stride → Strike → move charges a fresh Stride.
 *
 * Foundry V13+ reports each movement through the "moveToken" hook with the measured
 * cost (difficult terrain included) and the movement action of every waypoint.
 * The active GM processes it and writes the turn tracker, like every other turn op.
 */
import { getSetting } from "./settings.js";
import { isCombatRunning, isActorsTurn } from "./helpers.js";
import { turnOp } from "./relay.js";

/** Foundry movement action → what it costs and which Speed limits it. */
const FREE_ACTIONS = new Set(["displace", "blink", "teleport", "travel"]);

function speedValue(actor, type) {
    const modern = actor.system?.movement?.speeds;
    if (modern) return Number(modern[type]?.value) || 0;
    const legacy = actor.system?.attributes?.speed;
    if (type === "land") return Number(legacy?.total ?? legacy?.value) || 0;
    const other = legacy?.otherSpeeds?.find(s => s.type === type);
    return Number(other?.total ?? other?.value) || 0;
}

/**
 * Feet one action of this movement covers.
 * Swim/Climb without a dedicated Speed use the Athletics success distance
 * (the check itself is not rolled here).
 */
export function budgetFor(actor, action) {
    const land = speedValue(actor, "land");
    switch (action) {
        case "crawl": return 5;
        case "step": return 5;
        case "fly": return speedValue(actor, "fly") || land;
        case "burrow": return speedValue(actor, "burrow") || land;
        case "swim": return speedValue(actor, "swim") || 10 + 5 * Math.floor(land / 20);
        case "climb": return speedValue(actor, "climb") || Math.max(5, 5 * Math.floor(land / 20));
        case "jump": return land >= 30 ? 15 : 10;
        default: return land;
    }
}

/** Movement action "walk" and the tray's Stride share a segment; Step only accepts walking/crawling. */
function kindOf(action) {
    return action === "crawl" ? "crawl" : action || "walk";
}

/** Splits a Foundry movement into consecutive per-action pieces. */
function segmentsOf(actor, tokenDoc, movement) {
    const passed = movement?.passed;
    const total = Number(passed?.cost ?? passed?.distance);
    const waypoints = passed?.waypoints ?? [];
    const pieces = [];
    for (const waypoint of waypoints) {
        const cost = Number(waypoint.cost);
        if (!Number.isFinite(cost) || cost <= 0) continue;
        const action = waypoint.action ?? tokenDoc.movementAction;
        if (FREE_ACTIONS.has(action)) continue;
        const kind = kindOf(action);
        const last = pieces.at(-1);
        if (last?.kind === kind) last.cost += cost;
        else pieces.push({ kind, cost, budget: budgetFor(actor, action) });
    }
    // Keep the measured total authoritative; waypoint costs only split it between actions.
    const sum = pieces.reduce((acc, p) => acc + p.cost, 0);
    if (Number.isFinite(total) && total > 0 && sum > 0 && Math.abs(sum - total) > 0.5) {
        for (const piece of pieces) piece.cost *= total / sum;
    }
    // No per-waypoint costs reported: charge the whole measured cost to the token's action.
    if (!pieces.length && Number.isFinite(total) && total > 0) {
        const action = waypoints.at(-1)?.action ?? tokenDoc.movementAction ?? "walk";
        if (!FREE_ACTIONS.has(action)) pieces.push({ kind: kindOf(action), cost: total, budget: budgetFor(actor, action) });
    }
    return pieces;
}

function isResponsibleGM() {
    return game.users.activeGM?.isSelf ?? game.user.isGM;
}

function enabled() {
    return getSetting("trackActions") && getSetting("autoSpendActions") && getSetting("movementCostsActions");
}

/** Runs on every client; only the active GM acts. */
function onMoveToken(tokenDoc, movement, operation, user) {
    if (!isResponsibleGM() || !enabled() || !isCombatRunning()) return;
    const actor = tokenDoc.actor;
    // Players only: a player moved a player-owned creature on its own turn.
    if (!actor || !user || user.isGM || !actor.hasPlayerOwner) return;
    if (!actor.testUserPermission(user, "OWNER") || !isActorsTurn(actor)) return;
    if (game.combat?.combatant?.tokenId && game.combat.combatant.tokenId !== tokenDoc.id) return;

    const method = movement?.method;
    if (method === "undo") return turnOp(actor, { type: "undoMove" });
    if (method === "config" || method === "paste") return;

    const segments = segmentsOf(actor, tokenDoc, movement);
    if (segments.length) turnOp(actor, { type: "move", id: movement.id, segments });
}

export function registerMovementHooks() {
    Hooks.on("moveToken", onMoveToken);
}

/** Tray Stride/Step: the action is paid now and the next movement uses it. */
export function prepayKind(slug) {
    if (slug === "stride") return "walk";
    if (slug === "step") return "step";
    return null;
}

export function prepayBudget(actor, kind) {
    return kind === "step" ? 5 : budgetFor(actor, "walk");
}

