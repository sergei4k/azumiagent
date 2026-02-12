/**
 * Shared File Store
 * Stores files (resumes, videos) by phone number for access by candidate-intake-tool
 * Used by both Telegram and WhatsApp integrations
 */

// Shared file store keyed by phone number (for tool access)
// Format: phone -> { resumeFile?, introVideoFile? }
export type FileStoreEntry = {
  resumeFile?: {
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
  };
  introVideoFile?: {
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
    duration?: number;
  };
};

export const fileStoreByPhone: Map<string, FileStoreEntry> = new Map();

// ── Web upload store ────────────────────────────────────────────────────
// Files uploaded via the web upload page (for large files that exceed Telegram bot limits).
// Keyed by Telegram userId so the webhook handler can merge them into pendingFiles.
export type WebUploadEntry = {
  type: 'video' | 'resume';
  fileUrl: string;
  fileName: string;
  fileType?: string;
  uploadedAt: number;
};

export const webUploadsByUserId: Map<number, WebUploadEntry[]> = new Map();
