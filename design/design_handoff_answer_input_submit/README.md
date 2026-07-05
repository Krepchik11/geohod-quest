# Handoff: Quest answer input — reachable submit under the keyboard (direction 1a)

## Overview
On the quest player's **answer step** (`task_answer`), tapping the answer field raises the
on‑screen keyboard and the **«Ответить» submit button disappears behind it**. The player has
no way to submit without first dismissing the keyboard to hunt for the button.

This handoff implements **direction "1a — inline submit"**: the field and its submit share **one
row**, and the answer is wrapped in a real `<form>` so the keyboard's own action key submits.
It is a **CSS + markup change with no keyboard‑listener JavaScript**.

It also includes an optional **Part B** that extends the same guarantee to the two other places
with the identical defect (the «Я на месте» note field and the "Сообщить об ошибке" report
sheet), which — being multi‑line `<textarea>`s — cannot use the inline/Enter trick.

---

## Root cause (read before implementing)
This is **one class of bug**, not three unrelated ones. Fix the structure, not each symptom.

- The answer action bar is **non‑sticky** but the **submit `<button>` is stacked _below_ the
  `<input>`**, inside a frame that is `overflow:hidden; height:100dvh`.
- The route sets `interactiveWidget: 'resizes-content'` (`app/quest/[questId]/page.tsx`). This is
  **honored on Android** (the layout viewport shrinks, so a bottom bar lands above the keyboard)
  but **ignored on iOS Safari**, which only changes the _visual_ viewport.
- On iOS the browser therefore lifts the **focused field** to just above the keyboard — and
  **everything below it in source order (the submit button) is pushed behind the keyboard.**
- The existing code comment claims the non‑sticky bar "accommodates" iOS. It does not: a control
  positioned _below_ the field can never survive, because the field is what gets scrolled into view.

**The principle of the fix:** the submit affordance must **share the field's row** (single‑line
inputs) or **live in a layer that the layout already keeps above the keyboard** (multi‑line). For
1a we use the row approach — the browser's native "scroll focused element into view" then lifts
the field _and_ its submit together, on **both** platforms, with no JS.

> Note on `interactiveWidget`: **leave it as `'resizes-content'`.** It correctly fixes Android and
> is harmless on iOS. Do not switch to a JS visualViewport scheme for the answer field — that was
> evaluated (direction "1b") and rejected as the most failure‑prone approach for the least gain.

---

## About the design files
`answer-input-ux-simulator.dc.html` in this folder is a **design reference** — an interactive
simulator (built in HTML) that recreates the current player and the proposed fix, with a
simulated keyboard and an iOS/Android physics toggle. **It is not production code to copy.** It
runs inside the design tool (it loads `support.js`); use it to _see_ the intended behavior. The
production change is the diff specified below, applied to the existing Next.js + React codebase
using its established patterns.

## Fidelity
**High‑fidelity.** The fix reuses the existing "Бумага" paper design system verbatim — the same
CSS custom properties, the same `.p-input` / button treatment, and the existing `PArrow` icon.
No new colors, fonts, or tokens are introduced. Apply the exact values below.

---

## PART A — the answer field (required; fixes the reported bug)

### A1 · `app/player/PlayerComponents.tsx` — `task_answer` branch

**Find this block** (inside `StepView`, the `if (step.template === "task_answer")` branch):

```tsx
  if (step.template === "task_answer") {
    const val = stateIn.answer || "";
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        {stateIn.hintRevealed ? (
          <div className="p-hintbox">
            <PCoin size={16} />
            <div><b>Подсказка</b> {typeof step.hint === 'string' ? step.hint : step.hint?.text}</div>
          </div>
        ) : null}
        {stateIn.wrong ? <p className="p-wrong"><PWarn />{copy?.wrong1 || "Неверно. Попробуйте ещё раз."}</p> : null}
        {/* Non-sticky bar: the input must scroll into view above the mobile
            keyboard, not stay pinned to the bottom of the dynamic viewport. */}
        <div className="p-actions p-actions--field">
          <input
            className={"p-input" + (stateIn.wrong ? " p-input--wrong" : "")}
            placeholder={step.prompt || "Введите ответ"}
            value={val}
            onChange={(e) => h.answer && h.answer(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && h.submit) h.submit(val); }}
          />
          <button className="p-btn p-btn--solid" type="button" onClick={() => h.submit && h.submit(val)}>{copy?.submit || "Ответить"}</button>
        </div>
      </div>
    );
  }
```

