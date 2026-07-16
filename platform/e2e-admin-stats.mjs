// Scoped probe: admin statistics page (overview + drill-down funnel).
// Self-seeding: publishes a fresh quest via the API (unique id per run, like
// e2e-coupons.mjs), runs three attempts to known depths, then asserts the
// seeded quest's row and funnel — so it is green against any database state.
//
// Run from platform/ root: node e2e-admin-stats.mjs
// Env: BASE (frontend, default http://localhost:3100),
//      API (backend, default http://localhost:8080),
//      ADMIN_TOKEN (default dev-admin-secret-change-me), SHOTS dir.
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const API = process.env.API ?? 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-secret-change-me';
const SHOTS = process.env.SHOTS ?? '.';
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// ── seed via the real pipeline: publish → checkout → attempts → facts ──
const RUN = Date.now().toString(36);
const QUEST = `stats-probe-${RUN}`;
const NAME = `Проба статистики ${RUN}`;

async function post(path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const step = (position, template, title, completion = {}) => ({
  position,
  template,
  rich_content: { title },
  media: {},
  completion,
});

await post(
  '/api/quests/publish',
  {
    quest_id: QUEST,
    name: NAME,
    template_summary: '4 шага',
    city: 'Казань',
    price: 0,
    snapshot: {
      golden_id: QUEST,
      name: NAME,
      snapshot_version: 1,
      steps: [
        step(0, 'start', 'Старт: пробная точка'),
        step(1, 'task_answer', 'Задание: пробный вопрос', { acceptable: ['да'] }),
        step(2, 'continue', 'Переход дальше'),
        step(3, 'congrats', 'Финал пробы'),
      ],
    },
  },
  { 'x-admin-token': ADMIN_TOKEN },
);

const fact = (type, step_position, extra = {}) => ({
  type,
  step_position,
  local_is_correct: false,
  coins_delta: 0,
  device_id: 'probe',
  ...extra,
});

// p1 full run, p2 stops after step 0, p3 reaches step 2 — funnel 3/3/2/1.
const depths = [
  [fact('physical_confirmed', 0), fact('answer_submitted', 1, { submitted_value: 'да', local_is_correct: true }), fact('physical_confirmed', 2), fact('attempt_completed', 3)],
  [fact('physical_confirmed', 0)],
  [fact('physical_confirmed', 0), fact('answer_submitted', 1, { submitted_value: 'да', local_is_correct: true })],
];
for (let i = 0; i < depths.length; i++) {
  const player = `probe-${RUN}-p${i + 1}`;
  await post('/api/checkout', { player_id: player, quest_id: QUEST });
  const att = await post('/api/attempts', { player_id: player, quest_id: QUEST });
  await post(`/api/attempts/${att.attempt_id}/facts`, { facts: depths[i] });
}
console.log(`seeded quest ${QUEST}`);

// ── drive the page ──
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));

await page.goto(`${BASE}/admin/stats`, { waitUntil: 'networkidle' });
await page.waitForSelector('.ast-kpi__label', { timeout: 20000 });

const kpiLabels = await page.$$eval('.ast-kpi__label', (els) => els.map((e) => e.textContent));
for (const want of ['Куплено квестов', 'Начато прохождений', 'Завершено', 'Завершаемость']) {
  if (!kpiLabels.includes(want)) fail(`KPI label missing: ${want}`);
}
console.log('KPIs:', (await page.$$eval('.ast-kpi__value', (els) => els.map((e) => e.textContent))).join(' | '));
if (!(await page.$('.ast-chart svg'))) fail('trend chart svg missing');

const row = page.locator('.ast-table__row', { hasText: NAME });
if ((await row.count()) !== 1) fail('seeded quest row not found');
const rowText = (await row.innerText()).replace(/\n/g, ' · ');
console.log('seeded row:', rowText);
for (const want of ['3', '1', '33%', '1 из 3', 'Казань · 4 шага']) {
  if (!rowText.includes(want)) fail(`row missing «${want}»`);
}
await page.screenshot({ path: `${SHOTS}/stats-overview.png`, fullPage: true });

// range chips + custom period inputs render
await page.click('text=7 дней');
await page.waitForSelector('.ast-chip.is-on');
await page.click('text=Период…');
await page.waitForSelector('.ast-date', { timeout: 5000 });
await page.click('text=30 дней');

// ── drill-down ──
await row.click();
await page.waitForSelector('.ast-funnel', { timeout: 20000 });
const stepNames = await page.$$eval('.ast-step__name', (els) => els.map((e) => e.textContent));
console.log('funnel steps:', stepNames.join(' → '));
if (stepNames.join('|') !== 'Старт: пробная точка|Задание: пробный вопрос|Переход дальше|Финал пробы')
  fail('funnel step titles wrong');
const counts = await page.$$eval('.ast-step__count', (els) => els.map((e) => e.textContent));
console.log('reached:', counts.join(', '));
if (counts.join(',') !== '3,3,2,1') fail(`funnel counts wrong: ${counts}`);
console.log('summary:', await page.$eval('.ast-funnel__summary', (e) => e.textContent));
const hint = await page.$eval('.ast-funnel__hint', (e) => e.textContent);
if (!hint.includes('от 3 начавших')) fail(`funnel hint lacks cohort denominator: ${hint}`);
await page.screenshot({ path: `${SHOTS}/stats-funnel.png`, fullPage: true });

// ── back to overview ──
await page.click('.ast-back');
await page.waitForSelector('.ast-table__row', { timeout: 10000 });

console.log('OK: admin stats verified end-to-end');
await browser.close();
