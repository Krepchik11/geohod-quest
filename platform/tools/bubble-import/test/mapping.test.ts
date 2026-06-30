import { describe, expect, it } from 'vitest';
import {
  isContentPage,
  orderedPages,
  pageToStep,
  questToCtorQuest,
  stepId,
  stripBBCode,
  type ResolveMedia,
} from '../src/mapping.ts';
import { computeGates, serializeDraft } from '../../../frontend/lib/constructor-model.ts';
import { readRaw } from '../src/io.ts';
import type { BubblePage, BubbleQuest } from '../src/types.ts';

const noMedia: ResolveMedia = () => null;
const someMedia: ResolveMedia = (u) => (u ? 'data:image/jpeg;base64,/9j/AAAA' : null);
const page = (p: Partial<BubblePage>): BubblePage => ({ _id: 'x', ...p });

describe('page filtering', () => {
  it('keeps content types, drops None/Error', () => {
    expect(isContentPage(page({ Page_type: 'Start' }))).toBe(true);
    expect(isContentPage(page({ Page_type: 'Question' }))).toBe(true);
    expect(isContentPage(page({ Page_type: 'Congratulations' }))).toBe(true);
    expect(isContentPage(page({ Page_type: null }))).toBe(false); // answer-card pool page
    expect(isContentPage(page({ Page_type: 'Error' }))).toBe(false);
  });
});

describe('determinism', () => {
  it('stepId is stable & prefixed', () => {
    expect(stepId('a')).toBe(stepId('a'));
    expect(stepId('a')).not.toBe(stepId('b'));
    expect(stepId('a').startsWith('p')).toBe(true);
  });
  it('stripBBCode strips tags', () => {
    expect(stripBBCode('[b]Hi[/b] there')).toBe('Hi there');
  });
});

describe('pageToStep', () => {
  it('Question -> task_answer keeps answers verbatim incl. "11"', () => {
    const s = pageToStep(
      page({ Page_type: 'Question', Main_text_RU: 'narrative', Question_RU: 'Что это?', Answer: ['ОЧКИ', '11'], Image_link: '//cdn/x.jpg' }),
      someMedia,
    );
    expect(s.template).toBe('task_answer');
    expect(s.text).toBe('narrative');
    expect(s.prompt).toBe('Что это?');
    expect(s.acceptable).toEqual(['ОЧКИ', '11']); // verbatim
    expect(s.images.task).toContain('data:image/jpeg');
  });

  it('nav only enabled with finite coords', () => {
    const withGeo = pageToStep(page({ Page_type: 'Question', latitude: 45.25, longitude: 19.86, Answer: ['x'] }), noMedia);
    expect(withGeo.nav.on).toBe(true);
    expect(withGeo.nav.lat).toBe('45.25');
    const noGeo = pageToStep(page({ Page_type: 'Question', Answer: ['x'] }), noMedia);
    expect(noGeo.nav.on).toBe(false);
  });

  it('QuestionNoAnswer -> task_no with place/confirm/allowNote', () => {
    const s = pageToStep(page({ Page_type: 'QuestionNoAnswer', Place_RU: 'Площадь', Button_text_RU: 'Я тут' }), noMedia);
    expect(s.template).toBe('task_no');
    expect(s.place).toBe('Площадь');
    expect(s.action.confirmLabel).toBe('Я тут');
    expect(s.allowNote).toBe(true);
  });

  it('start carries no per-step image (cover is quest-level)', () => {
    const s = pageToStep(page({ Page_type: 'Start', Image_link: '//cdn/x.jpg', Main_text_RU: 'hi' }), someMedia);
    expect(s.template).toBe('start');
    expect(s.images.task).toBeUndefined();
    expect(s.kicker).toBeTruthy();
  });
});

describe('orderedPages', () => {
  it('sorts by Page_number and drops non-content', () => {
    const pages: BubblePage[] = [
      page({ _id: 'c', Page_type: 'Congratulations', Page_number: 9 }),
      page({ _id: 'pool', Page_type: null, Page_number: 0 }),
      page({ _id: 's', Page_type: 'Start', Page_number: 1 }),
      page({ _id: 'q', Page_type: 'Question', Page_number: 5, Answer: ['x'] }),
      page({ _id: 'err', Page_type: 'Error' }),
    ];
    const byId = new Map(pages.map((p) => [p._id, p]));
    const quest: BubbleQuest = { _id: 'Q', Page: ['c', 'pool', 's', 'q', 'err'] };
    const ordered = orderedPages(quest, byId).map((p) => p._id);
    expect(ordered).toEqual(['s', 'q', 'c']);
  });
});

describe('integration over the real raw archive', () => {
  const { quests, byId } = readRaw();

  it('has 19 quests', () => {
    expect(quests.length).toBe(19);
  });

  for (const q of quests) {
    it(`quest ${q._id} (${q.Quest_name_ru}) maps to a publishable shape`, () => {
      const body = questToCtorQuest(q, byId, noMedia);

      // structure
      expect(body.steps.length).toBeGreaterThan(0);
      expect(body.steps[0]!.template).toBe('start');
      expect(body.steps.at(-1)!.template).toBe('congrats');

      // exactly one start + one congrats
      expect(body.steps.filter((s) => s.template === 'start')).toHaveLength(1);
      expect(body.steps.filter((s) => s.template === 'congrats')).toHaveLength(1);

      // unique step ids (determinism + no collisions)
      expect(new Set(body.steps.map((s) => s.id)).size).toBe(body.steps.length);

      // every answer task has a non-empty acceptable list (computeGates would error otherwise)
      for (const s of body.steps) {
        if (s.template === 'task_answer') expect(s.acceptable.length).toBeGreaterThan(0);
      }

      // the REAL production serializer must accept it and seal positions 0..n-1
      const snap = serializeDraft(body);
      expect(snap.steps).toHaveLength(body.steps.length);
      expect(snap.steps.map((s) => s.position)).toEqual(body.steps.map((_, i) => i));

      // computeGates must not flag anything we didn't intend (only missing task images are allowed,
      // since some legacy task pages genuinely lack art — flagged in report.md, fixable in editor).
      const gates = computeGates(body);
      const unexpected = gates.errors.filter((e) => !/нет комикса «задание»/.test(e.text));
      expect(unexpected).toEqual([]);
    });

    it(`quest ${q._id} transform is deterministic`, () => {
      expect(questToCtorQuest(q, byId, noMedia)).toEqual(questToCtorQuest(q, byId, noMedia));
    });
  }
});