**Replace it with:**

```tsx
  if (step.template === "task_answer") {
    const val = stateIn.answer || "";
    const canSubmit = val.trim().length > 0;
    return (
      <div className="p-stepbody">
        <MediaBlock image={step.image} imageLabel={step.imageLabel} />
        <p className="p-text">{step.text}</p>
        {stateIn.hintRevealed ? (
          <div className="p-hintbox">
            <PCoin size={16} />
            <div><b>Подсказка</b> {typeof step.hint === 'string' ? step.hint : step.hint?.text}</div>
          </div>
        ) : null}
        {stateIn.wrong ? <p className="p-wrong"><PWarn />{copy?.wrong1 || "Неверно. Попробуйте ещё раз."}</p> : null}
        {/* Inline submit: the field and its submit share ONE row, so the browser's
            native "scroll focused field into view" lifts BOTH above the on-screen
            keyboard (iOS included). The <form> + enterKeyHint makes the keyboard's
            own action key («Отпр.») submit, and onSubmit respects IME composition. */}
        <form
          className="p-actions p-actions--field"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && h.submit) h.submit(val);
          }}
        >
          <input
            className={"p-input" + (stateIn.wrong ? " p-input--wrong" : "")}
            name="answer"
            placeholder={step.prompt || "Введите ответ"}
            value={val}
            onChange={(e) => h.answer && h.answer(e.target.value)}
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-label={step.prompt || "Введите ответ"}
          />
          <button
            className="p-submit"
            type="submit"
            disabled={!canSubmit}
            aria-label={copy?.submit || "Ответить"}
          >
            <PArrow />
          </button>
        </form>
      </div>
    );
  }
```

What changed and why:
- `<div>` → `<form onSubmit>`: the on‑screen keyboard's action key now submits natively, and
  Enter on a single‑field form submits the same way.
- **Removed the manual `onKeyDown` Enter handler.** It also fixed a latent bug: that handler fired
  on `Enter` even **mid‑IME‑composition** (e.g. predictive/compose input), submitting a partial
  value. Native form submission does not.
- Submit button is now a **square icon button** (`.p-submit`) using the existing `PArrow` glyph,
  on the **same row** as the field. `aria-label` keeps it accessible without visible text.
- `enterKeyHint="send"` labels the iOS/Android action key as submit (shows «Отпр.»).
- `autoCapitalize/Correct/Complete="off"` + `spellCheck={false}`: the answer is matched by
  `isAnswerCorrect` (`lib/shared-model`); autocorrect must not silently mutate what the player typed.
- `disabled={!canSubmit}` dims the button on an empty field; the existing
  `handleAnswerSubmit` guard (`if (!value.trim()) return;`) remains the source of truth.

`PArrow` is already exported in this same file — no new import needed.

### A2 · `app/styles/player-paper.css` — make the field bar a row, add `.p-submit`

**Find:**

```css
/* task_answer keeps its input+submit in normal flow (not sticky) so a focused
   field scrolls above the on-screen keyboard instead of being pinned behind it. */
.p-actions--field { position: relative; }
.p-actions--field::before { display: none; }
```

**Replace with:**

