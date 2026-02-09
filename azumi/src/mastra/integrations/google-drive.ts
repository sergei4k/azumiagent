/**
 * Google Drive integration – upload candidate files (resumes, videos) for permanent storage.
 *
 * Supports two auth modes:
 *
 * 1. OAuth (personal Gmail, no Shared Drive needed):
 *    Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_FOLDER_ID.
 *    Run: npx tsx scripts/get-google-drive-token.ts to get the refresh token once.
 *
 * 2. Service account (requires Google Workspace Shared Drive):
 *    Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON (or GOOGLE_DRIVE_KEY_FILE_PATH), GOOGLE_DRIVE_FOLDER_ID.
 *    Create a Shared Drive, add the service account as Content manager, create a folder, use its ID.
 */

import { Readable } from 'stream';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function getAuth() {
  // OAuth (personal account) – preferred when no Workspace
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (clientId && clientSecret && refreshToken) {
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'http://localhost:3000/oauth/callback' // Only used during token exchange
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  }

  // Service account
  const json = (
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_DRIVE_CREDENTIALS
  )?.trim();
  const keyPath = process.env.GOOGLE_DRIVE_KEY_FILE_PATH?.trim();
  if (json && json.length > 50) {
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
    console.warn(
      'Google Drive: no credentials. Use OAuth (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) or service account (GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON). See google-drive.ts docs. Skipping upload.'
    );
    return null;
  }

  const drive = google.drive({ version: 'v3', auth });
  const targetFolderId = (folderId || process.env.GOOGLE_DRIVE_FOLDER_ID)?.trim();

  if (!targetFolderId) {
    console.error(
      'Google Drive: GOOGLE_DRIVE_FOLDER_ID is required. OAuth: use any folder ID from your My Drive. Service account: use a folder inside a Shared Drive (Workspace).'
    );
    return null;
  }
  console.log('Google Drive: uploading to folder', targetFolderId);

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

  const fileMetadata: { name: string; parents: string[] } = {
    name: fileName || 'candidate-file',
    parents: [targetFolderId],
  };

  const mime = mimeType || 'application/octet-stream';
  const body = buffer.length ? Readable.from(buffer) : undefined;

  try {
    // supportsAllDrives: true required when folder is in a Shared Drive
    const createRes = await drive.files.create({
      requestBody: fileMetadata,
      media: body ? { mimeType: mime, body } : undefined,
      fields: 'id, webViewLink',
      supportsAllDrives: true,
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
      supportsAllDrives: true,
    });

    const webViewLink = createRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    console.log('Google Drive: uploaded', fileName, '->', fileId, targetFolderId ? `(folder: ${targetFolderId})` : '');
    return { fileId, webViewLink, downloadUrl };
  } catch (e: any) {
    const msg = e?.message || e?.errors?.[0]?.message || String(e);
    console.error('Google Drive: upload failed:', msg);
    if (msg.includes('quota') || msg.includes('storage')) {
      console.error(
        'Google Drive: If using service account, you need a Shared Drive (Workspace). Or switch to OAuth with personal Gmail.'
      );
    } else if (msg.includes('403') || msg.includes('not found') || msg.includes('insufficient')) {
      console.error(
        'Google Drive: OAuth: ensure folder exists in your My Drive. Service account: ensure folder is in a Shared Drive with SA as Content manager.'
      );
    }
    return null;
  }
}
