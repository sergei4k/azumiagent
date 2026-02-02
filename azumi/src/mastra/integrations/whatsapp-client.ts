/**
 * Twilio WhatsApp API Client
 * Handles sending messages and media via Twilio WhatsApp
 */

import twilio from 'twilio';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // Default sandbox number

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

export interface WhatsAppMessage {
  MessageSid: string;
  AccountSid: string;
  From: string; // e.g., "whatsapp:+1234567890"
  To: string;   // e.g., "whatsapp:+14155238886"
  Body?: string;
  NumMedia?: string; // "0" or "1", etc.
  MediaUrl0?: string;
  MediaContentType0?: string;
  MessageType?: string;
}

/**
 * Send a text message via WhatsApp
 */
export async function sendWhatsAppMessage(
  to: string,
  text: string
): Promise<any> {
  try {
    const message = await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      body: text,
    });

    return message;
  } catch (error) {
    console.error('Twilio WhatsApp API error:', error);
    throw error;
  }
}

/**
 * Send a long message split into chunks (WhatsApp has 4096 char limit per message)
 */
export async function sendLongMessage(
  to: string,
  text: string
): Promise<any[]> {
  const MAX_LENGTH = 4000; // Leave some buffer
  const messages: any[] = [];
  
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
    
    const msg = await sendWhatsAppMessage(to, chunk);
    messages.push(msg);
    
    // Small delay between messages to maintain order
    if (remaining.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return messages;
}

/**
 * Send media file (image, video, document) via WhatsApp
 */
export async function sendWhatsAppMedia(
  to: string,
  mediaUrl: string,
  options?: {
    caption?: string;
    contentType?: string;
  }
): Promise<any> {
  try {
    const message = await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
      mediaUrl: [mediaUrl],
      body: options?.caption,
    });

    return message;
  } catch (error) {
    console.error('Twilio WhatsApp media API error:', error);
    throw error;
  }
}

/**
 * Extract file info from a WhatsApp message (Twilio webhook format)
 */
export function extractFileFromMessage(message: WhatsAppMessage): {
  fileId: string;
  fileName?: string;
  fileType?: string;
  fileUrl?: string;
  duration?: number;
  type: 'document' | 'video' | 'image' | 'audio';
} | null {
  const numMedia = parseInt(message.NumMedia || '0', 10);
  
  if (numMedia === 0) {
    return null;
  }

  // Twilio sends media URLs in MediaUrl0, MediaUrl1, etc.
  const mediaUrl = message.MediaUrl0;
  const contentType = message.MediaContentType0;

  if (!mediaUrl) {
    return null;
  }

  // Determine file type from content type
  let type: 'document' | 'video' | 'image' | 'audio' = 'document';
  if (contentType?.startsWith('video/')) {
    type = 'video';
  } else if (contentType?.startsWith('image/')) {
    type = 'image';
  } else if (contentType?.startsWith('audio/')) {
    type = 'audio';
  }

  // Extract filename from URL if possible (Twilio doesn't always provide this)
  const urlParts = mediaUrl.split('/');
  const fileName = urlParts[urlParts.length - 1]?.split('?')[0];

  return {
    fileId: message.MessageSid, // Use MessageSid as unique identifier
    fileName,
    fileType: contentType,
    fileUrl: mediaUrl,
    type,
  };
}

/**
 * Download media file from Twilio
 * Note: Twilio media URLs are temporary and require authentication
 */
export async function downloadFile(mediaUrl: string): Promise<{
  buffer: ArrayBuffer;
  url: string;
}> {
  // Twilio media URLs require Basic Auth with Account SID and Auth Token
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  
  const response = await fetch(mediaUrl, {
    headers: {
      'Authorization': `Basic ${auth}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  
  return { buffer, url: mediaUrl };
}

/**
 * Get media URL from Twilio message
 * Twilio provides MediaUrl0, MediaUrl1, etc. in webhook payload
 */
export function getMediaUrl(message: WhatsAppMessage, index: number = 0): string | null {
  const mediaUrlKey = `MediaUrl${index}` as keyof WhatsAppMessage;
  return (message[mediaUrlKey] as string) || null;
}
