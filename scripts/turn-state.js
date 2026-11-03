/**
 * Pure movement reducers for the turn tracker (no Foundry access, unit-testable).
 *
 * A movement "segment" is one action of movement: { kind, used, budget, paid } in ft.
 * The action is charged when the segment reaches its budget (Speed), or when the segment
 * closes early — another action is spent, an attack is made, the movement type changes,
 * or a new segment starts. Until then it shows as a pending pip on the tracker.
 */

const EPSILON = 0.01;
const cap = n => Math.min(5, n);

function isFull(seg) {
    return seg.used >= seg.budget - EPSILON;
}

/** Charges the open segment if it was never paid. Returns the new spent count. */
function settle(seg, spent) {
    return seg && !seg.paid ? spent + 1 : spent;
}

/** Pure: closes the open movement segment (paying it if pending). Used by every non-move op. */
export function closeMove(state) {
    const spent = settle(state.move, Number(state.spent) || 0);
    return { ...state, spent: cap(spent), move: null };
}

/** Number of actions the open segment will cost but hasn't charged yet (0 or 1). */
export function pendingMoveActions(state) {
    return state?.move && !state.move.paid ? 1 : 0;
}

/**
 * Pure: applies one movement to the turn state.
 * @param {object} state  flags.triad.turn
 * @param {{id: string, segments: {kind: string, cost: number, budget: number}[]}} op
 */
export function reduceMove(state, op) {
    const spentBefore = Number(state.spent) || 0;
    let spent = spentBefore;
    const segBefore = state.move ?? null;
    let seg = segBefore ? { ...segBefore } : null;

    for (const { kind, cost, budget } of op.segments ?? []) {
        let remaining = Number(cost) || 0;
        if (!(remaining > 0) || !(budget > 0)) continue;
        const continues = seg && !isFull(seg)
            && (seg.kind === kind || (seg.kind === "step" && (kind === "walk" || kind === "crawl")));
        if (continues) {
            const take = Math.min(remaining, seg.budget - seg.used);
            seg.used += take;
            remaining -= take;
            if (isFull(seg) && !seg.paid) {
                spent += 1;
                seg.paid = true;
            }
        }
        while (remaining > EPSILON) {
            spent = settle(seg, spent);
            const take = Math.min(remaining, budget);
            seg = { kind, used: take, budget, paid: false };
            remaining -= take;
            if (isFull(seg)) {
                spent += 1;
                seg.paid = true;
            }
        }
    }

    const charged = spent - spentBefore;
    const log = [...(state.moveLog ?? []), { id: op.id, charged, seg: segBefore }].slice(-10);
    return { ...state, spent: cap(spent), move: seg, moveLog: log };
}

/** Pure: reverts the most recent movement (Foundry's movement undo). */
export function reduceUndoMove(state) {
    const log = [...(state.moveLog ?? [])];
    const last = log.pop();
    if (!last) return state;
    return {
        ...state,
        spent: Math.max(0, (Number(state.spent) || 0) - (last.charged || 0)),
        move: last.seg ?? null,
        moveLog: log
    };
}

/** Pure: the tray's Stride/Step paid an action up front — open that segment, already paid. */
export function reducePrepay(state, op) {
    const closed = closeMove(state);
    return {
        ...closed,
        spent: cap((Number(closed.spent) || 0) + 1),
        move: { kind: op.kind, used: 0, budget: Number(op.budget) || 0, paid: true }
    };
}
