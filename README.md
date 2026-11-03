# Triad — PF2e play tray (Alpha)

A left-side tray for **Pathfinder 2e** on Foundry VTT V13/V14. Players and GMs use their character's most common options without opening the sheet.

## Installation
In Foundry: **Add-on Modules → Install Module**, paste this manifest URL and click Install:

```
https://github.com/daember-rpg/triad/releases/latest/download/module.json
```

Requires the **pf2e** system. **socketlib** is recommended (players' End Turn and action pips go through the GM).

## Access
- **Rail** on the left screen edge (always visible): Actions tab, Character tab, open/close.
- **Scene control** button in the Token controls (fist icon).
- **Keybindings** (editable in Configure Controls): `Shift+E` toggle, `Alt+A` Actions tab, `Alt+C` Character tab.
- API: `game.triad.api.open() / close() / toggle()`.

## When it opens
- **Combat started:** the tray opens for everyone, and selecting one of your tokens during combat brings it out again (setting *Open when combat starts*).
- **Out of combat:** it stays the way each user left it (remembered per client). When combat ends it returns to that choice.
- **Ownership:** the tray only follows tokens you own. The GM owns everything; players only see their own tokens.
- **Which character (no selection):** your combatant whose turn it is, then your assigned character, then any character you own — but only characters with a token on the current map.

## Actions tab
- Header: portrait (wound overlay by HP), level, name, ancestry/class, HP bar (click to edit — accepts `12`, `+5`, `-7`), temp HP, held shield HP.
- Stat strip: AC, Perception, Fort/Ref/Will (click to roll). Hero points, Dying/Wounded/Doomed.
- **Turn tracker** (in combat): 3 action pips + reaction, adjusted for Quickened/Slowed; refreshed by the GM at each turn start. Using Strikes, spells, actions, reloads or Sustain from the tray spends their action cost automatically (setting). Roll Initiative / End Turn.
- **Movement spends actions** (players only, setting *Movement spends actions*): each Stride costs one action, charged the moment the distance reaches the Speed (Speed 30 → at 30 ft), or when another action is used after a shorter Stride. While a Stride is in progress its pip shows dashed and the tracker reads "Stride 15 / 30 ft". Fly, Swim, Climb and Burrow use their own Speed (Foundry's movement action on the ruler); without a Swim/Climb Speed the Athletics success distance is used (10 ft + 5 per 20 ft of Speed / 5 ft per 20 ft), Crawl 5 ft, Leap 10–15 ft. Difficult terrain counts through Foundry's measured cost. Undoing a move refunds it. Stride/Step from the tray pay up front. Teleports and GM-moved tokens never cost actions.
- **Dying**: a Recovery Check button appears in the header. **Sustaining**: sustained spell effects are listed with a Sustain button.
- Conditions & effects: click increases a condition, right-click decreases; effects open on click, right-click removes. `+` opens a condition picker.
- **Basic actions** grid driven by the world setting (PF2e action slugs: `stride, seek, grapple, raise-a-shield…`). Recall Knowledge opens a skill picker (its skills + Lores); with an NPC targeted, the skills that identify it are highlighted.
- **Options**: the sheet's roll-option toggles (Sorcerous Potency, Champion's Aura, Hunted Prey precision, Deadly Aim…) as switches, with their suboption dropdowns — same call as the sheet (`actor.toggleRollOption`).
- **Favorites**: pin any Strike, spell, action or consumable (expand it → *Add to favorites*); pinned rows appear at the top.
- **Drag to token**: drag a Strike/spell/action/consumable icon onto a token on the map to target it and use it in one move.
- **Strikes** with three MAP buttons (the next one this turn is highlighted — attack rolls from the tray or the sheet are counted; the icon rolls the next MAP), damage and critical (thrown/combination alt usages included). Weapons with Reload show a Reload line (loaded/capacity, ammo name); one ammo type loads directly, several open an ammo picker (+1 or load all). Same behaviour as PF2e's own reloader, including the Interact (Reload) chat card in combat.
- **Spells** by entry and rank via `entry.getSheetData()`: a line under each name with range · area · duration · defense, and the full list (cast time, range, area, targets, defense, duration, cost, requirements, traits) when expanded; cast (icon or wand button) with slot consumption, post to chat without casting (speech-bubble button), spontaneous slot pips, prepared expended state, focus points.
- **Actions & Reactions** (action/feat items with an action cost): ▶ uses the ability through `game.pf2e.rollItemMacro` — the chat card carries the area template, save and damage links for everyone (e.g. Breath Weapon); 💬 posts it without using it.
- **Consumables** (quantity, uses) via `item.consume()`.
- **Skills** with proficiency rank.
- Token utility: **Target** (click the crosshair then click a token, or drag the crosshair onto a token; Shift adds/removes and keeps picking; Esc/right-click cancels), elevation field (GM only), add to combat, token config, open sheet.
- Names cut with “…” show the full name on hover.
- Click an item name to expand its description; right-click the icon posts it to chat; rows drag to the hotbar.

## Players and permissions
End Turn and the action/reaction pips are written by the active GM's client as small queued operations (spend, attack, reaction…) applied to the latest state, so simultaneous updates never overwrite each other — through **socketlib** (the GM checks that the player owns that combatant/actor). This works even in worlds where direct combat writes from players are rejected. Requires socketlib and a GM online.

## Character tab
Identity cards (ancestry, heritage, class, background, deity), attribute modifiers, Class DC, speeds, focus points, senses, immunities/resistances/weaknesses, languages, NPC traits, skills, Rest for the Night.

## Structure
```
scripts/
  main.js           hooks, keybindings, scene control, live refresh
  constants.js      MODULE_ID and static tables
  settings.js       settings registration
  helpers.js        template registration + small pure helpers
  actor-data.js     PF2e actor -> template context (read-only)
  actor-actions.js  every write/roll the tray performs
  tray.js           ApplicationV2 tray (rendering + action routing)
  movement.js       moveToken hook: movement → Stride/Fly/Swim actions
  turn-state.js     pure movement reducers for the turn tracker
  relay.js          GM relay (socketlib) for End Turn and turn-tracker writes made by players
  use.js            use Strikes/spells/items and spend actions (shared by clicks and drags)
  targeting.js      crosshair pick mode + pointer drag-to-token
templates/          tray.hbs + partials/
styles/triad.css    Embermark design language
lang/               en
```

## Credits
Design, UI and concept by **Fernando Melo** (Hello Melo Design).
Developed with Claude (Anthropic).

Thanks to the authors of **CRUX**, whose open-source code was a helpful reference for the PF2e system APIs.

## Integration API (docks)
Other modules can host a panel inside the tray as its own tab:
```js
Hooks.on("triad.ready", api => {
  const host = api.registerDock({ id: "initiative", label: "Initiative", icon: "fa-solid fa-dice-d20", order: 30, empty: "No active encounter." });
  host.appendChild(myElement);   // the element survives Triad re-renders
});
```
`api.focusTab(id)` opens the tray on a tab; `api.hasDock(id)` checks registration; `api.setDockBadge(id, true)` shows a dot on that tab. The `triad.layout` hook fires whenever the tray opens or closes, so overlays can keep clear of it.

> **Note:** Persona and First Strike are companion modules that are **still in development** and not publicly released yet. Triad works fully on its own; the integrations below take effect once they are installed.

**Persona** docks itself as a tab (masks icon) with a dot when a player has something new to look at.

**First Strike 1.1.0+** docks itself into the Initiative tab. When an encounter begins, everyone's tray opens on Initiative to roll; a player's tray switches to Actions when their own turn starts. Triad's Roll Initiative button uses First Strike's GM relay.
