/**
 * Pure GameStep → DesignStep mapper — the single render path from frozen
 * snapshot data to the designed StepView shape (design/player/components.jsx).
 * Every quest flows through here; there are no per-quest display arrays.
 */
import type { GameStep } from './shared-model';
import type { DesignStep } from '../app/player/PlayerComponents';

export function toDesignStep(step: GameStep): DesignStep {
  const rich = step.rich_content;
  const sup = step.supporting;
  const video = step.media?.video;
  const isStart = step.template === 'start';
  return {
    template: step.template,
    title: rich?.title || step.template,
    // The start screen renders place_text as the kicker and main_text as the subtitle.
    kicker: isStart ? rich?.place_text : undefined,
    text: rich?.main_text || '',
    image: step.media?.task || step.media?.character || null,
    video: video ? { dur: video.duration_label || undefined, label: video.caption || undefined } : undefined,
    place: isStart ? undefined : rich?.place_text,
    prompt: rich?.question_prompt,
    button: rich?.button_text || undefined,
    acceptable: step.completion?.acceptable,
    action: sup?.physical_action
      ? {
          desc: sup.physical_action.description || '',
          confirmLabel: sup.physical_action.confirm_label || rich?.button_text,
        }
      : undefined,
    nav: sup?.navigator ?? undefined,
    gift: sup?.gift ?? undefined,
    hint: sup?.hint
      ? { cost: sup.hint.cost_coins, text: sup.hint.reveal_text, image: step.media?.hint ?? null }
      : undefined,
  };
}

/**
 * The finale's «в пути» stat: the gap between two instants, formatted as h:mm.
 * Both players share this one body, and both call it ONCE — when the attempt
 * finishes — then keep the answer. Calling it per render with "now" as the
 * finish is what made a completed quest's own time grow on every reopen
 * (issue #111). Missing instants and a finish that precedes the start (device
 * clock moved) both read 0:00 rather than a negative or a runaway number.
 */
export function elapsedLabel(
  startedAt: string | number | null | undefined,
  finishedAt: string | number | null | undefined,
): string {
  if (startedAt == null || finishedAt == null) return '0:00';
  const from = new Date(startedAt).getTime();
  const to = new Date(finishedAt).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '0:00';
  const minutes = Math.floor(Math.max(0, to - from) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
