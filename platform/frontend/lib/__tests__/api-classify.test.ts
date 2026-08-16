import { describe, expect, it } from 'vitest';
import { ApiError, classify } from '../api';

const err = (status: number, body = '') => new ApiError(status, '/api/x', body);

describe('classify', () => {
  it('maps the four exact statuses', () => {
    expect(classify(err(401))).toEqual({ kind: 'unauthorized' });
    expect(classify(err(403))).toEqual({ kind: 'forbidden' });
    expect(classify(err(404))).toEqual({ kind: 'not-found' });
    expect(classify(err(429))).toEqual({ kind: 'rate-limited' });
  });

  it('maps any 5xx to server-broken', () => {
    expect(classify(err(500))).toEqual({ kind: 'server-broken' });
    expect(classify(err(503))).toEqual({ kind: 'server-broken' });
  });

  it('keeps other 4xx as rejected with status and the parsed server reason', () => {
    expect(classify(err(409, '{"error":"Эта почта уже занята"}'))).toEqual({
      kind: 'rejected',
      status: 409,
      error: 'Эта почта уже занята',
    });
    expect(classify(err(400, 'not json'))).toEqual({ kind: 'rejected', status: 400, error: null });
  });

  it('treats a non-ApiError rejection as offline (fetch failed before the server answered)', () => {
    expect(classify(new TypeError('Failed to fetch'))).toEqual({ kind: 'offline' });
    expect(classify(undefined)).toEqual({ kind: 'offline' });
  });
});
