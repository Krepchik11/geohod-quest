import type { PublishedQuestWire } from './api';
import { AGE_TARGET_LABEL, COMPLEXITY_LABEL, type CtorAgeTarget, type CtorComplexity } from './constructor-model';
import { plural } from './ru';

/**
 * Storefront pure helpers — one source of truth for the labels the landing,
 * the quest cards and the product page share (§2.2/§2.3/§3). No fabricated
 * values: everything derives from the live catalog/product payloads.
 */

export const ratingPlural = (n: number) => plural(n, 'оценка', 'оценки', 'оценок');
export const playersPlural = (n: number) => plural(n, 'игрок сыграл', 'игрока сыграли', 'игроков сыграли');
export const questPlural = (n: number) => plural(n, 'квест', 'квеста', 'квестов');
/** The owner's rule for every quest (backend store.rs DEFAULT_DURATION_MIN /
 *  DEFAULT_DISTANCE_KM): a 60-minute, 5 km walk unless its author says otherwise. */
export const DEFAULT_DURATION_MIN = 60;
export const DEFAULT_DISTANCE_KM = 5;

/** A review at least this long says something a buyer can use — the backend
 *  orders reviews by the same bar (facts.rs SUBSTANTIVE_REVIEW_CHARS). */
export const SUBSTANTIVE_REVIEW_CHARS = 60;

export const cityPlural = (n: number) => plural(n, 'город', 'города', 'городов');
export const reviewPlural = (n: number) => plural(n, 'отзыв', 'отзыва', 'отзывов');
export const playerCountPlural = (n: number) => plural(n, 'игрок', 'игрока', 'игроков');
export const taskPlural = (n: number) => plural(n, 'задание', 'задания', 'заданий');
export const completionPlural = (n: number) => plural(n, 'прохождение', 'прохождения', 'прохождений');


/**
 * Rating to the hundredth with a decimal comma, never fewer than one decimal
 * (5 → «5,0», 4.966 → «4,97», 4.9 → «4,9»): rounded to tenths every quest read
 * «5» and the store could not tell them apart.
 */
export function fmtRating(avg: number): string {
  const r = Math.round(avg * 100) / 100;
  return (Number.isInteger(r) ? r.toFixed(1) : String(r)).replace('.', ',');
}

/**
 * The «N игроков сыграли» line is shown only when it cannot contradict the
 * ratings: ratings imported from the old platform came without completions, and
 * «41 оценка · 1 игрок сыграл» reads as a fake.
 */
export function showPlayers(players: number, ratingCount: number): boolean {
  return players > 0 && players >= ratingCount;
}

/** «≈ 60 мин» — the walk's duration from its minutes. */
export function durationLabel(minutes: number): string {
  return `≈ ${minutes} мин`;
}

/** «5 км», «3,5 км» — the route length, tenths at most. */
export function distanceLabel(value: number): string {
  return `${String(Math.round(value * 10) / 10).replace('.', ',')} км`;
}

/** What a store surface needs to show a quest's time and distance. The numeric
 *  fields are optional: a catalog row cached for offline before they existed
 *  lacks them. */
export interface QuestFactsSource {
  duration: string | null;
  duration_min?: number;
  distance_km?: number;
}

/**
 * The time and distance a store surface shows. With `quest_facts` on (and the
 * numbers present) they come from the minutes and kilometres; otherwise the
 * author's legacy duration label stands alone and no distance is claimed.
 */
export function questFacts(q: QuestFactsSource, factsOn: boolean): { time: string | null; distance: string | null } {
  if (factsOn && typeof q.duration_min === 'number') {
    return {
      time: durationLabel(q.duration_min),
      distance: typeof q.distance_km === 'number' ? distanceLabel(q.distance_km) : null,
    };
  }
  return { time: q.duration?.trim() || null, distance: null };
}

/**
 * The quest the finale offers next (ТЗ, задача 32): another quest of the same
 * city, one the player has not taken first, best rated first. Null when the city
 * has nothing else.
 */
