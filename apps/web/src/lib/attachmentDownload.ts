export async function downloadAttachmentBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}
