/** In-app full thread read (synced bodies); optional `from` is a safe same-app path for Back. */
export function conversationReadPath(conversationId: string, fromPath?: string | null): string {
  const enc = encodeURIComponent(conversationId);
  let path = `/conversation/${enc}`;
  if (fromPath && fromPath.startsWith('/') && !fromPath.startsWith('//')) {
    path += `?from=${encodeURIComponent(fromPath)}`;
  }
  return path;
}
