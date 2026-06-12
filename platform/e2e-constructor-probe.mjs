// Probe: «Конструктор v2» workspace at /quest-editor in real Chromium.
// Covers the full design flow: список → создание → билдер (рельса, редактор,
// живое превью, матчер ответов) → пикер шаблонов → тест-игрок (монеты,
// подсказка после 2-й ошибки, бонус финала) → гейты → публикация (live backend).
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const errors = [];
const fail = (msg) => { errors.push(msg); console.log('FAIL: ' + msg); };
const ok = (msg) => console.log('ok: ' + msg);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') fail(`console.error: ${m.text()}`);
});

await page.goto(BASE + '/quest-editor', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/* 1. Список квестов: сиды, чипы статуса */
const rows = page.locator('.wsp-qrow');
(await rows.count()) >= 2 ? ok('quest list renders seed quests') : fail('quest list empty');
(await page.locator('.wsp-chip.live', { hasText: 'в магазине' }).count())
  ? ok('live version chip') : fail('live version chip missing');

/* 2. Создание квеста: модалка, обязательное название, префилл страниц */
await page.locator('button', { hasText: '+ Новый квест' }).first().click();
const createBtn = page.locator('.adm-modal button', { hasText: 'Создать квест' });
(await createBtn.isDisabled()) ? ok('create disabled without title') : fail('create not gated on title');
await page.locator('.adm-modal input').first().fill('Пробный квест');
await page.locator('.adm-modal input').nth(1).fill('Нови Сад');
await createBtn.click();
await page.waitForTimeout(400);
(await page.locator('.wsp-builder').count()) ? ok('builder opens after create') : fail('builder did not open');
const railPages = page.locator('.wsp-page');
(await railPages.count()) === 2 ? ok('new quest prefilled with start + congrats') : fail(`rail pages: ${await railPages.count()}`);

/* 3. Живое превью настоящими компонентами плеера */
(await page.locator('.wsp-preview .pframe').count()) ? ok('live preview renders real player frame') : fail('preview frame missing');
const subtitleInput = page.locator('.wsp-center input.adm-input').nth(2); // подзаголовок
await subtitleInput.fill('живое превью работает');
await page.waitForTimeout(300);
(await page.locator('.wsp-preview .pframe').textContent())?.includes('живое превью работает')
  ? ok('preview updates live from editor input') : fail('preview not live');

/* 4. Пикер шаблонов: 7 живых мини-превью; вставка не позже финала */
await page.locator('button', { hasText: '+ Добавить страницу' }).click();
const cells = page.locator('.wsp-tcell');
(await cells.count()) === 7 ? ok('template picker: 7 live mini-previews') : fail(`picker cells: ${await cells.count()}`);
(await page.locator('.wsp-tcell .pframe').count()) === 7 ? ok('mini-previews are real player frames') : fail('mini-previews not player frames');
await cells.nth(3).click(); // Задание с ответом
await page.waitForTimeout(300);
(await railPages.count()) === 3 ? ok('page added') : fail('page not added');
const names = await page.locator('.wsp-page .tp').allTextContents();
names[names.length - 1] === 'Поздравление'
  ? ok('insert respects terminal congrats (added before final)') : fail('insert after congrats: ' + names.join(', '));

/* 5. Гейты: ошибки на странице задания, чип в шапке */
(await page.locator('.wsp-page .dot.err').count()) ? ok('gate dot on invalid page') : fail('gate dot missing');
(await page.locator('.wsp-pageerrs').count()) ? ok('page errors panel visible') : fail('page errors panel missing');

/* 6. Ответы: добавление + живой тест общим матчером */
await page.locator('button', { hasText: '+ Добавить ответ' }).click();
await page.locator('.ans-row input').first().fill('1730');
await page.locator('.ans-test input').fill('  В 1730 ');
await page.waitForTimeout(200);
(await page.locator('.ans-verdict').textContent())?.includes('зачтено')
  ? ok('answer matcher live test (trim+case)') : fail('matcher verdict wrong');

/* 7. Превью «с ошибкой ответа» тоггл */
(await page.locator('.wsp-preview .adm-toggle', { hasText: 'С ошибкой ответа' }).count())
  ? ok('wrong-answer preview toggle present') : fail('wrong toggle missing');

/* 8. Дубликат и двухтактное удаление */
await page.locator('button', { hasText: 'Дублировать' }).click();
await page.waitForTimeout(200);
(await railPages.count()) === 4 ? ok('duplicate works') : fail('duplicate failed');
(await page.locator('.wsp-page.active .nm').textContent())?.includes('(копия)')
  ? ok('duplicate selects the copy') : fail('selection did not move to the copy');
const danger = page.locator('button.adm-btn--danger', { hasText: 'Удалить' });
await danger.click();
(await page.locator('button', { hasText: 'Точно удалить?' }).count())
  ? ok('two-tap delete arms') : fail('two-tap delete did not arm');
await page.locator('button', { hasText: 'Точно удалить?' }).click();
await page.waitForTimeout(200);
(await railPages.count()) === 3 ? ok('armed delete removes page') : fail('delete failed');
(await page.locator('.wsp-page.active').count()) === 1
  ? ok('delete moves selection to a neighbour') : fail('selection lost after delete');

/* 9. Тест-игрок: черновик, монеты, подсказка после 2-й ошибки, Esc */
await page.locator('button', { hasText: '▶ Тест-игрок' }).click();
await page.waitForTimeout(400);
(await page.locator('.wsp-test').count()) ? ok('test player overlay opens') : fail('test overlay missing');
// пройти старт
await page.locator('.wsp-test .p-btn', { hasText: 'начать квест' }).click();
await page.waitForTimeout(300);
// задание с ответом: 2 неверных → попап подсказки
const answerInput = page.locator('.wsp-test .p-input');
if (await answerInput.count()) {
  await answerInput.fill('неверный');
  await page.locator('.wsp-test .p-btn', { hasText: 'Ответить' }).click();
  await page.waitForTimeout(250);
  (await page.locator('.wsp-test .p-wrong').count()) ? ok('wrong answer flash') : fail('no wrong flash');
  await answerInput.fill('тоже неверный');
  await page.locator('.wsp-test .p-btn', { hasText: 'Ответить' }).click();
  await page.waitForTimeout(250);
  (await page.locator('.wsp-test .p-popup__title', { hasText: 'Нужна подсказка' }).count())
    ? ok('hint popup after 2nd wrong answer') : fail('hint popup missing');
  await page.locator('.wsp-test .p-btn--ghost', { hasText: 'Попробую сам' }).click();
  // правильный ответ → монеты
  await answerInput.fill('1730');
  await page.locator('.wsp-test .p-btn', { hasText: 'Ответить' }).click();
  await page.waitForTimeout(500);
  const coinsTxt = await page.locator('.wsp-test .p-coins').textContent();
  parseInt(coinsTxt || '0', 10) >= 5 ? ok('gift coins awarded on correct answer') : fail(`coins after correct: ${coinsTxt}`);
} else {
  fail('test player: answer input not found');
}
// финал: бонус прохождения
await page.waitForTimeout(1200);
if (await page.locator('.wsp-test .p-final-stats').count()) {
  ok('terminal congrats with stats reached');
} else fail('did not reach congrats in test');
// старт с любого шага
await page.selectOption('#wsp-test-from', '1');
await page.waitForTimeout(300);
(await page.locator('.wsp-test .p-top__progress').textContent())?.trim().startsWith('2')
  ? ok('test can start from any step') : fail('start-from-step broken');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
(await page.locator('.wsp-test').count()) === 0 ? ok('Esc closes test player') : fail('Esc did not close');

/* 10. Публикация: гейты блокируют; после заполнения — модалка и успех */
await page.locator('.wsp-navitem', { hasText: 'Публикация и версии' }).click();
await page.waitForTimeout(300);
(await page.locator('.gate-list').count()) ? ok('publish checklist renders') : fail('checklist missing');
const pubBtn = page.locator('.gate-sum button.adm-btn');
(await pubBtn.isDisabled()) ? ok('publish blocked by gate errors (no task comic)') : fail('publish not blocked');
// «Исправить» прыгает на страницу
const fixBtn = page.locator('.gate-row .fix').first();
if (await fixBtn.count()) {
  await fixBtn.click();
  await page.waitForTimeout(300);
  (await page.locator('.wsp-pageerrs').count()) ? ok('«Исправить» jumps to the broken page') : fail('fix jump failed');
} else fail('no fix button on checklist');
// загрузка изображения: реальный файл в зону «задание»
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGNk+M9Qz4AFMGETHFwSAEOZAhU8mJ9HAAAAAElFTkSuQmCC', 'base64');
await page.locator('.comic-zone input[type=file]').first().setInputFiles({ name: 'task.png', mimeType: 'image/png', buffer: png });
await page.waitForTimeout(600);
(await page.locator('.comic-zone.filled').count()) ? ok('real image upload fills comic zone') : fail('image upload failed');
// гейты позеленели → публикуем
await page.locator('.wsp-navitem', { hasText: 'Публикация и версии' }).click();
await page.waitForTimeout(300);
if (!(await pubBtn.isDisabled())) {
  ok('gates recompute live → publish unblocked');
  await pubBtn.click();
  await page.waitForTimeout(200);
  (await page.locator('.adm-modal h3', { hasText: 'Опубликовать версию' }).count())
    ? ok('publish modal opens') : fail('publish modal missing');
  await page.locator('.adm-modal button', { hasText: /Опубликовать v/ }).click();
  await page.waitForTimeout(1500);
  if (await page.locator('.wsp-banner').count()) ok('published to live backend (success banner)');
  else if (await page.locator('.wsp-error').count()) fail('publish error: ' + await page.locator('.wsp-error').textContent());
  else fail('no publish result banner');
  (await page.locator('.ver-row', { hasText: 'Версия 1' }).count())
    ? ok('version row appears, immutable history') : fail('version row missing');
} else {
  fail('publish still blocked after fixes: ' + (await page.locator('.gate-row.err').allTextContents()).join('; '));
}

/* 11. Черновик переживает перезагрузку */
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
(await page.locator('.wsp-builder').count()) ? ok('reload restores builder position') : fail('reload lost position');
(await page.locator('.wsp-crumbs b').textContent())?.includes('Пробный квест')
  ? ok('draft survives reload') : fail('draft lost on reload');

/* 12. Назад к списку: новый квест в списке */
await page.locator('.wsp-crumbs a', { hasText: 'Квесты' }).click();
await page.waitForTimeout(300);
(await page.locator('.wsp-qrow', { hasText: 'Пробный квест' }).count())
  ? ok('quest list shows the created quest') : fail('created quest missing from list');

await page.screenshot({ path: '/tmp/constructor-v2.png', fullPage: true });
await browser.close();
console.log(errors.length ? `\n${errors.length} FAILURES` : '\nALL CHECKS PASSED');
process.exit(errors.length ? 1 : 0);