```css
/* task_answer keeps its input+submit in normal flow (not sticky) so a focused
   field scrolls above the on-screen keyboard. The submit shares the field's ROW,
   so it rides the same scroll-into-view and is never left behind the keyboard
   (the iOS failure of the old stacked layout). */
.p-actions--field {
  position: relative;
  flex-direction: row;
  align-items: stretch;
  gap: 10px;
  margin: 0;            /* it is now a <form>; cancel UA form margin */
}
.p-actions--field::before { display: none; }

/* Square inline submit — ink-on-paper, matches the 54px input height. */
.p-submit {
  flex: none;
  width: 56px;
  align-self: stretch;
  display: grid;
  place-items: center;
  background: var(--p-ink);
  color: var(--p-bg);
  border: none;
  border-radius: var(--p-btn-radius);
  cursor: pointer;
  transition: background .12s ease, opacity .12s ease, transform .12s ease;
}
.p-submit svg { width: 20px; height: 20px; }
.p-submit:hover { background: #2c1f1f; }
.p-submit:active { transform: translateY(1px); }
.p-submit:disabled { opacity: .4; cursor: default; }
.p-submit:disabled:active { transform: none; }
```

The base `.p-actions` already provides `display:flex`, `gap`, and `margin-top:auto` (floats the bar
to the bottom of the step). `.p-actions--field` only overrides direction → row and keeps it
non‑sticky (`position:relative`), which is exactly what lets the focused row scroll up on iOS.

**Optional polish** — add to the existing `.p-input` rule so the focus scroll leaves a small gap
above the keyboard:

```css
.p-input { /* …existing… */ scroll-margin-bottom: 16px; }
```

### Part A acceptance criteria
- iOS Safari: focus the answer field → the field **and** an arrow submit are both visible directly
  above the keyboard. Tapping the keyboard's «Отпр.» key submits. The page never needs scrolling
  to reach submit.
- Android Chrome: same — field + submit above the keyboard; action key submits.
- Empty field: submit is dimmed and does nothing (Enter/«Отпр.» also no‑op).
- Wrong answer still shows the red border + «Неверно…»; revealed hint still renders above the field.
- Correct answer advances exactly as before (no change to `handleAnswerSubmit` / matcher).

---

## PART B — the rest of the class: note + report sheet (recommended)

These two are **multi‑line `<textarea>`s**, so Enter inserts a newline and submit can't sit on the
field's row — the 1a trick does not apply. Their action lives in a **sticky** bar / modal that the
iOS keyboard still overlays. The minimal robust fix is one tiny hook that exposes the keyboard
height as a CSS variable; the sticky bar / sheet then offsets by it. On Android the value stays ~0
(the layout already resized), so it is a no‑op there.

> Priority: the note field is **optional** (a private memo), so its hidden button is a minor
> annoyance; the report sheet's «Отправить» is more important. Ship Part A first; Part B closes
> the class.

### B1 · New file `app/quest/useKeyboardInset.ts`

```ts
'use client';
import { useEffect } from 'react';

/**
 * Publishes the on-screen keyboard's occluded height as the CSS var `--kb-inset`
 * on <html>. iOS Safari ignores `interactiveWidget: 'resizes-content'`, so sticky
 * bars / modals near the bottom are overlaid by the keyboard. The visualViewport
 * gives the real occluded height on both platforms; Android (already resized)
 * reports ~0, so consumers that add `bottom: var(--kb-inset)` are no-ops there.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      root.style.setProperty('--kb-inset', `${Math.round(inset)}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--kb-inset');
    };
  }, []);
}
```

### B2 · `app/quest/QuestPlayerClient.tsx` — call the hook once

Add the import and call it at the top of the `QuestPlayerClient` component body (alongside the
other hooks), so the variable is live whenever the player is mounted:

```ts
import { useKeyboardInset } from './useKeyboardInset';
// …inside QuestPlayerClient(...) {
useKeyboardInset();
```

### B3 · `app/styles/player-paper.css` — consume the inset

```css
:root { --kb-inset: 0px; }

