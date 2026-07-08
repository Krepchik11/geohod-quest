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
