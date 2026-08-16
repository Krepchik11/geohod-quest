// @vitest-environment node
/**
 * The fact write-through sink (issue #65). The old player fired one
 * fire-and-forget IIFE per fact, so two writes could land in the queue out of
 * append order. queueFactSink is an ORDERED promise chain: a write starts only
 * after the previous one settled, and a failure degrades that one fact to
 * in-memory play without breaking the chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fact } from '../shared-model';

interface Deferred {
  fact: Fact;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const storageCalls: Deferred[] = [];

vi.mock('../queue', () => ({
  appendFact: vi.fn(
    (_key: string, fact: Fact) =>
      new Promise<void>((resolve, reject) => {
        storageCalls.push({ fact, resolve, reject });
      })
  ),
}));

import { queueFactSink } from '../fact-sink';

const fact = (value: string): Fact => ({
  type: 'answer_submitted',
  step_position: 0,
  submitted_value: value,
  local_is_correct: false,
  coins_delta: 0,
  note: null,
  device_id: 'dev-t',
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  storageCalls.length = 0;
  vi.restoreAllMocks();
});

describe('queueFactSink ordering', () => {
  it('serializes writes: the second starts only after the first resolves', async () => {
    const sink = queueFactSink(async () => 'att-1');
    const a = fact('a');
    const b = fact('b');
    sink.append(a);
    sink.append(b);
    await flush();

    // The first write hangs unresolved — the second must NOT have started,
    // so no storage-layer race can reorder them.
    expect(storageCalls.map((c) => c.fact)).toEqual([a]);

    storageCalls[0].resolve();
    await flush();
    expect(storageCalls.map((c) => c.fact)).toEqual([a, b]);

    storageCalls[1].resolve();
    await flush();
  });

  it('awaits getAttemptKey per append, in order', async () => {
    const keys: string[] = [];
    let resolveKey: (k: string) => void = () => {};
    const sink = queueFactSink(
      () =>
        new Promise<string>((resolve) => {
          resolveKey = (k) => {
            keys.push(k);
            resolve(k);
          };
        })
    );
    sink.append(fact('a'));
    await flush();
    expect(storageCalls).toHaveLength(0); // key not resolved yet → no write
    resolveKey('att-1');
    await flush();
    expect(keys).toEqual(['att-1']);
    expect(storageCalls.map((c) => c.fact.submitted_value)).toEqual(['a']);
    storageCalls[0].resolve();
    await flush();
  });

  it('a failed write warns and the chain continues with the next fact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = queueFactSink(async () => 'att-1');
    sink.append(fact('a'));
    sink.append(fact('b'));
    await flush();

    storageCalls[0].reject(new Error('quota'));
    await flush();
    expect(warn).toHaveBeenCalledWith(
      'fact write-through failed (in-memory only)',
      expect.any(Error)
    );

    // The chain survives: b still reaches storage.
    expect(storageCalls.map((c) => c.fact.submitted_value)).toEqual(['a', 'b']);
    storageCalls[1].resolve();
    await flush();
  });

  it('a failed getAttemptKey degrades that fact only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const sink = queueFactSink(async () => {
      calls += 1;
      if (calls === 1) throw new Error('no attempt');
      return 'att-1';
    });
    sink.append(fact('a'));
    sink.append(fact('b'));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(storageCalls.map((c) => c.fact.submitted_value)).toEqual(['b']);
    storageCalls[0].resolve();
    await flush();
  });
});
