import { BUBBLE_BASE } from './config.ts';

interface ListResponse<T> {
  response: { results: T[]; cursor: number; count: number; remaining: number };
}

/** Paginate a bubble Data API type fully (100/page) with the bearer token. */
export async function fetchAll<T>(
  type: string,
  token: string,
  constraints?: unknown,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = 0;
  for (;;) {
    const url = new URL(`${BUBBLE_BASE}/${type}`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('cursor', String(cursor));
    if (constraints) url.searchParams.set('constraints', JSON.stringify(constraints));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`bubble ${type} fetch failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as ListResponse<T>;
    out.push(...body.response.results);
    if (!body.response.remaining) break;
    cursor += body.response.results.length;
  }
  return out;
}
