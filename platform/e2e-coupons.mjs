// E2E: admin creates a coupon in the unified admin shell → player applies it in
// the purchase sheet (server-validated) → checkout redeems it → usage shows up
// in the admin editor → pause stops the code. Run with both servers up
// (backend :8080 + frontend :3000): node e2e-coupons.mjs
import { chromium } from 'playwright';

const FRONT = 'http://localhost:3000';
const API = 'http://localhost:8080';
const ADMIN = 'dev-admin-secret-change-me';
const RUN = Date.now();
const QUEST = `e2e-coupon-quest-${RUN}`;
const CODE = `E2E-${RUN % 1_000_000}`;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok: ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function apiJson(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN, ...init.headers },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---- arrange: one paid published quest ------------------------------------
{
  const { status } = await apiJson('/api/quests/publish', {
    method: 'POST',
    body: JSON.stringify({
      quest_id: QUEST,
      name: `Купонный квест ${RUN}`,
      template_summary: 'e2e',
      snapshot_version: 1,
      snapshot_id: `${QUEST}-v1`,
      price: 900,
      city: 'Нови Сад',
      duration: '1 час',
    }),
  });
  check('paid quest published', status === 200, `status ${status}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();

// ---- 1. admin shell + coupon creation --------------------------------------
console.log('1) admin creates a coupon through the UI');
await page.goto(`${FRONT}/admin/coupons`);
check('shell tab «Купоны» active', await page.locator('.ash-tabs--inline a.is-active', { hasText: 'Купоны' }).count() === 1);
check('users tab links to /admin', await page.locator('.ash-tabs--inline a[href="/admin"]').count() === 1);

await page.getByRole('button', { name: /Новый купон/ }).click();
await page.waitForURL('**/admin/coupons/new');
await page.locator('#cpn-code').fill(CODE);
await page.locator('#cpn-value').fill('20');
// percent stays selected by default; cap total uses at 50
await page.locator('label.ac-check', { hasText: 'Без лимита' }).click();
await page.locator('#cpn-max').fill('50');
await page.getByRole('button', { name: 'Создать купон' }).click();
await page.waitForURL('**/admin/coupons/cpn-*');
check('editor shows the created code', (await page.locator('h1.ac-title').innerText()) === CODE);
check('status badge «Активен»', await page.locator('.ac-editor-head .ac-badge', { hasText: 'Активен' }).count() === 1);
const editUrl = page.url();

// duplicate code from the list is rejected with the server message
await page.goto(`${FRONT}/admin/coupons/new`);
await page.locator('#cpn-code').fill(CODE.toLowerCase());
await page.locator('#cpn-value').fill('10');
await page.getByRole('button', { name: 'Создать купон' }).click();
await page.locator('.ac-form-error').waitFor();
check('duplicate code shows server 409 message', /уже существует/.test(await page.locator('.ac-form-error').innerText()));

// list shows the coupon with usage 0/50
await page.goto(`${FRONT}/admin/coupons`);
const row = page.locator('.ac-row', { hasText: CODE });
await row.waitFor();
check('list row shows −20%', (await row.locator('.ac-row__discount--col').innerText()) === '−20%');
check('list row shows 0 из 50', /0\s+из 50/.test(await row.locator('.ac-usage__count').innerText()));

// ---- 2. player applies the code in the purchase sheet ----------------------
console.log('2) player redeems the coupon at purchase');
const player = await browser.newPage();
await player.goto(`${FRONT}/quest/${QUEST}/about`);
await player.getByRole('button', { name: /Купить за 900 ₽/ }).click();
await player.getByText('Есть промокод?').click();
await player.getByPlaceholder('Промокод').fill(CODE.toLowerCase());
await player.getByRole('button', { name: 'Применить' }).click();
await player.getByText('Промокод −180 ₽').waitFor();
check('sheet shows server-priced discount −180 ₽', true);
const confirm = player.getByRole('button', { name: 'Подтвердить — 720 ₽' });
check('confirm shows the discounted price 720 ₽', (await confirm.count()) === 1);
await confirm.click();
await player.locator('.psheet').waitFor({ state: 'detached' }).catch(() => {});

// a wrong code reads the backend message
const player2 = await browser.newPage();
await player2.goto(`${FRONT}/quest/${QUEST}/about`);
await player2.getByRole('button', { name: /Купить за 900 ₽/ }).click();
await player2.getByText('Есть промокод?').click();
await player2.getByPlaceholder('Промокод').fill('NO-SUCH-CODE');
await player2.getByRole('button', { name: 'Применить' }).click();
await player2.getByText('промокод не найден').waitFor();
check('unknown code shows «промокод не найден»', true);
await player2.close();

// ---- 3. usage lands in the admin editor; pause stops the code --------------
console.log('3) usage stats + pause');
await page.goto(editUrl);
await page.locator('.ac-usage-big b', { hasText: '1' }).waitFor();
check('usage card shows 1 activation', true);
const rows = await page.locator('.ac-usage-rows').innerText();
check('remaining 49', /Осталось активаций\s*49/.test(rows), rows);
check('discount sum 180 ₽', /Сумма скидок\s*180 ₽/.test(rows), rows);

await page.getByRole('button', { name: 'Поставить на паузу' }).first().click();
await page.locator('.ac-editor-head .ac-badge', { hasText: 'На паузе' }).waitFor();
check('pause flips the badge to «На паузе»', true);

const paused = await apiJson('/api/coupons/validate', {
  method: 'POST',
  body: JSON.stringify({ player_id: `dev:e2e-${RUN}`, quest_id: QUEST, code: CODE }),
});
check('paused code refuses validation', paused.body.valid === false && /временно/.test(paused.body.message), JSON.stringify(paused.body));

// ---- 4. users page carries the same shell ----------------------------------
console.log('4) users page under the same shell');
await page.goto(`${FRONT}/admin`);
await page.locator('.ash-tabs--inline a.is-active', { hasText: 'Пользователи' }).waitFor();
check('users page wrapped in the shell', true);
check('user menu present', await page.locator('.ash-bar .user-menu').count() === 1);
check('users list heading renders', await page.locator('h1.au-title', { hasText: 'Пользователи' }).count() === 1);

// cleanup: delete the coupon through the UI (confirm sheet)
await page.goto(editUrl);
await page.getByRole('button', { name: 'Удалить купон' }).first().click();
await page.locator('.ac-sheet-apply').click();
await page.waitForURL('**/admin/coupons');
check('delete returns to the list', true);

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