export function pickNextQuest<T extends { quest_id: string; city: string | null; rating_avg: number; rating_count: number }>(
  catalog: readonly T[],
  currentId: string,
  city: string | null,
  owned: ReadonlySet<string>,
): T | null {
  let best: T | null = null;
  const rank = (q: T) => [owned.has(q.quest_id) ? 0 : 1, q.rating_count > 0 ? q.rating_avg : 0, q.rating_count];
  for (const q of catalog) {
    if (q.quest_id === currentId || !city || q.city !== city) continue;
    if (!best) { best = q; continue; }
    const [a, b] = [rank(q), rank(best)];
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = q;
  }
  return best;
}

/** One number on the city banner: «6» over «квестов». */
export interface HeroStat {
  value: string;
  label: string;
}

/**
 * The main banner's numbers for the quests of one city: how many quests, how
 * many completions (always, even none — owner, 2026-10-10), the average walk
 * time and length — the quest settings' minutes and kilometres
 * (`quest_facts`), averaged, so the banner never disagrees with the cards
 * under it. A time or length nothing backs is left out.
 */
export function heroStats(
  quests: Array<Pick<PublishedQuestWire, 'players'> & QuestFactsSource>,
  factsOn: boolean,
): HeroStat[] {
  const stats: HeroStat[] = [];
  if (quests.length === 0) return stats;
  stats.push({ value: String(quests.length), label: questPlural(quests.length) });
  const completions = quests.reduce((n, q) => n + q.players, 0);
  stats.push({ value: completions.toLocaleString('ru-RU'), label: completionPlural(completions) });
  if (!factsOn) return stats;
  const minutes = quests.map((q) => q.duration_min).filter((v): v is number => typeof v === 'number');
  if (minutes.length > 0) {
    const avg = Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length / 5) * 5;
    stats.push({ value: `${avg} мин`, label: 'в среднем' });
  }
  const kms = quests.map((q) => q.distance_km).filter((v): v is number => typeof v === 'number');
  if (kms.length > 0) {
    const avg = Math.round((kms.reduce((a, b) => a + b, 0) / kms.length) * 2) / 2;
    stats.push({ value: distanceLabel(avg), label: 'пешком' });
  }
  return stats;
}

/**
 * The banner's slogan for a city. The admin writes it on the «Города» page,
 * often as the city's own sentence continued — «, путешествие в прошлое» —
 * so a slogan opening with punctuation follows the city name; one opening
 * with a dash gets a space before it. No slogan: the banner's old title.
 */
export function heroSlogan(city: string | null, slogan?: string | null): string {
  const s = slogan?.trim();
  if (!s || !city) return heroTitle(city);
  if (/^[,.:;!?…]/.test(s)) return `${city}${s}`;
  if (/^[—–-]/.test(s)) return `${city} ${s}`;
  return s;
}

/** One city of the catalog and how many quests it has. */
export interface CityCount {
  city: string;
  count: number;
}

/** The catalog's cities, the busiest first (ties: ru order) — the order of the
 *  city list in the shop's title. */
export function citiesByCount(quests: Array<{ city: string | null }>): CityCount[] {
  const counts = new Map<string, number>();
  for (const q of quests) if (q.city) counts.set(q.city, (counts.get(q.city) ?? 0) + 1);
  return Array.from(counts, ([city, count]) => ({ city, count })).sort(
    (a, b) => b.count - a.count || a.city.localeCompare(b.city, 'ru'),
  );
}

/** The city with the most quests (ties: ru order) — where a first visit opens. */
export function busiestCity(quests: Array<{ city: string | null }>): string | null {
  return citiesByCount(quests)[0]?.city ?? null;
}

/** «Средняя сложность · 11 заданий · можно с детьми» — the card's facts line
 *  from attributes the catalog already serves; unknown parts drop out. */
