/**
 * Цвета квеста: три, которые задаёт автор, и весь набор, который из них следует.
 *
 * Плеер рисуется по переменным `--p-*` на `.pframe`. ОДИН источник этого набора —
 * {@link themeVars}: и для квеста со своими цветами, и для «бумажной» палитры по
 * умолчанию, которая есть ровно `themeVars(PAPER_THEME)`. Умолчания в
 * `styles/player-paper.css` — расшифровка того же вызова (её пиннит тест), чтобы
 * палитру было видно глазами и чтобы `.pframe` без обёртки не остался бесцветным.
 *
 * Почему считается здесь, а не в CSS через `color-mix`: цвет надписи на кнопке и
 * читаемость акцента на выбранном фоне — решения по яркости, а не смешивание.
 * Раз одно решение уже в TypeScript, там же живут и остальные: две половины
 * набора в разных языках разъезжаются молча.
 */
import type { CSSProperties } from 'react';

/** Три цвета, которые выбирает автор. */
export interface QuestTheme {
  /** Фон страницы. */
  bg: string;
  /** Цвет текста. */
  ink: string;
  /** Цвет главной кнопки. */
  btn: string;
}

/** Палитра «бумага» — умолчание плеера и стартовые цвета для автора. */
export const PAPER_THEME: QuestTheme = { bg: '#FBF1E5', ink: '#3E2C2C', btn: '#3E2C2C' };

/** Оттенки, которые автор не выбирает: акцент ошибок и монета. Монета —
 *  заливка значка с ободком, она узнаётся формой и остаётся как есть; акцент и
 *  ободок идут ТЕКСТОМ, поэтому их светлота подгоняется под фон автора: иначе на
 *  тёмном квесте «неверный ответ» и подпись про монеты не прочитать. */
const FIXED_HUES = { accent: '#A33B2A', coin: '#C99B3F', coinRim: '#8A6A1F' };

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` или `#rrggbb` в компоненты; иначе null. Решётка обязательна — тот же
 *  разбор делает `snapshot_theme` на сервере, и разойтись им нельзя. */
function parseHex(value: string): Rgb | null {
  const raw = value.trim();
  if (!raw.startsWith('#')) return null;
  const hex = raw.slice(1);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function part(v: number): string {
  return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
}

function toHex({ r, g, b }: Rgb): string {
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** `amount` доли `other` в `base`. */
function mix(base: Rgb, other: Rgb, amount: number): Rgb {
  return {
    r: base.r + (other.r - base.r) * amount,
    g: base.g + (other.g - base.g) * amount,
    b: base.b + (other.b - base.b) * amount,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function rgba({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Относительная яркость по WCAG. */
function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Контраст двух цветов по WCAG: от 1 (одинаковые) до 21 (чёрный и белый). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [parseHex(a), parseHex(b)];
  return x && y ? ratio(x, y) : 1;
}

/** Порог читаемости обычного текста (WCAG AA). */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * Тот же тон, но осветлённый или затемнённый ровно настолько, чтобы читаться на
 * `bg`. Идём к белому на тёмном фоне и к чёрному на светлом, шагами по 6% — так
 * оттенок остаётся узнаваемым, а не подменяется чёрным или белым целиком.
 */
function readableOn(hue: Rgb, bg: Rgb): Rgb {
  const target = luminance(bg) > 0.5 ? BLACK : WHITE;
  let out = hue;
  for (let step = 0; step < 16 && ratio(out, bg) < MIN_TEXT_CONTRAST; step++) {
    out = mix(hue, target, (step + 1) * 0.06);
  }
  return out;
}

/** Прозрачные производные от цвета текста; доли — из бумажной палитры. */
const INK_ALPHAS: ReadonlyArray<readonly [string, number]> = [
  ['--p-muted', 0.72],
  ['--p-line', 0.28],
  ['--p-line-soft', 0.15],
  ['--p-line-mid', 0.4],
  ['--p-line-strong', 0.55],
  ['--p-ink-hover', 0.07],
  ['--p-ink-strong', 0.82],
  ['--p-ink-faint', 0.022],
];

function build(theme: QuestTheme): CSSProperties {
  const bg = parseHex(theme.bg) ?? parseHex(PAPER_THEME.bg)!;
  const ink = parseHex(theme.ink) ?? parseHex(PAPER_THEME.ink)!;
  const btn = parseHex(theme.btn) ?? parseHex(PAPER_THEME.btn)!;
  const vars: Record<string, string> = {
    '--p-bg': toHex(bg),
    '--p-ink': toHex(ink),
    '--p-btn': toHex(btn),
    // Надпись на залитой кнопке: та из двух крайностей, что на ней читается.
    // Иначе тёмный текст на тёмной кнопке просто исчезает.
    '--p-btn-ink': toHex(luminance(btn) > 0.45 ? BLACK : WHITE),
    '--p-btn-hover': toHex(mix(btn, BLACK, 0.18)),
    // Приподнятая поверхность светлее фона — и на светлой теме, и на тёмной.
    '--p-card': toHex(mix(bg, WHITE, 0.1)),
    // Заливка при наведении: фон, чуть сдвинутый к тексту.
    '--p-tint': toHex(mix(bg, ink, 0.08)),
    // Затемнение под всплывающими окнами — от текста, а не от бумажной сепии.
    '--p-scrim': rgba(mix(ink, BLACK, 0.6), 0.55),
    '--p-accent': toHex(readableOn(parseHex(FIXED_HUES.accent)!, bg)),
    '--p-coin': FIXED_HUES.coin.toLowerCase(),
    '--p-coin-rim': toHex(readableOn(parseHex(FIXED_HUES.coinRim)!, bg)),
  };
  for (const [token, alpha] of INK_ALPHAS) vars[token] = rgba(ink, alpha);
  return Object.freeze(vars) as CSSProperties;
}

/**
 * Тема из недоверенного значения (тело черновика, замороженный снапшот, ответ
 * API). Только три строки-цвета, каждая — разбираемый hex с решёткой; иначе
 * темы нет и квест играется в бумажной палитре, как до появления поля. Тот же
 * разбор делает `snapshot_theme` на сервере — разойтись им нельзя, иначе плеер
 * и заставка установленного приложения покрасятся по-разному.
 */
export function parseTheme(value: unknown): QuestTheme | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const hex = (raw: unknown): string | null =>
    typeof raw === 'string' && parseHex(raw) ? raw.trim() : null;
  const [bg, ink, btn] = [hex(v.bg), hex(v.ink), hex(v.btn)];
  return bg && ink && btn ? { bg, ink, btn } : null;
}

/** Один и тот же набор на весь монтаж плеера: `PlayerFrame` перерисовывается на
 *  каждое нажатие клавиши в поле ответа, а цвета за прохождение не меняются. */
const EMPTY = Object.freeze({}) as CSSProperties;
let cached: { key: string; vars: CSSProperties } | null = null;

/**
 * Полный набор переменных для темы. Без темы — пусто: плеер берёт умолчания из
 * player-paper.css. Цвет, который не разобрался, заменяется бумажным: тема
 * применяется целиком, полутонов быть не должно.
 */
export function themeVars(theme: QuestTheme | null | undefined): CSSProperties {
  if (!theme) return EMPTY;
  const key = `${theme.bg}|${theme.ink}|${theme.btn}`;
  if (cached?.key !== key) cached = { key, vars: build(theme) };
  return cached.vars;
}
