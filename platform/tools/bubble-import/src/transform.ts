/**
 * TRANSFORM (CLI): write generated/bodies/<quest_id>.json for all 19 quests.
 * Offline — reads the committed raw/ archive. `npm run transform`
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GEN, runAsMain } from './config.ts';
import { buildAllBodies } from './bodies.ts';

async function main(): Promise<void> {
  const built = buildAllBodies();
  await rm(GEN.bodies, { recursive: true, force: true });
  await mkdir(GEN.bodies, { recursive: true });

  let totalMb = 0;
  for (const { body } of built) {
    const json = JSON.stringify(body);
    totalMb += json.length / 1024 / 1024;
    await writeFile(resolve(GEN.bodies, `${body.id}.json`), json, 'utf8');
    console.log(
      `  ${body.id}  steps=${String(body.steps.length).padStart(2)}  ` +
        `${(json.length / 1024 / 1024).toFixed(2)}MB  ${body.meta.title}`,
    );
  }
  console.log(`\n${built.length} bodies written, ${totalMb.toFixed(1)} MB total`);
}

runAsMain(import.meta.url, main);
