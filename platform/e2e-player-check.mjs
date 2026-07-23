// Verification for the production player (run ad-hoc, both servers up):
// access gate without grant, full 7-template playthrough of «Ирония судьбы»,
// SPEC hint-popup threshold (2nd wrong only), real offline banner, no debug chrome.
import { chromium } from 'playwright';

const FRONT = 'http://localhost:3000';
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok: ${name}`);
  else { failures += 1; console.error(`  FAIL: ${name} ${extra}`); }
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

console.log('1. No grant → designed access screen');
await page.goto(`${FRONT}/quest/ironia-sudby`, { waitUntil: 'networkidle' });
await page.locator('.pframe', { hasText: /доступ/i }).waitFor({ timeout: 10000 });
let text = await page.locator('.pframe').innerText();
check('access screen shown', /нужен доступ/i.test(text), text.slice(0, 120));
check('marketplace CTA present', await page.locator('.pframe a.p-btn', { hasText: 'Выбрать в магазине' }).count() === 1);

console.log('2. Unknown quest → unavailable screen');
await page.goto(`${FRONT}/quest/no-such-quest`, { waitUntil: 'networkidle' });
await page.locator('.pframe', { hasText: /недоступен/i }).waitFor({ timeout: 10000 });
text = await page.locator('.pframe').innerText();
check('unavailable screen shown', /квест недоступен/i.test(text), text.slice(0, 120));

console.log('3. Buy ironia, play all 7 templates');
await page.goto(`${FRONT}/`, { waitUntil: 'networkidle' });
const card = page.locator('#shop .quest-card', { hasText: 'Ирония судьбы' });
await card.locator('button.btn', { hasText: 'Купить' }).click();
await card.locator('a.btn', { hasText: 'Пройти' }).waitFor({ timeout: 10000 });
await page.goto(`${FRONT}/quest/ironia-sudby`, { waitUntil: 'networkidle' });
await page.locator('.pframe .p-btn').first().waitFor({ timeout: 10000 });

const body = await page.locator('body').innerText();
check('no debug chrome on player page', !/simulate|Designed player|append-only|NEXT_PUBLIC|golden/i.test(body), body.slice(0, 200));

// start
check('start screen', /ирония судьбы/i.test(await page.locator('.pframe').innerText()));
await page.locator('.pframe .p-btn', { hasText: 'начать квест' }).click();
// video
check('video step with duration', (await page.locator('.pframe').innerText()).includes('0:48'));
await page.locator('.pframe .p-btn', { hasText: 'продолжить' }).click();
// continue (завязка)
check('continue step', (await page.locator('.pframe').innerText()).includes('1913 год'));
await page.locator('.pframe .p-btn', { hasText: 'продолжить' }).click();
// task_no: physical confirm; the address line itself opens maps (no navigator button)
check('task_no with place', (await page.locator('.pframe').innerText()).includes('Николаевска порта'));
check('address line is the map link', await page.locator('.pframe .p-place--link').count() >= 1);
await page.locator('.pframe .p-btn', { hasText: 'Я на месте, нашёл' }).click();
// gift toast +3
await page.locator('.p-toast').waitFor({ timeout: 3000 });
const toastText = await page.locator('.p-toast').innerText();
check('gift toast +3 монет', toastText.includes('+3'), JSON.stringify(toastText));

console.log('4. task_answer: SPEC hint threshold');
await page.locator('.pframe input.p-input').waitFor({ timeout: 5000 });
await page.fill('.pframe input.p-input', '1900');
await page.locator('.pframe .p-btn', { hasText: 'Ответить' }).click();
await page.waitForTimeout(300);
check('1st wrong → inline error, NO popup', (await page.locator('.p-wrong').count()) === 1 && (await page.locator('.p-overlay').count()) === 0);
await page.fill('.pframe input.p-input', '1901');
await page.locator('.pframe .p-btn', { hasText: 'Ответить' }).click();
await page.locator('.p-overlay').waitFor({ timeout: 3000 });
check('2nd wrong → hint popup', (await page.locator('.p-overlay').innerText()).includes('Нужна подсказка'));
await page.locator('.p-overlay .p-btn', { hasText: 'Потратить 5 монет' }).click();
await page.waitForTimeout(300);
// purchase opens the hint-content popup (text and/or image) + spend toast «−5 монет»
check('purchase → hint content popup', (await page.locator('.p-overlay').innerText()).includes('Подсказка'));
check('spend toast −5 монет', (await page.locator('.p-toast--spend').count()) === 1);
await page.locator('.p-overlay .p-btn', { hasText: 'Понятно' }).click();
await page.waitForTimeout(200);
check('hint box revealed after purchase', (await page.locator('.p-hintbox').count()) === 1);
await page.fill('.pframe input.p-input', '1730');
await page.locator('.pframe .p-btn', { hasText: 'Ответить' }).click();
await page.waitForTimeout(500);
// route_video
check('route_video with duration + в путь', (await page.locator('.pframe').innerText()).includes('0:31'));
await page.locator('.pframe .p-btn', { hasText: 'в путь' }).click();
// continue (диалог)
await page.locator('.pframe .p-btn', { hasText: 'продолжить' }).click();
await page.waitForTimeout(800);
// congrats
text = await page.locator('.pframe').innerText();
check('congrats terminal with stats', /квест пройден/i.test(text) && text.includes('монет собрано'), text.slice(0, 200));
check('rating stars present', (await page.locator('.p-rate button').count()) === 5);
await page.screenshot({ path: '/tmp/player-congrats.png' });

console.log('5. Real offline banner + reload resume');
await ctx.setOffline(true);
await page.waitForTimeout(400);
check('offline banner appears', (await page.locator('.p-syncbar').innerText()).includes('Офлайн'));
await ctx.setOffline(false);
await page.reload({ waitUntil: 'networkidle' });
text = await page.locator('body').innerText();
check('completed attempt resumes without start gate', /квест пройден/i.test(text) && !text.includes('Продолжить попытку'), text.slice(0, 150));

console.log('6. /quest redirects');
const resp = await page.goto(`${FRONT}/quest?golden=ironia-sudby`, { waitUntil: 'networkidle' });
check('legacy ?golden= redirects to path route', page.url().includes('/quest/ironia-sudby'), page.url());

await browser.close();
console.log(failures ? `PLAYER CHECK: ${failures} FAILURES` : 'PLAYER CHECK: ALL PASS');
process.exit(failures ? 1 : 0);
