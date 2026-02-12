/**
 * Telegram Bot API Client
 * Handles sending messages, media, and receiving files from Telegram
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

export interface TelegramMessage {
  message_id: number;
  from: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  chat: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    type: 'private' | 'group' | 'supergroup' | 'channel';
  };
  date: number;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  video?: TelegramVideo;
  photo?: TelegramPhotoSize[];
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Send a text message to a Telegram chat
 */
export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  options?: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    replyToMessageId?: number;
  }
): Promise<TelegramMessage> {
  const response = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: options?.parseMode,
      reply_to_message_id: options?.replyToMessageId,
    }),
  });

  const data = await response.json();
  
  if (!data.ok) {
    console.error('Telegram API error:', data);
    throw new Error(`Telegram API error: ${data.description}`);
  }

  return data.result;
}

/**
 * Send a long message split into chunks (Telegram has 4096 char limit)
 */
export async function sendLongMessage(
  chatId: number | string,
  text: string,
  options?: { parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2' }
): Promise<TelegramMessage[]> {
  const MAX_LENGTH = 4000; // Leave some buffer
  const messages: TelegramMessage[] = [];
  
  // Split by paragraphs first, then by length if needed
  let remaining = text;
  
  while (remaining.length > 0) {
    let chunk: string;
    
    if (remaining.length <= MAX_LENGTH) {
      chunk = remaining;
      remaining = '';
    } else {
      // Find a good break point
      let breakPoint = remaining.lastIndexOf('\n\n', MAX_LENGTH);
      if (breakPoint === -1 || breakPoint < MAX_LENGTH / 2) {
        breakPoint = remaining.lastIndexOf('\n', MAX_LENGTH);
      }
      if (breakPoint === -1 || breakPoint < MAX_LENGTH / 2) {
        breakPoint = remaining.lastIndexOf(' ', MAX_LENGTH);
      }
      if (breakPoint === -1) {
        breakPoint = MAX_LENGTH;
      }
      
      chunk = remaining.substring(0, breakPoint);
      remaining = remaining.substring(breakPoint).trim();
    }
    
    const msg = await sendTelegramMessage(chatId, chunk, options);
    messages.push(msg);
    
    // Small delay between messages to maintain order
    if (remaining.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return messages;
}

/**
 * Send "typing" indicator to show bot is processing
 */
export async function sendTypingAction(chatId: number | string): Promise<void> {
  await fetch(`${TELEGRAM_API_BASE}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      action: 'typing',
    }),
  });
}

/**
 * Get file download URL from Telegram
 */
export async function getFileUrl(fileId: string): Promise<string> {
  const response = await fetch(`${TELEGRAM_API_BASE}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  const data = await response.json();
  
  if (!data.ok) {
    throw new Error(`Failed to get file: ${data.description}`);
  }

  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

/**
 * Download a file from Telegram
 */
export async function downloadFile(fileId: string): Promise<{
  buffer: ArrayBuffer;
  url: string;
}> {
  const url = await getFileUrl(fileId);
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  
  return { buffer, url };
}

/**
 * Extract file info from a Telegram message
 */
export function extractFileFromMessage(message: TelegramMessage): {
  fileId: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  duration?: number;
  type: 'document' | 'video' | 'photo';
} | null {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name,
      fileType: message.document.mime_type,
      fileSize: message.document.file_size,
      type: 'document',
    };
  }
  
  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileName: message.video.file_name,
      fileType: message.video.mime_type,
      fileSize: message.video.file_size,
      duration: message.video.duration,
      type: 'video',
    };
  }
  
  if (message.photo && message.photo.length > 0) {
    // Get the largest photo
    const largestPhoto = message.photo[message.photo.length - 1];
    return {
      fileId: largestPhoto.file_id,
      fileSize: largestPhoto.file_size,
      fileType: 'image/jpeg',
      type: 'photo',
    };
  }
  
  return null;
}

/**
 * Set webhook URL for receiving updates
 */
export async function setWebhook(webhookUrl: string): Promise<boolean> {
  const response = await fetch(`${TELEGRAM_API_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message'],
    }),
  });

  const data = await response.json();
  console.log('Set webhook result:', data);
  
  return data.ok;
}

/**
 * Get current webhook info
 */
export async function getWebhookInfo(): Promise<any> {
  const response = await fetch(`${TELEGRAM_API_BASE}/getWebhookInfo`);
  const data = await response.json();
  return data.result;
}

/**
 * Delete webhook (for switching to polling mode)
 */
export async function deleteWebhook(): Promise<boolean> {
  const response = await fetch(`${TELEGRAM_API_BASE}/deleteWebhook`, {
    method: 'POST',
  });
  const data = await response.json();
  return data.ok;
}
