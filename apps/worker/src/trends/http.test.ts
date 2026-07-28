import { describe, expect, it, vi } from 'vitest';
import { BoundedResponseError, cancelResponseBody, readBoundedJson } from './http.js';

describe('bounded trend HTTP responses', () => {
  it('cancels a failed response body exactly once and swallows cancellation errors', async () => {
    const response = new Response('failed body');
    const cancel = vi.spyOn(response.body!, 'cancel').mockRejectedValue(new Error('private cancel failure'));

    await expect(cancelResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects a declared JSON body larger than the configured limit without parsing it', async () => {
    const response = new Response('{"private":"body"}', {
      headers: { 'content-length': '1000', 'content-type': 'application/json' },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');

    await expect(readBoundedJson(response, 10)).rejects.toEqual(
      new BoundedResponseError('Response body exceeds the size limit'),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stops streaming JSON once the byte limit is exceeded', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode('too-large"}'));
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } });

    await expect(readBoundedJson(response, 12)).rejects.toMatchObject({
      message: 'Response body exceeds the size limit',
    });
    expect(cancelled).toBe(true);
  });

  it('parses a bounded JSON response without retaining its source text', async () => {
    await expect(readBoundedJson(new Response('{"ok":true}'), 100)).resolves.toEqual({ ok: true });
  });
});
