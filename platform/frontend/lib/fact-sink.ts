/**
 * Fact write-through sinks (issue #65). The engine (lib/play-loop) returns the
 * appended facts as an effect; a FactSink is where the caller pours them.
 *
 * queueFactSink is an ORDERED promise chain — each append awaits the previous
 * one, then the attempt key, then the durable queue write. This replaces the
 * old per-fact fire-and-forget IIFE, whose concurrent writes could reach the
 * queue out of append order. A failure degrades that one fact to in-memory
 * play (console.warn) and the chain continues — storage never blocks play.
 */
import { appendFact as queueAppendFact } from './queue';
import type { Fact } from './shared-model';

export interface FactSink {
  append(fact: Fact): void;
}

export function queueFactSink(getAttemptKey: () => Promise<string>): FactSink {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(fact: Fact): void {
      chain = chain
        .then(async () => {
          const key = await getAttemptKey();
          await queueAppendFact(key, fact);
        })
        .catch((err) => {
          console.warn('fact write-through failed (in-memory only)', err);
        });
    },
  };
}
