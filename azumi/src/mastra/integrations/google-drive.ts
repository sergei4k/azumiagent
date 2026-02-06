/**
 * Google Drive integration – upload candidate files (resumes, videos) for permanent storage.
 * Uses a service account. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (stringified JSON) or
 * GOOGLE_DRIVE_KEY_FILE_PATH. Optionally set GOOGLE_DRIVE_FOLDER_ID to upload into a folder.
 */

import { Readable } from 'stream';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function getAuth() {
  // Support both variable names: GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or GOOGLE_DRIVE_SERVICE_ACCOUNT
  const json = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT;
  const keyPath = process.env.GOOGLE_DRIVE_KEY_FILE_PATH;
  if (json) {
    try {
      // Handle multi-line JSON (replace newlines and extra spaces)
      const cleanedJson = json.replace(/\n/g, '').replace(/\s+/g, ' ').trim();
      const credentials = JSON.parse(cleanedJson);
      return new google.auth.GoogleAuth({
        credentials,
        scopes: SCOPES,
      });
    } catch (e) {
      // If cleaning didn't work, try parsing as-is (some env parsers handle multi-line)
      try {
        const credentials = JSON.parse(json);
        return new google.auth.GoogleAuth({
          credentials,
          scopes: SCOPES,
        });
      } catch (e2) {
        throw new Error('Invalid Google Drive service account JSON: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
  }
  if (keyPath) {
    return new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: SCOPES,
    });
  }
  return null;
}

export type UploadResult = {
  fileId: string;
  webViewLink: string;
  /** Direct download URL (works when file is shared "anyone with link") – use for AmoCRM etc. */
  downloadUrl: string;
};

/**
 * Download file from sourceUrl and upload to Google Drive.
 * Shares the file as "anyone with the link can view" so downloadUrl is usable by AmoCRM.
 */
export async function uploadFileFromUrl(
  sourceUrl: string,
  fileName: string,
  mimeType?: string,
  folderId?: string
): Promise<UploadResult | null> {
  const auth = getAuth();
  if (!auth) {
    console.warn('Google Drive: no credentials (GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or GOOGLE_DRIVE_KEY_FILE_PATH). Skipping upload.');
    return null;
  }

  const drive = google.drive({ version: 'v3', auth });
  const targetFolderId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  let buffer: Buffer;
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch (e) {
    console.error('Google Drive: failed to download file from URL:', e);
    return null;
  }

  if (buffer.length === 0) {
    console.warn('Google Drive: skipping empty file', fileName);
    return null;
  }

  const fileMetadata: { name: string; parents?: string[] } = {
    name: fileName || 'candidate-file',
  };
  if (targetFolderId) fileMetadata.parents = [targetFolderId];

  const mime = mimeType || 'application/octet-stream';
  const body = buffer.length ? Readable.from(buffer) : undefined;

  try {
    const createRes = await drive.files.create({
      requestBody: fileMetadata,
      media: body ? { mimeType: mime, body } : undefined,
      fields: 'id, webViewLink',
    });

    const fileId = createRes.data.id;
    if (!fileId) throw new Error('No file id returned');

    // Allow "anyone with the link" to view (so AmoCRM can download)
    await drive.permissions.create({
      fileId,
      requestBody: {
        type: 'anyone',
        role: 'reader',
      },
    });

    const webViewLink = createRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    console.log('Google Drive: uploaded', fileName, '->', fileId);
    return { fileId, webViewLink, downloadUrl };
  } catch (e) {
    console.error('Google Drive: upload failed:', e);
    return null;
  }
}
