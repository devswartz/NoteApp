// Upload helper for images and attachments (server/routes/files.ts).
import { api } from '../api.ts';
import type { UploadedFile } from '../../shared/types.ts';

export const MAX_UPLOAD_MB = 25;

export async function uploadFile(file: File, workspaceId: string, pageId?: string): Promise<UploadedFile> {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`“${file.name}” is larger than ${MAX_UPLOAD_MB} MB`);
  const q = pageId ? `?pageId=${encodeURIComponent(pageId)}` : '';
  return api<UploadedFile>(`/workspaces/${workspaceId}/files${q}`, {
    method: 'POST',
    body: file,
    // octet-stream so the API's JSON body parser never touches the bytes.
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'file') },
  });
}
