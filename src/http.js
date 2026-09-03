export async function readBoundedJsonResponse(response, maxBytes) {
  if (!response || !response.headers || !response.body?.getReader || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("response and a positive byte limit are required");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maxBytes) {
      throw new Error("response body exceeds the allowed size");
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("response body exceeds the allowed size");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("response body is not valid JSON");
  }
}
