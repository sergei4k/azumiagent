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
