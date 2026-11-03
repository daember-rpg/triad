/**
 * Targeting from the tray.
 *
 *  Pick mode — click the crosshair, then click a token on the canvas.
 *  Drag      — press on the crosshair (or on a Strike/spell/action icon), drag over the map
 *              and release on a token. Icons target the token and then use the item.
 *
 * Shift adds to / removes from the current targets instead of replacing them
 * (and keeps pick mode active). Esc or right-click cancels.
 *
 * Dragging is done with pointer events, not HTML drag-and-drop, so it doesn't depend on
 * Foundry's canvas drop pipeline.
 */

const DRAG_THRESHOLD = 6;
let activePick = null;

/* -------------------------------------------- */
/*  Hit testing                                 */
/* -------------------------------------------- */

function clientToCanvas(clientX, clientY) {
    if (typeof canvas.canvasCoordinatesFromClient === "function") {
        return canvas.canvasCoordinatesFromClient({ x: clientX, y: clientY });
    }
    return canvas.stage.worldTransform.applyInverse({ x: clientX, y: clientY });
}

/** Topmost visible token under a canvas-space point. */
function tokenAtPoint(x, y) {
    const tokens = (canvas.tokens?.placeables ?? []).filter(token =>
        token.visible && token.renderable !== false && token.bounds?.contains(x, y)
    );
    if (!tokens.length) return null;
    return tokens.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0) || (a.document.sort ?? 0) - (b.document.sort ?? 0)).at(-1);
}

/** Token under a screen position — only when the pointer is over the map itself, not over UI. */
export function tokenAtClient(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const board = canvas.app?.view ?? document.getElementById("board");
    if (!element || element !== board) return null;
    const point = clientToCanvas(clientX, clientY);
    return tokenAtPoint(point.x, point.y);
}

/** Replace targets with this token, or (additive) toggle it within the current targets. */
export function targetToken(token, { additive = false } = {}) {
    if (!token) return;
    if (additive) token.setTarget(!token.isTargeted, { releaseOthers: false });
    else token.setTarget(true, { releaseOthers: true });
}

/* -------------------------------------------- */
/*  Pick mode (click, then click a token)       */
/* -------------------------------------------- */

export function isPicking() {
    return !!activePick;
}

export function cancelTargetPick() {
    activePick?.();
}

/**
 * @param {(active: boolean) => void} [onChange]  called when pick mode starts/stops
 */
export function startTargetPick(onChange) {
    if (activePick) return cancelTargetPick();
    const view = canvas.app?.view ?? document.getElementById("board");
    if (!view) return;

    const onPointerDown = event => {
        if (event.button === 2) return stop();
        if (event.button !== 0) return;
        const point = clientToCanvas(event.clientX, event.clientY);
        const token = tokenAtPoint(point.x, point.y);
        // Swallow the click so it doesn't also select/deselect tokens on the canvas.
        event.stopImmediatePropagation();
        event.preventDefault();
        if (!token) return stop();
        targetToken(token, { additive: event.shiftKey });
        if (!event.shiftKey) stop();
    };
    const onKeyDown = event => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        stop();
    };

    function stop() {
        view.removeEventListener("pointerdown", onPointerDown, { capture: true });
        document.removeEventListener("keydown", onKeyDown, { capture: true });
        document.body.classList.remove("triad-targeting");
        activePick = null;
        onChange?.(false);
    }

    view.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("keydown", onKeyDown, { capture: true });
    document.body.classList.add("triad-targeting");
    activePick = stop;
    onChange?.(true);
}

/* -------------------------------------------- */
/*  Drag to token                               */
/* -------------------------------------------- */

/**
 * Call from a pointerdown. If the pointer moves past a small threshold it becomes a drag:
 * a ghost follows the cursor, and releasing over a token calls `onDrop(token, event)`.
 * A press without movement is left alone, so the normal click still happens.
 * @param {PointerEvent} event
 * @param {object} options
 * @param {string} [options.img]     image shown in the ghost
 * @param {string} [options.icon]    Font Awesome classes shown in the ghost (when no image)
 * @param {(token: Token, event: PointerEvent) => void} options.onDrop
 * @param {() => void} [options.onMiss]
 */
export function trackTokenDrag(event, { img, icon, onDrop, onMiss }) {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let ghost = null;
    const onMove = moveEvent => {
        if (!ghost) {
            if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
            ghost = document.createElement("div");
            ghost.className = "triad-drag-ghost";
            ghost.innerHTML = (img ? `<img src="${img}" alt="">` : `<i class="${icon ?? "fa-solid fa-crosshairs"}"></i>`)
                + `<span class="triad-drag-ghost__label"></span>`;
            document.body.append(ghost);
            document.body.classList.add("triad-dragging");
        }
        ghost.style.transform = `translate(${moveEvent.clientX + 12}px, ${moveEvent.clientY + 12}px)`;
        const token = tokenAtClient(moveEvent.clientX, moveEvent.clientY);
        ghost.classList.toggle("is-over-token", !!token);
        ghost.querySelector(".triad-drag-ghost__label").textContent = token?.name ?? "";
    };

    const cleanup = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("dragstart", onCancel, true);
    };
    // A native drag or a cancelled pointer ends tracking, so it can never be left dangling.
    const onCancel = () => {
        cleanup();
        ghost?.remove();
        document.body.classList.remove("triad-dragging");
    };

    const onUp = upEvent => {
        cleanup();
        if (!ghost) return; // it was a click
        ghost.remove();
        document.body.classList.remove("triad-dragging");
        // Swallow the click that follows a drag so the source button doesn't also fire.
        const swallow = e => {
            e.stopImmediatePropagation();
            e.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);

        const token = tokenAtClient(upEvent.clientX, upEvent.clientY);
        if (token) onDrop(token, upEvent);
        else onMiss?.();
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("dragstart", onCancel, true);
}
