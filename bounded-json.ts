export async function readJSON(req: Request, limit = 8192): Promise<unknown> {
  const tooLarge = () => Object.assign(new Error("Request body is too large."), { status: 413 });
  if (Number(req.headers.get("content-length")) > limit) throw tooLarge();
  if (!req.body) throw new SyntaxError("Request body is missing.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw tooLarge(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
