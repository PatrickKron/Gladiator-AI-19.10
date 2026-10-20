import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse-parse.js';

/** SSE-Parser für fetch-Streams: Chunks können mitten in einem Event enden. */
describe('createSseParser', () => {
  it('setzt über Chunk-Grenzen zerteilte Events korrekt zusammen', () => {
    const got: { event: string; data: unknown }[] = [];
    const feed = createSseParser((event, data) => got.push({ event, data }));
    feed('event: delta\ndata: {"te');
    feed('xt":"Hal"}\n\nevent: delta\ndata: {"text":"lo"}\n');
    feed('\nevent: done\ndata: {"ok":true}\n\n');
    expect(got).toEqual([
      { event: 'delta', data: { text: 'Hal' } },
      { event: 'delta', data: { text: 'lo' } },
      { event: 'done', data: { ok: true } },
    ]);
  });

  it('ignoriert Kommentarzeilen und kaputtes JSON statt abzustürzen', () => {
    const got: string[] = [];
    const feed = createSseParser((event) => got.push(event));
    feed(': keepalive\n\nevent: delta\ndata: {kaputt\n\nevent: done\ndata: {}\n\n');
    expect(got).toEqual(['done']);
  });
});
