/**
 * REPORT (CLI): generated/report.md — a human-auditable summary of the import:
 * per-quest stats + every lossy/risky decision surfaced (missing art, kept '11',
 * dropped media, oversized bundles, synthesized emails). `npm run report`
 */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { computeGates } from '../../../frontend/lib/constructor-model.ts';
import { GEN, GEN_DIR, RAW, runAsMain } from './config.ts';
import { buildAllBodies } from './bodies.ts';
import { readRaw } from './io.ts';
import { normalizeUrl } from './media.ts';
import type { MediaMap } from './media.ts';
import { authorEmail, authorName, realEmail } from './authors.ts';

const L: string[] = [];
const w = (s = '') => L.push(s);

async function main(): Promise<void> {
  const { quests, pages, authors } = readRaw();
  const built = buildAllBodies();
  const media = JSON.parse(readFileSync(RAW.mediaMap, 'utf8')) as MediaMap;
  const byQuestId = new Map(pages.map((p) => [p._id, p]));
  const authorById = new Map(authors.map((u) => [u._id, u]));

  const totalSteps = built.reduce((s, b) => s + b.body.steps.length, 0);
  const withReal = authors.filter((u) => realEmail(u)).length;
  const failures = Object.entries(media).filter(([, e]) => e.error);

  w('# Bubble import report');
  w();
  w(`Generated ${new Date().toISOString()}.`);
  w();
  w('## Summary');
  w();
  w(`- **${built.length} quests**, ${totalSteps} steps, imported as \`draft\`.`);
  w(`- **${authors.length} authors** → \`editor\` accounts, all with synthesized \`@imported.geohod.invalid\` emails (real address for ${withReal} kept in raw/ + below). All login-disabled.`);
  w(`- **media**: ${Object.keys(media).length - failures.length} embedded, ${failures.length} failed (below).`);
  w(`- \`'11'\` answer sentinel **kept verbatim** (per decision); affected tasks listed per quest.`);
  w();

  if (failures.length) {
    w('## Media that could not be embedded');
    w();
    w('These become `null`; fix at source or in the editor. Both are single broken legacy assets.');
    w();
    for (const [url, e] of failures) {
      const refs = pages
        .filter((p) => [p.Image_link, p.Hint_Image].some((u) => u && normalizeUrl(u) === url))
        .map((p) => `${p.Quest_name ?? '?'}#${p.Page_number}`);
      const inCovers = quests.filter((q) => q.Preview_image && normalizeUrl(q.Preview_image) === url).map((q) => q.Quest_name_ru);
      w(`- \`${e.error}\` — ${url}`);
      w(`  - referenced by: ${[...refs, ...inCovers.map((c) => `cover:${c}`)].join(', ') || '(none)'}`);
    }
    w();
  }

  w('## Per quest');
  w();
  for (const { quest, body } of built) {
    const gates = computeGates(body);
    const tpl = (t: string) => body.steps.filter((s) => s.template === t).length;
    const missingArt = gates.errors.filter((e) => /нет комикса «задание»/.test(e.text)).length;
    const eleven = body.steps.filter((s) => s.acceptable.includes('11')).length;
    const questPages = (quest.Page ?? []).map((id) => byQuestId.get(id)).filter(Boolean);
    const lostVideo = questPages.filter((p) => p && p.Video_link).length;
    const droppedButtons = questPages.filter((p) => p && p.Button_text_RU && p.Page_type !== 'QuestionNoAnswer').length;

    const author = quest.creatorUser ? authorById.get(quest.creatorUser) : undefined;
    const ae = author ? authorEmail(author) : null;
    const authorLabel = author && ae ? `${authorName(author)} <${ae.email}>${ae.real ? ` (was ${ae.real})` : ''}` : '?';

    w(`### ${body.meta.title}`);
    w();
    w(`- \`${body.id}\` · author **${authorLabel}** · original status **${quest.statusQuest}**${quest.Publish_on_the_site ? ' · on-site' : ''} · price ${body.meta.price}`);
    w(`- steps: **${body.steps.length}** (start ${tpl('start')}, continue ${tpl('continue')}, task_answer ${tpl('task_answer')}, task_no ${tpl('task_no')}, congrats ${tpl('congrats')})`);
    w(`- city: ${body.meta.city || '—'} · duration: ${body.meta.duration || '—'} · bundle: **${gates.sizeLabel}**${gates.sizeMb > 5 ? ' ⚠ >5MB (editor will warn)' : ''}`);
    if (!body.meta.cover) w('- ⚠ no cover');
    if (missingArt) w(`- ⚠ ${missingArt} task step(s) **missing artwork** — blocks publish until added in the editor`);
    if (eleven) w(`- \`'11'\` kept on **${eleven}** answer task(s)`);
    if (lostVideo) w(`- ⚠ ${lostVideo} congrats video(s) **not imported** (model stores no video; URL preserved in raw/)`);
    if (droppedButtons) w(`- ${droppedButtons} custom button label(s) dropped (no model slot outside task_no)`);
    if (body.steps.length <= 2) w('- ⚠ **stub quest** (no real content) — consider excluding before publish');
    w();
  }

  await mkdir(GEN_DIR, { recursive: true });
  await writeFile(GEN.report, L.join('\n'), 'utf8');
  console.log(`wrote ${GEN.report}`);
}

runAsMain(import.meta.url, main);
