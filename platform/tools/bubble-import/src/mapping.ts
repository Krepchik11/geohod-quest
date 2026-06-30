/**
 * MAPPING (pure): bubble quest + pages -> CtorQuest body.
 *
 * Russian-only; order by Page_number; drop None/Error pages; '11' kept verbatim.
 * Media is INJECTED (ResolveMedia) so the mapping is testable without the fs and
 * the same code path serves both the real run and unit tests.
 */
import { createHash } from 'node:crypto';
import type { CtorQuest, CtorStep, CtorTemplate } from '../../../frontend/lib/constructor-model.ts';
import type { BubblePage, BubblePageType, BubbleQuest } from './types.ts';
import { QUEST_ID_PREFIX } from './config.ts';

/** raw bubble image url -> data-URL, or null when unavailable. Resolver normalizes. */
export type ResolveMedia = (url: string | undefined) => string | null;

export const TEMPLATE_BY_PAGE_TYPE: Partial<Record<NonNullable<BubblePageType>, CtorTemplate>> = {
  Start: 'start',
  Continue: 'continue',
  Question: 'task_answer',
  QuestionNoAnswer: 'task_no',
  Congratulations: 'congrats',
};

/** Pages we never import: the answer-card pool (type null, Page_number 0) and empty Error stubs. */
export const isContentPage = (p: BubblePage): boolean =>
  p.Page_type != null && p.Page_type !== 'Error' && TEMPLATE_BY_PAGE_TYPE[p.Page_type] != null;

export const stepId = (bubblePageId: string): string =>
  'p' + createHash('sha1').update(bubblePageId).digest('hex').slice(0, 8);

export function stripBBCode(s: string | undefined): string {
  return (s ?? '').replace(/\[\/?[a-z][^\]]*\]/gi, '').trim();
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function baseStep(template: CtorTemplate, id: string, name: string): CtorStep {
  return {
    id,
    template,
    name,
    text: '',
    kicker: '',
    title: '',
    prompt: '',
    place: '',
    action: { desc: '', confirmLabel: 'Я на месте' },
    allowNote: false,
    images: {},
    video: null,
    acceptable: [],
    gift: { on: false, coins: 5, narrative: '' },
    hint: { on: false, cost: 5, text: '' },
    nav: { on: false, lat: '', lng: '', label: '' },
  };
}

/** nav is enabled ONLY with finite coords (computeGates errors otherwise). */
function navOf(p: BubblePage): CtorStep['nav'] {
  if (!isNum(p.latitude) || !isNum(p.longitude)) return { on: false, lat: '', lng: '', label: '' };
  return { on: true, lat: String(p.latitude), lng: String(p.longitude), label: p.Place_RU ?? '' };
}

/** One bubble page -> one CtorStep. Assumes isContentPage(page). */
export function pageToStep(page: BubblePage, media: ResolveMedia): CtorStep {
  const tpl = TEMPLATE_BY_PAGE_TYPE[page.Page_type as NonNullable<BubblePageType>]!;
  const s = baseStep(tpl, stepId(page._id), page.Page_name_RU?.trim() || tpl);
  const text = (page.Main_text_RU ?? '').trim();
  const taskImg = media(page.Image_link);

  switch (tpl) {
    case 'start':
      s.kicker = 'Городской квест';
      s.text = text;
      break;
    case 'continue':
      s.text = text;
      if (taskImg) s.images.task = taskImg;
      break;
    case 'task_answer':
      s.text = text;
      s.prompt = page.Question_RU?.trim() || 'Введите ответ';
      s.acceptable = (page.Answer ?? []).slice(); // verbatim, incl. '11'
      if (taskImg) s.images.task = taskImg;
      {
        const h = media(page.Hint_Image);
        if (h) s.images.hint = h; // image-only hint; hint.on stays off (no text/cost in source)
      }
      s.nav = navOf(page);
      break;
    case 'task_no':
      s.text = text;
      s.place = page.Place_RU?.trim() ?? '';
      s.action = { desc: '', confirmLabel: page.Button_text_RU?.trim() || 'Я на месте' };
      s.allowNote = true;
      if (taskImg) s.images.task = taskImg;
      s.nav = navOf(page);
      break;
    case 'congrats':
      s.title = 'Квест пройден!';
      s.text = text;
      break;
  }
  return s;
}

/** Quest pages in canonical play order: content-only, sorted by Page_number. */
export function orderedPages(quest: BubbleQuest, byId: Map<string, BubblePage>): BubblePage[] {
  const ids = quest.Page ?? [];
  return ids
    .map((id) => byId.get(id))
    .filter((p): p is BubblePage => !!p && isContentPage(p))
    .sort((a, b) => (a.Page_number ?? 0) - (b.Page_number ?? 0));
}

export interface ImportMeta {
  bubbleId: string;
  creatorUser: string | null;
  statusQuest: string | null;
  publishOnSite: boolean;
  level: string | null;
  ageLimit: string | null;
  reviewGrade: number | null;
  completedCount: number | null;
}

export type CtorQuestBody = CtorQuest & { _import: ImportMeta };

/** Full quest -> CtorQuest body (+ a non-rendered `_import` provenance stamp). */
export function questToCtorQuest(
  quest: BubbleQuest,
  byId: Map<string, BubblePage>,
  media: ResolveMedia,
): CtorQuestBody {
  const pages = orderedPages(quest, byId);
  const start = pages.find((p) => p.Page_type === 'Start');
  const cover = media(quest.Preview_image) ?? media(start?.Image_link) ?? null;

  return {
    id: QUEST_ID_PREFIX + quest._id,
    meta: {
      title: quest.Quest_name_ru?.trim() || 'Без названия',
      city: start?.Place_RU?.trim() ?? '',
      duration: start?.Duration_RU?.trim() ?? '',
      cover,
      desc: stripBBCode(quest.Summary_of_the_quest_ru),
      price: quest.Price ?? 0,
    },
    steps: pages.map((p) => pageToStep(p, media)),
    versions: [],
    lastSaved: null,
    _import: {
      bubbleId: quest._id,
      creatorUser: quest.creatorUser ?? null,
      statusQuest: quest.statusQuest ?? null,
      publishOnSite: !!quest.Publish_on_the_site,
      level: quest.Quest_level ?? null,
      ageLimit: quest.Age_limit ?? null,
      reviewGrade: quest.reviewGrade ?? null,
      completedCount: quest.completedcount ?? null,
    },
  };
}
