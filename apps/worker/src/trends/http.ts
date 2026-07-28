export class BoundedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedResponseError';
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Preserve the caller's safe status error. */ }
}

const rejectOversized = async (response: Response): Promise<never> => {
  await response.body?.cancel();
  throw new BoundedResponseError('Response body exceeds the size limit');
};

export async function readBoundedJson(response: Response, maxBytes = 512_000): Promise<unknown> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer');
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return rejectOversized(response);
  if (response.body === null) {
    try { return JSON.parse(await response.text()) as unknown; }
    catch { throw new BoundedResponseError('Response body is not valid JSON'); }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BoundedResponseError('Response body exceeds the size limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch (error) {
    if (error instanceof BoundedResponseError) throw error;
    throw new BoundedResponseError('Response body is not valid JSON');
  }
}