export function attrsLine(q: Pick<PublishedQuestWire, 'complexity' | 'age_target' | 'tasks'>): string {
  const complexity = q.complexity && COMPLEXITY_LABEL[q.complexity as CtorComplexity];
  const age = q.age_target ? AGE_FOR_CARD[q.age_target as CtorAgeTarget] : undefined;
  return [
    complexity ? `${complexity} сложность` : null,
    q.tasks ? `${q.tasks} ${taskPlural(q.tasks)}` : null,
    age ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** «Для всех» on a card reads as an answer to «а детям можно?». */
const AGE_FOR_CARD: Record<CtorAgeTarget, string> = {
  kids: AGE_TARGET_LABEL.kids.toLowerCase(),
  everyone: 'можно с детьми',
  '18plus': AGE_TARGET_LABEL['18plus'],
};

/** Prepositional case of the cities the platform plays in («в Нови Саде»);
 *  a name the table does not know is never declined by a guessed rule. */
const CITY_IN: Record<string, string> = {
  'Нови Сад': 'Нови Саде',
  Белград: 'Белграде',
  Стамбул: 'Стамбуле',
  Москва: 'Москве',
};

/** «в Нови Саде» for a city the table knows; null otherwise. */
export function inCity(city: string | null | undefined): string | null {
  const where = city ? CITY_IN[city] : undefined;
  return where ? `в ${where}` : null;
}

/**
 * The invitation a player sends friends after taking a quest (ТЗ, задача 28):
 * «Пойдём в квест «Тайна крепости» в Нови Саде? ≈ 60 минут, бесплатно».
 */
export function inviteText(name: string, city: string | null, time: string | null, free: boolean): string {
  const where = inCity(city);
  const tail = [time?.replace(/ мин$/, ' минут'), free ? 'бесплатно' : null].filter(Boolean).join(', ');
  return `Пойдём в квест «${name}»${where ? ` ${where}` : ''}?${tail ? ` ${tail}` : ''}`;
}

/** The shop's title split around the city, so the city alone can be the
 *  switch: «Квесты в » + «Нови Саде»; an unknown city reads «Квесты · » + «Ниш». */
export function questsInCityParts(city: string | null): { lead: string; place: string | null } {
  if (!city) return { lead: 'Квесты', place: null };
  const where = CITY_IN[city];
  return where ? { lead: 'Квесты в ', place: where } : { lead: 'Квесты · ', place: city };
}

/** «Квесты в Нови Саде»; an unknown city reads «Квесты · Город». */
export function questsInCity(city: string | null): string {
  const { lead, place } = questsInCityParts(city);
  return place ? lead + place : lead;
}

/** The hero's headline for a city (text approved by the owner); without one,
 *  «город» stands in. Feminine names (Москва) take «о которой». */
export function heroTitle(city: string | null): string {
  if (!city) return 'Город, о котором не расскажет экскурсовод';
  const feminine = /[ая]$/.test(city);
  return `${city}, ${feminine ? 'о которой' : 'о котором'} не расскажет экскурсовод`;
}

/** Price chip text: rubles, «Бесплатно» for 0, or "" when unset (legacy). */
export function priceLabel(price: number | null): string {
  if (price == null) return '';
  return price === 0 ? 'Бесплатно' : `${price} ₽`;
}

export interface CatalogFacts {
  quests: number;
  cities: number;
  /** Weighted mean of rating_avg over rating_count; null while nothing is rated. */
  avg: number | null;
  ratings: number;
}

/** §2.3 hero facts from the live catalog response. */
export function catalogFacts(quests: PublishedQuestWire[]): CatalogFacts {
  const cities = new Set(
    quests
      .map((q) => q.city?.trim().toLowerCase())
      .filter((c): c is string => !!c),
  );
  let ratings = 0;
  let weighted = 0;
  for (const q of quests) {
    ratings += q.rating_count;
    weighted += q.rating_avg * q.rating_count;
  }
  return {
    quests: quests.length,
    cities: cities.size,
    avg: ratings > 0 ? weighted / ratings : null,
    ratings,
  };
}

/** Display strings for the hero facts row; rating is null while unrated. */
export function factsLine(f: CatalogFacts): { quests: string; cities: string; rating: string | null } {
  return {
    quests: `${f.quests} ${questPlural(f.quests)}`,
    cities: `${f.cities} ${cityPlural(f.cities)}`,
    rating: f.avg == null ? null : `${fmtRating(f.avg)} — средняя оценка игроков`,
  };
}
