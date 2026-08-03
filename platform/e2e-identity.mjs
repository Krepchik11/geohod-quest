// E2E: anonymous buy → play → register (progress survives) → second-device login
// → enforcement (tokenless spoof of a registered id fails). Run with both servers
// up (backend :8080 + frontend :3000): node e2e-identity.mjs
import { chromium } from 'playwright';

const FRONT = 'http://localhost:3000';
const API = 'http://localhost:8080';
const EMAIL = `e2e-${Date.now()}@example.com`;
const PASSWORD = 'hunter2hunter2';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok: ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL: ${name} ${extra}`);
  }
}

const browser = await chromium.launch();

// ── Device A: anonymous flow ────────────────────────────────────────────────
const ctxA = await browser.newContext();
const pageA = await ctxA.newPage();

console.log('1. Anonymous marketplace buy');
await pageA.goto(`${FRONT}/`, { waitUntil: 'networkidle' });
// Buy the quest we will play below (access is grant-enforced; no fake grants).
const mysteryCard = pageA.locator('#shop .quest-card', { hasText: 'Mystery of the Fortress' });
const buyBtn = mysteryCard.locator('button.btn', { hasText: 'Купить' });
await buyBtn.waitFor({ state: 'visible', timeout: 10000 });
await buyBtn.click();
// §3.3 purchase confirmation sheet (added after this script was written):
// charging happens only on «Подтвердить».
const sheetConfirm = pageA.getByRole('button', { name: /Подтвердить/ });
await sheetConfirm.waitFor({ state: 'visible', timeout: 10000 });
await sheetConfirm.click();
await pageA.locator('.sheet__ovl').waitFor({ state: 'detached' }).catch(() => {});
await mysteryCard.locator('a.btn', { hasText: 'Играть' }).waitFor({ timeout: 10000 });
check('buy button flips to Играть (grant created, mock payment)', true);

const anonId = await pageA.evaluate(() => `dev:${localStorage.getItem('geohod-device-id:v1')}`);
check('anonymous identity minted', /^dev:[0-9a-f-]{36}$/.test(anonId), anonId);

console.log('2. Anonymous play (steps + sync)');
await pageA.goto(`${FRONT}/quest/mystery-fortress-v1`, { waitUntil: 'networkidle' });
await pageA.locator('.pframe').waitFor({ timeout: 10000 });
// Step 0 is the designed start screen: the primary action advances.
const confirm = pageA.locator('.pframe .p-btn').first();
await confirm.click();
await pageA.waitForTimeout(500);
check('player advanced past step 0', true);

console.log('3. Registration preserves identity and purchases');
await pageA.goto(`${FRONT}/auth`, { waitUntil: 'networkidle' });
// §6.1 two-phase auth: identify by email first, then the register form.
await pageA.fill('input[type=email]', EMAIL);
await pageA.locator('button', { hasText: 'Продолжить' }).click();
await pageA.fill('input[type=password]', PASSWORD);
await pageA.locator('input[type=checkbox]').check();
await pageA.locator('button', { hasText: 'Зарегистрироваться' }).click();
// Deterministic: wait for the session the next line reads, not a blind sleep.
await pageA.waitForFunction(() => localStorage.getItem('geohod-session:v1'), null, { timeout: 10000 });
const sessionA = await pageA.evaluate(() => JSON.parse(localStorage.getItem('geohod-session:v1')));
check('session stored after register', !!sessionA?.token);
check('registration kept the anonymous user id', sessionA?.user_id === anonId,
  `${sessionA?.user_id} vs ${anonId}`);

await pageA.goto(`${FRONT}/profile`, { waitUntil: 'networkidle' });
await pageA.waitForTimeout(800);
const profileText = await pageA.locator('.pf-grid').innerText();
check('profile shows the registered email (live /me)', profileText.includes(EMAIL), profileText.slice(0, 200));
check('profile shows live game tiles', profileText.includes('монет на балансе'));

await pageA.goto(`${FRONT}/my-quests`, { waitUntil: 'networkidle' });
await pageA.waitForTimeout(800);
const mqText = await pageA.locator('main').innerText();
check('my-quests lists the purchased quest after registration', mqText.includes('Mystery of the Fortress'), mqText.slice(0, 200));

console.log('4. Enforcement: tokenless spoof of a registered id is rejected');
const spoof = await fetch(`${API}/api/checkout`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: anonId, quest_id: 'mystery-fortress-v1' }),
});
check('tokenless checkout claiming registered id → 401', spoof.status === 401, `got ${spoof.status}`);
const withToken = await fetch(`${API}/api/checkout`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionA.token}` },
  body: JSON.stringify({ user_id: anonId, quest_id: 'mystery-fortress-v1' }),
});
check('same request with the session token → 200 (idempotent grant)', withToken.status === 200, `got ${withToken.status}`);

console.log('5. Device B: login adopts the account');
const ctxB = await browser.newContext();
const pageB = await ctxB.newPage();
await pageB.goto(`${FRONT}/auth`, { waitUntil: 'networkidle' });
await pageB.fill('input[type=email]', EMAIL);
await pageB.locator('button', { hasText: 'Продолжить' }).click();
await pageB.fill('input[type=password]', PASSWORD);
await pageB.locator('button', { hasText: /^Войти$/ }).click();
await pageB.waitForFunction(() => localStorage.getItem('geohod-session:v1'), null, { timeout: 10000 });
const sessionB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('geohod-session:v1')));
check('device B adopted device A identity', sessionB?.user_id === anonId,
  `${sessionB?.user_id} vs ${anonId}`);
await pageB.goto(`${FRONT}/my-quests`, { waitUntil: 'networkidle' });
await pageB.waitForTimeout(800);
const mqB = await pageB.locator('main').innerText();
check('device B sees the account collection', mqB.includes('Mystery of the Fortress'), mqB.slice(0, 200));

console.log('6. Wrong password is rejected');
const ctxC = await browser.newContext();
const pageC = await ctxC.newPage();
await pageC.goto(`${FRONT}/auth`, { waitUntil: 'networkidle' });
await pageC.fill('input[type=email]', EMAIL);
await pageC.locator('button', { hasText: 'Продолжить' }).click();
await pageC.fill('input[type=password]', 'wrong-password-1');
await pageC.locator('button', { hasText: /^Войти$/ }).click();
await pageC.getByText(/Неверн|не подходят|попробуйте/i).first().waitFor({ timeout: 10000 });
const sessionC = await pageC.evaluate(() => JSON.parse(localStorage.getItem('geohod-session:v1') ?? 'null'));
check('wrong password shows an error and stores no session', sessionC === null);

await browser.close();
console.log(failures === 0 ? '\nE2E: ALL PASS' : `\nE2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
