import { MODULE_ID, TEMPLATE_ROOT, TABS } from "./constants.js";
import { getSetting, setSetting } from "./settings.js";
import { buildActorContext } from "./actor-data.js";
import * as Ops from "./actor-actions.js";
import { startTargetPick, isPicking, trackTokenDrag, targetToken } from "./targeting.js";
import * as Use from "./use.js";
import * as Bomb from "./alchemical-crossbow.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

import { isCombatRunning } from "./helpers.js";
export { isCombatRunning };

/**
 * The first selected token whose actor this user owns.
 * The GM owns everything; players only get tokens they have Owner permission on.
 */
export function findOwnedControlledToken() {
    return (canvas.tokens?.controlled ?? [])
        .find(t => ["character", "npc"].includes(t.actor?.type) && t.actor.isOwner) ?? null;
}

const CORE_TAB_ORDER = { actions: 10, character: 20 };

const TAB_ICONS = {
    actions: "fa-solid fa-hand-fist",
    character: "fa-solid fa-user-shield"
};

/**
 * The tray: a frameless ApplicationV2 docked to the left edge of #interface.
 * A thin rail (tab buttons + toggle) stays visible while the panel is closed,
 * so the tray always has a native on-screen access point.
 */
export class TriadTray extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "triad-tray",
        tag: "aside",
        classes: ["triad"],
        window: { frame: false, positioned: false },
        actions: {
            switchTab: TriadTray.#onSwitchTab,
            toggleTray: TriadTray.#onToggleTray,
            toggleSection: TriadTray.#onToggleSection,
            toggleSummary: TriadTray.#onToggleSummary,
            openSheet: TriadTray.#onOpenSheet,
            openActor: TriadTray.#onOpenActor,
            rollSave: TriadTray.#onRollSave,
            rollPerception: TriadTray.#onRollPerception,
            rollSkill: TriadTray.#onRollSkill,
            rollInitiative: TriadTray.#onRollInitiative,
            strike: TriadTray.#onStrike,
            strikeDamage: TriadTray.#onStrikeDamage,
            castSpell: TriadTray.#onCastSpell,
            reload: TriadTray.#onReload,
            loadAmmo: TriadTray.#onLoadAmmo,
            bomb: TriadTray.#onBomb,
            pickBomb: TriadTray.#onPickBomb,
            unloadBomb: TriadTray.#onUnloadBomb,
            postToChat: TriadTray.#onPostToChat,
            slotPip: TriadTray.#onSlotPip,
            focusPip: TriadTray.#onFocusPip,
            heroPip: TriadTray.#onHeroPip,
            useItem: TriadTray.#onUseItem,
            systemAction: TriadTray.#onSystemAction,
            pickSkill: TriadTray.#onPickSkill,
            closeSkillPicker: TriadTray.#onCloseSkillPicker,
            increaseCondition: TriadTray.#onIncreaseCondition,
            toggleConditionPicker: TriadTray.#onToggleConditionPicker,
            addCondition: TriadTray.#onAddCondition,
            editHp: TriadTray.#onEditHp,
            actionPip: TriadTray.#onActionPip,
            reactionPip: TriadTray.#onReactionPip,
            endTurn: TriadTray.#onEndTurn,
            addToCombat: TriadTray.#onAddToCombat,
            target: TriadTray.#onTarget,
            toggleFavorite: TriadTray.#onToggleFavorite,
            toggleOption: TriadTray.#onToggleOption,
            recoveryCheck: TriadTray.#onRecoveryCheck,
            sustain: TriadTray.#onSustain,
            tokenConfig: TriadTray.#onTokenConfig,
            rest: TriadTray.#onRest,
            tool: TriadTray.#onTool
        }
    };

    static PARTS = {
        tray: {
            template: `${TEMPLATE_ROOT}/tray.hbs`,
            scrollable: [".triad-body"]
        }
    };

    #tab = "actions";
    /** External panels hosted by the tray (e.g. First Strike's initiative tracker). */
    #docks = new Map();
    /** Utility-bar buttons other modules add for the character on display. */
    #tools = new Map();
    #open = false;
    #dirty = false;
    #expanded = new Set();
    #editingHp = null;
    #pickerOpen = false;
    /** Weapon id whose ammo picker is open. */
    #reloadPicker = null;
    /** Weapon id whose bomb picker is open (Alchemical Crossbow). */
    #bombPicker = null;
    /** Slug of the action whose skill picker is open (Recall Knowledge). */
    #skillPicker = null;
    #actor = null;
    #token = null;

    /** Debounced re-render used by all hooks. */
    refresh = foundry.utils.debounce(() => {
        if (!this.rendered) return;
        if (!this.#open) {
            this.#dirty = true;
            return;
        }
        this.render();
    }, 60);

    get actor() {
        return this.#actor;
    }

    get token() {
        return this.#token;
    }

    get isOpen() {
        return this.#open;
    }

    /** Whether a document change should cause a re-render. */
    isRelevant(actor) {
        return !!actor && !!this.#actor && actor.uuid === this.#actor.uuid;
    }

    /* -------------------------------------------- */
    /*  Visibility                                  */
    /* -------------------------------------------- */

    /**
     * @param {boolean} open
     * @param {object} [options]
     * @param {boolean} [options.byUser]  A choice made by the user: remembered while out of combat.
     */
    setOpen(open, { byUser = false } = {}) {
        if (byUser && !isCombatRunning()) setSetting("openOutOfCombat", open);
        const changed = this.#open !== open;
        this.#open = open;
        if (!open) this.#pickerOpen = false;
        this.applyLayout();
        if (open && (this.#dirty || changed)) {
            this.#dirty = false;
            this.render();
        }
    }

    toggle() {
        this.setOpen(!this.#open, { byUser: true });
    }

    get tab() {
        return this.#tab;
    }

    #isValidTab(tab) {
        return TABS.includes(tab) || this.#docks.has(tab);
    }

    /** Switches to a tab and makes sure the tray is open — used by automation, never closes. */
    focusTab(tab) {
        if (!this.#isValidTab(tab)) return;
        const changed = this.#tab !== tab;
        this.#tab = tab;
        if (!this.#open) return this.setOpen(true);
        if (changed) this.render();
    }

    /* -------------------------------------------- */
    /*  Docks (panels from other modules)           */
    /* -------------------------------------------- */

    /**
     * Gives another module a persistent container inside the tray, shown as its own tab.
     * The element survives tray re-renders, so the module can render into it freely.
     * @param {object} config
     * @param {string} config.id        Tab id, e.g. "initiative"
     * @param {string} config.label     Tooltip (plain text or localization key)
     * @param {string} [config.icon]    Font Awesome classes
     * @param {number} [config.order]   Position in the rail (actions 10, character 20)
     * @param {string} [config.empty]   Text shown while the module renders nothing
     * @returns {HTMLElement}
     */
    registerDock({ id, label, icon = "fa-solid fa-puzzle-piece", order = 50, empty = "" }) {
        const existing = this.#docks.get(id);
        if (existing) return existing.element;
        const element = document.createElement("div");
        element.className = "triad-dock";
        element.dataset.dock = id;
        element.hidden = true;
        this.#docks.set(id, { id, label, icon, order, empty, element });
        this.#mountDocks();
        if (this.rendered) this.render();
        return element;
    }

    hasDock(id) {
        return this.#docks.has(id);
    }

    /**
     * Adds a button to the tray's utility bar for the character on display — the way another module
     * (e.g. Attune) puts its entry point in the tray instead of on the character sheet.
     * @param {object} config
     * @param {string} config.id          Unique id
     * @param {string} config.label       Tooltip (plain text or localization key)
     * @param {string} [config.icon]      Font Awesome classes
     * @param {number} [config.order]     Position among the extra buttons (lower first)
     * @param {(actor: Actor, event: Event) => unknown} config.onClick
     * @param {(actor: Actor) => boolean} [config.visible]  Hide the button for some actors
     */
    registerTool({ id, label, icon = "fa-solid fa-puzzle-piece", order = 50, onClick, visible = null }) {
        if (!id || typeof onClick !== "function") throw new Error(`${MODULE_ID} | registerTool needs an id and an onClick`);
        this.#tools.set(id, { id, label, icon, order, onClick, visible });
        if (this.rendered) this.render();
    }

    hasTool(id) {
        return this.#tools.has(id);
    }

    #toolsFor(actor) {
        return [...this.#tools.values()]
            .filter(tool => {
                try {
                    return tool.visible ? tool.visible(actor) !== false : true;
                } catch (error) {
                    console.warn(`${MODULE_ID} | tool "${tool.id}" visibility check failed`, error);
                    return false;
                }
            })
            .sort((a, b) => a.order - b.order)
            .map(({ id, label, icon }) => ({ id, label, icon }));
    }

    static async #onTool(event, target) {
        const tool = this.#tools.get(target.dataset.tool);
        if (!tool || !this.#actor) return;
        try {
            await tool.onClick(this.#actor, event);
        } catch (error) {
            console.error(`${MODULE_ID} | tool "${tool.id}" failed`, error);
        }
    }

    /** Shows a dot on a dock's tab (e.g. something new to look at). */
    setDockBadge(id, value) {
        const dock = this.#docks.get(id);
        if (!dock || dock.badge === !!value) return;
        dock.badge = !!value;
        if (this.rendered) this.render();
    }

    #mountDocks() {
        if (!this.element) return;
        let layer = this.element.querySelector(":scope > .triad-dock-layer");
        if (!layer) {
            layer = document.createElement("div");
            layer.className = "triad-dock-layer";
            this.element.append(layer);
        }
        for (const dock of this.#docks.values()) {
            if (dock.element.parentElement !== layer) layer.append(dock.element);
        }
    }

    #syncDocks() {
        this.element.dataset.tab = this.#tab;
        for (const dock of this.#docks.values()) dock.element.hidden = dock.id !== this.#tab;
    }

    showTab(tab) {
        if (!this.#isValidTab(tab)) return;
        const sameTab = this.#tab === tab;
        this.#tab = tab;
        if (this.#open && sameTab) return this.setOpen(false, { byUser: true });
        if (this.#open) return this.render();
        this.setOpen(true, { byUser: true });
    }

    /** The state the tray should rest in: open during combat, the user's choice otherwise. */
    restingState() {
        if (isCombatRunning() && getSetting("openOnCombat")) return true;
        return !!getSetting("openOutOfCombat");
    }

    /** Called when combat starts or ends. */
    applyRestingState() {
        this.setOpen(this.restingState());
    }

    /** Selecting one of your tokens during combat brings the tray out. */
    onTokenSelected() {
        if (!isCombatRunning() || !getSetting("openOnCombat")) return;
        if (findOwnedControlledToken()) this.setOpen(true);
    }

    /** Writes width and open/closed state to the document so CSS can lay out the UI. */
    applyLayout() {
        const root = document.documentElement;
        root.style.setProperty("--triad-width", `${getSetting("trayWidth")}px`);
        document.body.classList.add("triad-docked");
        document.body.classList.toggle("triad-open", this.#open);
        document.body.classList.toggle("triad-push", !!getSetting("pushInterface"));
        this.element?.classList.toggle("is-open", this.#open);
        // Lets other modules (Persona's stage) keep clear of the tray.
        Hooks.callAll("triad.layout", { open: this.#open });
    }

    /* -------------------------------------------- */
    /*  Rendering                                   */
    /* -------------------------------------------- */

    _insertElement(element) {
        const existing = document.getElementById(element.id);
        if (existing) existing.replaceWith(element);
        else (document.getElementById("interface") ?? document.body).prepend(element);
    }

    /**
     * Which actor the tray shows:
     *  1. a selected token you own;
     *  2. in combat, your combatant whose turn it is (players only);
     *  3. your assigned character — but only if it has a token on this scene;
     *  4. (players) the first character you own that has a token on this scene.
     * Characters that are not on the current map are never shown.
     */
    #resolveActor() {
        const set = token => {
            this.#actor = token?.actor ?? null;
            this.#token = token ?? null;
        };
        const controlled = findOwnedControlledToken();
        if (controlled) return set(controlled);

        const onScene = actor => actor?.getActiveTokens?.(false, false)?.find(t => t.document?.parent === canvas.scene) ?? null;

        if (!game.user.isGM && isCombatRunning()) {
            const current = game.combat.combatant;
            if (current?.actor?.isOwner && current.token?.object) return set(current.token.object);
        }
        if (getSetting("useAssignedCharacter")) {
            const assigned = onScene(game.user.character);
            if (assigned) return set(assigned);
            if (!game.user.isGM) {
                const owned = (canvas.tokens?.placeables ?? [])
                    .find(t => t.actor?.type === "character" && t.actor.isOwner);
                if (owned) return set(owned);
            }
        }
        set(null);
    }

    async _prepareContext() {
        this.#resolveActor();
        const tabs = [
            ...TABS.map(id => ({ id, label: `TRIAD.Tab.${id}`, icon: TAB_ICONS[id], order: CORE_TAB_ORDER[id] ?? 0 })),
            ...[...this.#docks.values()].map(({ id, label, icon, order, badge }) => ({ id, label, icon, order, badge: !!badge }))
        ]
            .sort((a, b) => a.order - b.order)
            .map(tab => ({ ...tab, active: tab.id === this.#tab }));
        const dock = this.#docks.get(this.#tab);
        const context = {
            tabs,
            isDockTab: !!dock,
            dockEmpty: dock?.empty ?? "",
            isOpen: this.#open,
            isActionsTab: this.#tab === "actions",
            isCharacterTab: this.#tab === "character",
            editingHp: this.#editingHp,
            pickerOpen: this.#pickerOpen,
            reloadPicker: this.#reloadPicker,
            bombPicker: this.#bombPicker,
            fatalError: null,
            actor: null,
            tools: this.#actor ? this.#toolsFor(this.#actor) : []
        };
        if (!this.#actor || dock) return context;

        try {
            context.actor = await buildActorContext({
                actor: this.#actor,
                token: this.#token,
                expanded: this.#expanded,
                collapsed: getSetting("collapsed") ?? {},
                skillPicker: this.#skillPicker
            });
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to read ${this.#actor.name}`, error);
            context.fatalError = `${this.#actor.name}: ${error?.message ?? error}`;
        }
        return context;
    }

    /** A template error must never leave the tray silently empty: re-render with the error shown. */
    async _renderHTML(context, options) {
        try {
            return await super._renderHTML(context, options);
        } catch (error) {
            console.error(`${MODULE_ID} | Template render failed`, error);
            return super._renderHTML({ ...context, actor: null, fatalError: error?.message ?? String(error) }, options);
        }
    }

    _onFirstRender(context, options) {
        super._onFirstRender(context, options);
        this.applyLayout();
        this.element.addEventListener("contextmenu", this.#onContextMenu.bind(this));
        this.element.addEventListener("dragstart", this.#onDragStart.bind(this));
        this.element.addEventListener("pointerdown", this.#onPointerDown.bind(this));
        this.element.addEventListener("pointerover", this.#onOverflowTipIn.bind(this));
        this.element.addEventListener("pointerout", this.#onOverflowTipOut.bind(this));
        this.#mountDocks();
    }

    _onRender(context, options) {
        super._onRender(context, options);
        this.element.classList.toggle("is-open", this.#open);
        this.element.querySelector('[data-action="target"]')?.classList.toggle("is-active", isPicking());
        this.#syncDocks();
        this.#bindHpEditor();
        this.#bindElevationInput();
        this.#bindSuboptionSelects();
    }

    /** Changing a toggle's suboption keeps its current on/off state (always-active ones stay on). */
    #bindSuboptionSelects() {
        for (const select of this.element.querySelectorAll("select[data-suboption]")) {
            select.addEventListener("change", () => {
                const row = select.closest("[data-domain]");
                const always = !row.querySelector('[data-action="toggleOption"]');
                Ops.setRollOption(this.#actor, {
                    ...row.dataset,
                    value: always || row.dataset.checked === "true",
                    suboption: select.value
                });
            });
        }
    }

    #bindElevationInput() {
        const input = this.element.querySelector("input[data-elevation-input]");
        if (!input) return;
        const commit = () => Ops.setElevation(this.#token, input.value);
        input.addEventListener("keydown", event => {
            event.stopPropagation();          // keep Foundry hotkeys (WASD, etc.) out of the field
            if (event.key === "Enter") input.blur();
            if (event.key === "Escape") {
                input.value = this.#token?.document?.elevation ?? 0;
                input.blur();
            }
        });
        input.addEventListener("change", commit);
        input.addEventListener("focus", () => input.select());
        input.addEventListener("click", event => event.stopPropagation());
    }

    #bindHpEditor() {
        const input = this.element.querySelector("input[data-hp-input]");
        if (!input) return;
        input.focus();
        input.select();
        let done = false;
        const commit = async save => {
            if (done) return;
            done = true;
            const field = input.dataset.hpInput;
            this.#editingHp = null;
            if (save) await Ops.updateHitPoints(this.#actor, field, input.value);
            this.render();
        };
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") commit(true);
            if (event.key === "Escape") commit(false);
            event.stopPropagation();
        });
        input.addEventListener("blur", () => commit(true));
    }

    /* -------------------------------------------- */
    /*  Right-click & drag                          */
    /* -------------------------------------------- */

    async #onContextMenu(event) {
        const target = event.target.closest("[data-context]");
        if (!target || !this.#actor) return;
        event.preventDefault();
        const { context, slug, itemId, uuid } = target.dataset;
        switch (context) {
            case "decreaseCondition": return Ops.decreaseCondition(this.#actor, slug);
            case "deleteEffect": return Ops.deleteEffect(this.#actor, itemId);
            case "post": {
                const doc = uuid ? await fromUuid(uuid) : null;
                return doc?.toMessage?.(event);
            }
            case "reaction": return Ops.toggleReaction(this.#actor);
        }
    }

    /**
     * Full-name tooltips for text the tray had to cut with "…" (e.g. "Healing Potion (Moder…").
     * Only shown when the element is actually truncated.
     */
    #overflowTipTarget = null;

    #onOverflowTipIn(event) {
        const el = event.target.closest?.("[data-overflow-tip]");
        if (!el || el === this.#overflowTipTarget) return;
        const truncated = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        if (!truncated || !el.dataset.overflowTip) return;
        this.#overflowTipTarget = el;
        game.tooltip?.activate(el, { text: el.dataset.overflowTip, direction: "UP" });
    }

    #onOverflowTipOut(event) {
        const el = this.#overflowTipTarget;
        if (!el || el.contains(event.relatedTarget)) return;
        this.#overflowTipTarget = null;
        game.tooltip?.deactivate();
    }

    /** Item names drag to the hotbar (native drag-and-drop). */
    #onDragStart(event) {
        const row = event.target.closest?.("[data-drag-uuid]");
        if (!row) return;
        const doc = fromUuidSync(row.dataset.dragUuid);
        const data = doc?.toDragData?.();
        if (data) event.dataTransfer.setData("text/plain", JSON.stringify(data));
    }

    /**
     * Pointer-based drag to a token on the map:
     *  - the crosshair targets the token;
     *  - a Strike/spell/action/consumable icon targets the token, then uses the item.
     * A press without movement stays a normal click.
     */
    #onPointerDown(event) {
        const source = event.target.closest?.("[data-token-drag]");
        if (!source) return;
        if (source.dataset.tokenDrag === "target") {
            return trackTokenDrag(event, {
                icon: "fa-solid fa-crosshairs",
                onDrop: (token, upEvent) => targetToken(token, { additive: upEvent.shiftKey }),
                onMiss: () => ui.notifications.info(game.i18n.localize("TRIAD.Target.Missed"))
            });
        }
        if (!this.#actor) return;
        trackTokenDrag(event, {
            img: source.dataset.img,
            onDrop: async (token, upEvent) => {
                targetToken(token, { additive: upEvent.shiftKey });
                const handler = this.options.actions[source.dataset.action];
                const fn = typeof handler === "function" ? handler : handler?.handler;
                await fn?.call(this, upEvent, source);
            },
            onMiss: () => ui.notifications.info(game.i18n.localize("TRIAD.Target.Missed"))
        });
    }

    /* -------------------------------------------- */
    /*  Action handlers                             */
    /* -------------------------------------------- */

    static #onSwitchTab(event, target) {
        this.showTab(target.dataset.tab);
    }

    static #onToggleTray() {
        this.toggle();
    }

    static async #onToggleSection(event, target) {
        const key = target.dataset.key;
        if (!key) return;
        const collapsed = foundry.utils.deepClone(getSetting("collapsed") ?? {});
        if (collapsed[key]) delete collapsed[key];
        else collapsed[key] = true;
        await setSetting("collapsed", collapsed);
        this.render();
    }

    static #onToggleSummary(event, target) {
        const uuid = target.closest("[data-uuid]")?.dataset.uuid;
        if (!uuid) return;
        if (this.#expanded.has(uuid)) this.#expanded.delete(uuid);
        else this.#expanded.add(uuid);
        this.render();
    }

    static #onOpenSheet(event, target) {
        const uuid = target.closest("[data-uuid]")?.dataset.uuid;
        if (uuid) Ops.openItemSheet(uuid);
    }

    static #onOpenActor() {
        this.#actor?.sheet?.render(true);
    }

    static #onRollSave(event, target) {
        Ops.rollSave(this.#actor, target.dataset.save, event);
    }

    static #onRollPerception(event) {
        Ops.rollPerception(this.#actor, event);
    }

    static #onRollSkill(event, target) {
        Ops.rollSkill(this.#actor, target.dataset.skill, event);
    }

    static #onRollInitiative() {
        Ops.rollInitiative(this.#actor);
    }

    /** Finds row data whether the click came from the row icon or from a control inside the row. */
    static #rowData(target, selector) {
        return target.closest(selector) ?? target.closest(".triad-row")?.querySelector(selector) ?? null;
    }

    /** MAP buttons roll their own variant; the row icon (or a drag) rolls the next one this turn. */
    static #onStrike(event, target) {
        const row = TriadTray.#rowData(target, "[data-strike]");
        if (!row) return;
        const variant = target.dataset.variant !== undefined
            ? Number(target.dataset.variant)
            : Number(row.dataset.nextVariant) || 0;
        return Use.strike(this.#actor, { index: Number(row.dataset.strike), alt: row.dataset.alt, variant }, event);
    }

    static #onStrikeDamage(event, target) {
        const row = TriadTray.#rowData(target, "[data-strike]");
        if (!row) return;
        Ops.rollStrikeDamage(this.#actor, {
            index: Number(row.dataset.strike),
            alt: row.dataset.alt,
            critical: target.dataset.critical === "true"
        }, event);
    }

    static #onCastSpell(event, target) {
        const row = TriadTray.#rowData(target, "[data-spell-id]");
        if (!row) return;
        return Use.cast(this.#actor, {
            entryId: row.dataset.entryId,
            spellId: row.dataset.spellId,
            rank: row.dataset.rank,
            slotId: row.dataset.slotId
        });
    }

    /** One loadable ammo type → load it straight away; otherwise show the ammo picker. */
    static async #onReload(event, target) {
        const weaponId = target.closest("[data-weapon-id]")?.dataset.weaponId;
        if (!weaponId || !this.#actor) return;
        const options = Ops.loadableAmmo(this.#actor, weaponId);
        if (options.length === 1 && this.#reloadPicker !== weaponId) {
            this.#reloadPicker = null;
            return Use.reload(this.#actor, weaponId, options[0].id);
        }
        this.#reloadPicker = this.#reloadPicker === weaponId ? null : weaponId;
        this.render();
    }

    static async #onLoadAmmo(event, target) {
        const weaponId = target.closest("[data-weapon-id]")?.dataset.weaponId;
        if (!weaponId) return;
        this.#reloadPicker = null;
        await Use.reload(this.#actor, weaponId, target.dataset.ammoId, { all: target.dataset.all === "true" });
        this.render();
    }

    /** Always opens the bomb picker: which bomb goes in is the alchemist's choice. */
    static async #onBomb(event, target) {
        const weaponId = target.closest("[data-weapon-id]")?.dataset.weaponId;
        if (!weaponId || !this.#actor) return;
        this.#bombPicker = this.#bombPicker === weaponId ? null : weaponId;
        this.render();
    }

    static async #onPickBomb(event, target) {
        const weaponId = target.closest("[data-weapon-id]")?.dataset.weaponId;
        if (!weaponId) return;
        this.#bombPicker = null;
        await Bomb.loadBomb(this.#actor, weaponId, target.dataset.bombId);
        this.render();
    }

    static async #onUnloadBomb(event, target) {
        const weaponId = target.closest("[data-weapon-id]")?.dataset.weaponId;
        if (!weaponId) return;
        await Bomb.unloadBomb(this.#actor, weaponId);
        this.render();
    }

    static #onPostToChat(event, target) {
        const uuid = target.closest("[data-uuid]")?.dataset.uuid;
        if (uuid) Ops.postToChat(uuid, event);
    }

    static #onSlotPip(event, target) {
        const group = target.closest("[data-slot-number]");
        Ops.setSpellSlots(this.#actor, {
            entryId: group.dataset.entryId,
            slotNumber: group.dataset.slotNumber,
            index: Number(target.dataset.index)
        });
    }

    static #onFocusPip(event, target) {
        Ops.setFocusPoints(this.#actor, Number(target.dataset.index));
    }

    static #onHeroPip(event, target) {
        Ops.setHeroPoints(this.#actor, Number(target.dataset.index));
    }

    static #onUseItem(event, target) {
        const itemId = target.closest("[data-item-id]")?.dataset.itemId;
        if (itemId) return Use.useItem(this.#actor, itemId, event);
    }

    /** Actions that need a skill (Recall Knowledge) open a skill picker instead of rolling. */
    static #onSystemAction(event, target) {
        const slug = target.dataset.slug;
        if (target.hasAttribute("data-needs-skill")) {
            this.#skillPicker = this.#skillPicker === slug ? null : slug;
            return this.render();
        }
        return Use.systemAction(this.#actor, slug, event);
    }

    static async #onPickSkill(event, target) {
        const slug = target.closest("[data-slug]")?.dataset.slug;
        if (!slug) return;
        this.#skillPicker = null;
        this.render();
        return Use.systemAction(this.#actor, slug, event, { statistic: target.dataset.statistic });
    }

    static #onCloseSkillPicker() {
        this.#skillPicker = null;
        this.render();
    }

    static #onIncreaseCondition(event, target) {
        Ops.increaseCondition(this.#actor, target.dataset.slug);
    }

    static #onToggleConditionPicker() {
        this.#pickerOpen = !this.#pickerOpen;
        this.render();
    }

    static async #onAddCondition(event, target) {
        this.#pickerOpen = false;
        await Ops.increaseCondition(this.#actor, target.dataset.slug);
        this.render();
    }

    static #onEditHp(event, target) {
        if (!this.#actor?.isOwner) return;
        this.#editingHp = target.dataset.field;
        this.render();
    }

    static #onActionPip(event, target) {
        Ops.setActionsSpent(this.#actor, Number(target.dataset.index));
    }

    static #onReactionPip() {
        Ops.toggleReaction(this.#actor);
    }

    static #onEndTurn() {
        Ops.endTurn();
    }

    static #onAddToCombat() {
        Ops.addToCombat(this.#token);
    }

    /** Click the crosshair, then click a token. (Dragging the crosshair onto a token works too.) */
    static #onTarget(event, target) {
        startTargetPick(active => {
            this.element?.querySelector('[data-action="target"]')?.classList.toggle("is-active", active);
        });
    }

    static #onToggleFavorite(event, target) {
        const uuid = target.closest("[data-uuid]")?.dataset.uuid;
        if (uuid) return Ops.toggleFavorite(this.#actor, uuid);
    }

    static #onToggleOption(event, target) {
        const row = target.closest("[data-domain]");
        if (!row) return;
        return Ops.setRollOption(this.#actor, {
            ...row.dataset,
            value: row.dataset.checked !== "true",
            suboption: row.querySelector("select[data-suboption]")?.value ?? null
        });
    }

    static #onRecoveryCheck(event) {
        return Ops.rollRecovery(this.#actor, event);
    }

    static #onSustain(event) {
        return Use.sustain(this.#actor, event);
    }

    static #onTokenConfig() {
        Ops.openTokenConfig(this.#token);
    }

    static #onRest() {
        Ops.restForTheNight(this.#actor);
    }
}