/* Lift sticky action bars and modal sheets above the keyboard on iOS; no-op on
   Android (where --kb-inset stays ~0 because the layout already resized). Scoped
   to the real player frame so the constructor's fixed-size previews are untouched. */
.player-shell .pframe .p-actions { bottom: var(--kb-inset); }
.player-shell .pframe .p-overlay { padding-bottom: calc(24px + var(--kb-inset)); }
```

`.p-actions` is `position:sticky; bottom:0`, so adding `bottom: var(--kb-inset)` raises it. The
answer step's `.p-actions--field` is `position:relative`, so `bottom` has no effect there — Part A
already owns it. Button‑only steps open no keyboard, so their inset is 0.

### Part B acceptance criteria
- iOS Safari, `task_no` with a note: focus the note → the «Я на месте» bar sits above the keyboard.
- iOS Safari, report sheet ("Сообщить об ошибке"): focus the textarea → «Отправить» stays visible.
- Android: behavior unchanged from today (still correct).

---

## Why not the alternatives
- **JS visualViewport bar for the answer too (direction 1b):** most keyboard‑listener code, plus
  iOS keyboard‑animation jank and Android double‑resize edge cases — rejected for the single‑line
  field, which 1a fixes with zero JS. (Part B uses a _read‑only_ inset variable, not a moving bar.)
- **Switching `interactiveWidget` away from `resizes-content`:** would regress Android; iOS ignores
  it regardless.

## Design tokens (all pre‑existing in `player-paper.css` — do not invent)
- Ink (submit bg, text): `--p-ink` = `#3E2C2C`; hover `#2c1f1f`
- Paper bg / on‑ink text: `--p-bg` = `#FBF1E5`
- Field bg: `--p-card` = `#FFF9F0`; border `--p-line` = `rgba(62,44,44,.28)`
- Focus / wrong / accent: `--p-accent` = `#A33B2A`
- Corner radius: `--p-btn-radius` = `0px` (square — intentional)
- Input height `54px`; submit width `56px`, height = input (stretch); icon `20px`
- Body font `--p-body` (Inter); input `font-size:16px` (prevents iOS focus zoom — keep ≥16px)

## Accessibility
- Icon‑only submit carries `aria-label` (= «Ответить»); the field carries `aria-label` (= its prompt).
- `enterKeyHint="send"` improves the on‑screen action‑key affordance.
- Submit `disabled` state is conveyed natively; the dimming meets the paper palette.
- Verify with VoiceOver (iOS) and TalkBack (Android): field announces its prompt, button announces "Ответить, кнопка".

## Testing checklist
- [ ] iOS Safari (real device or simulator): field + arrow submit above keyboard; «Отпр.» submits.
- [ ] Android Chrome: same.
- [ ] Hardware/Bluetooth keyboard + on‑screen: Enter submits; not mid‑composition (IME).
- [ ] Narrow viewport (≤320px wide): field remains comfortably wide next to the 56px submit.
- [ ] Empty field: submit dimmed, no submit on tap/Enter.
- [ ] Wrong answer → red border + message; revealed hint still shows; correct answer advances.
- [ ] Constructor preview / test‑player (`StepView` is shared) renders the new row correctly.
- [ ] (Part B) note bar and report sheet reachable above the keyboard on iOS.

## Files touched
- `app/player/PlayerComponents.tsx` — `task_answer` branch (Part A).
- `app/styles/player-paper.css` — `.p-actions--field` + new `.p-submit` (Part A); `--kb-inset` consumers (Part B).
- `app/quest/useKeyboardInset.ts` — **new** (Part B).
- `app/quest/QuestPlayerClient.tsx` — call `useKeyboardInset()` (Part B).
- `app/quest/[questId]/page.tsx` — **no change** (`interactiveWidget: 'resizes-content'` stays).

## Reference
- `answer-input-ux-simulator.dc.html` (this folder) — interactive before/after simulator with a
  simulated keyboard and iOS/Android toggle. Design reference only; runs in the design tool.
