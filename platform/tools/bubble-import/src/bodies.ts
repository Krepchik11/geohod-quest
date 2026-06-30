/** Build all 19 CtorQuest bodies from the committed raw archive (offline). */
import { questToCtorQuest, type CtorQuestBody } from './mapping.ts';
import { makeMediaResolver, readRaw } from './io.ts';
import type { BubbleQuest } from './types.ts';

export interface BuiltBody {
  quest: BubbleQuest;
  body: CtorQuestBody;
}

export function buildAllBodies(): BuiltBody[] {
  const { quests, byId } = readRaw();
  const media = makeMediaResolver();
  return quests.map((quest) => ({ quest, body: questToCtorQuest(quest, byId, media) }));
}
