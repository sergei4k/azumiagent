/**
 * WhatsApp Message Handler
 * Processes incoming WhatsApp messages via Baileys and routes them to the Azumi agent.
 * Mirrors the Telegram webhook handler logic.
 */

import type { proto } from '@whiskeysockets/baileys';
import { mastra } from '../index';
import {
  sendWhatsAppMessage,
  sendLongWhatsAppMessage,
  sendWhatsAppTyping,
  downloadWhatsAppMedia,
  phoneFromJid,
} from './whatsapp-client';

import { fileStoreByPhone, type FileStoreEntry } from './shared-file-store';
import { uploadFileBuffer } from './google-drive';
import { logTelegramMessage, upsertCandidateActivity } from '../../../db-pg';
import { getWhatsappCrmContextForBot } from './amocrm';

const pausedChats = new Set<string>();

export function pauseChat(jid: string): void {
  pausedChats.add(jid);
  console.log(`⏸️ [WA] Bot paused for ${jid}`);
}

export function resumeChat(jid: string): void {
  pausedChats.delete(jid);
  console.log(`▶️ [WA] Bot resumed for ${jid}`);
}

export function isChatPaused(jid: string): boolean {
  return pausedChats.has(jid);
}

export function getPausedChats(): string[] {
  return Array.from(pausedChats);
}

const userContexts: Map<
  string,
  {
    lastMessageTime: number;
    pendingFiles: {
      type: 'resume' | 'video';
      fileId: string;
      fileName?: string;
      fileType?: string;
      fileUrl?: string;
      duration?: number;
    }[];
    phoneNumber?: string;
  }
> = new Map();

function storeFilesByPhone(phone: string, jid: string): void {
  const context = userContexts.get(jid);
  if (!context || context.pendingFiles.length === 0) return;

  const files: FileStoreEntry = {};

  for (const file of context.pendingFiles) {
    if (file.type === 'resume' && !files.resumeFile) {
      files.resumeFile = {
        fileId: file.fileId,
        fileName: file.fileName,
        fileType: file.fileType,
        fileUrl: file.fileUrl,
      };
    }
    if (file.type === 'video' && !files.introVideoFile) {
      files.introVideoFile = {
        fileId: file.fileId,
        fileName: file.fileName,
        fileType: file.fileType,
        fileUrl: file.fileUrl,
        duration: file.duration,
      };
    }
  }

  if (files.resumeFile || files.introVideoFile) {
    const normalizedPhone = phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
    fileStoreByPhone.set(normalizedPhone, files);
    console.log(`📎 [WA] Stored files for phone ${normalizedPhone}:`, {
      hasResume: !!files.resumeFile,
      hasVideo: !!files.introVideoFile,
    });
  }
}

function extractPhoneFromMessage(text: string): string | null {
  if (!text?.trim()) return null;
  const m = text.match(/\+?[0-9][0-9\s\-\(\)\.]{8,}/);
  return m ? m[0].trim() : null;
}

function extractPhoneFromResponse(response: any): string | null {
  if (response?.toolCalls) {
    for (const toolCall of response.toolCalls) {
      const args = (toolCall as any)?.args || (toolCall as any)?.payload?.args;
      if (args?.phone) return args.phone;
    }
  }
  if (response?.toolResults) {
    for (const toolResult of response.toolResults) {
      const result = (toolResult as any)?.payload?.result || (toolResult as any)?.result;
      if (result?.phone) return result.phone;
    }
  }
  return null;
}

function extractText(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  );
}

function extractFileInfo(msg: proto.IWebMessageInfo): {
  type: 'document' | 'video' | 'photo';
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  duration?: number;
} | null {
  const m = msg.message;
  if (!m) return null;

  if (m.documentMessage) {
    return {
      type: 'document',
      fileName: m.documentMessage.fileName || undefined,
      fileType: m.documentMessage.mimetype || undefined,
      fileSize: m.documentMessage.fileLength
        ? Number(m.documentMessage.fileLength)
        : undefined,
    };
  }
  if (m.videoMessage) {
    return {
      type: 'video',
      fileName: undefined,
      fileType: m.videoMessage.mimetype || undefined,
      fileSize: m.videoMessage.fileLength
        ? Number(m.videoMessage.fileLength)
        : undefined,
      duration: m.videoMessage.seconds || undefined,
    };
  }
  if (m.imageMessage) {
    return {
      type: 'photo',
      fileType: m.imageMessage.mimetype || 'image/jpeg',
      fileSize: m.imageMessage.fileLength
        ? Number(m.imageMessage.fileLength)
        : undefined,
    };
  }

  return null;
}

/** Convert a WhatsApp phone string to a numeric DB id (last 15 digits). */
function phoneToDbId(phone: string): number {
  const digits = phone.replace(/\D/g, '');
  return parseInt(digits.slice(-15), 10) || 0;
}

/**
 * Main message handler — called for each incoming WhatsApp message
 */
export async function handleWhatsAppMessage(msg: proto.IWebMessageInfo): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  const phone = phoneFromJid(jid);
  const pushName = msg.pushName || phone;
  const dbId = phoneToDbId(phone);
  const text = extractText(msg);

  if (pausedChats.has(jid)) {
    console.log(`⏸️ [WA] Skipping (paused): ${pushName} (${phone}): ${text || '[file]'}`);
    return;
  }

  console.log(`📩 [WA] Message from ${pushName} (${phone}): ${text || '[file]'}`);

  try {
    const logText =
      text ||
      (msg.message?.documentMessage
        ? `[document: ${msg.message.documentMessage.fileName || 'file'}]`
        : msg.message?.videoMessage
          ? '[video]'
          : msg.message?.imageMessage
            ? '[photo]'
            : '[non-text message]');

    await logTelegramMessage({
      chatId: dbId,
      userId: dbId,
      sender: 'user',
      text: logText,
      channel: 'whatsapp',
    });

    const displayName = (msg.pushName || '').trim() || phone;
    await upsertCandidateActivity({
      chatId: dbId,
      userId: dbId,
      firstName: displayName,
    });
  } catch (e) {
    console.warn('[WA] Failed to log incoming message:', e);
  }

  const crmCtx = await getWhatsappCrmContextForBot(phone);
  if (!crmCtx.allowBot) {
    console.log(`🛑 [WA] Bot skipped — CRM lead not in "new candidates" status (${phone})`);
    return;
  }

  try {
    await sendWhatsAppTyping(jid);

    let context = userContexts.get(jid);
    if (!context) {
      context = { lastMessageTime: Date.now(), pendingFiles: [] };
      userContexts.set(jid, context);
    }
    context.lastMessageTime = Date.now();

    const fileInfo = extractFileInfo(msg);
    if (fileInfo) {
      await handleFileUpload(jid, phone, msg, fileInfo);
      const fileLabel =
        fileInfo.type === 'video'
          ? 'intro video'
          : fileInfo.type === 'document'
            ? 'resume/CV'
            : 'file';
      const caption = text;
      const fileNotice = caption
        ? `[Candidate just sent their ${fileLabel}${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''} and it has been received successfully.] They also wrote: ${caption}`
        : `[Candidate just sent their ${fileLabel}${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''} and it has been received successfully. Do NOT ask for this file again.]`;
      await handleTextMessage(jid, phone, pushName, fileNotice, crmCtx.preface);
      return;
    }

    if (text) {
      await handleTextMessage(jid, phone, pushName, text, crmCtx.preface);
    }
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error(`[WA] Error handling message from ${phone}:`, errMessage);

    try {
      await sendWhatsAppMessage(
        jid,
        'I apologize, but I encountered an error processing your message. Please try again or contact us directly at +7 968 599 93 60.',
      );
    } catch (sendErr) {
      console.error('[WA] Failed to send error message:', sendErr);
    }
  }
}

async function handleTextMessage(
  jid: string,
  phone: string,
  pushName: string,
  text: string,
  crmPreface: string,
): Promise<void> {
  const context = userContexts.get(jid);
  const dbId = phoneToDbId(phone);

  if (context?.pendingFiles?.length) {
    const phoneFromMsg = extractPhoneFromMessage(text);
    const phoneToUse = phoneFromMsg ?? context.phoneNumber ?? `+${phone}`;
    if (phoneToUse) {
      console.log(
        '[WA] Pre-storing %d pending file(s) by phone before agent runs',
        context.pendingFiles.length,
      );
      storeFilesByPhone(phoneToUse, jid);
    }
  }

  const agent = mastra.getAgent('azumiAgent');

  const textForAgent = `${crmPreface}\n\n---\nCandidate message:\n${text}`;

  let response;
  try {
    response = await agent.generate(textForAgent, {
      memory: {
        thread: `whatsapp-${phone}`,
        resource: `whatsapp-user-${phone}`,
      },
      maxSteps: 10,
    });
  } catch (err) {
    console.error('[WA] Agent generate failed:', err);
    throw err;
  }

  let responseText = response?.text?.trim() || null;

  if (!responseText) {
    const steps = response?.steps?.length ?? 0;
    const toolCalls = response?.toolCalls?.length ?? 0;
    const toolResults = response?.toolResults?.length ?? 0;
    console.warn(
      `[WA] Agent returned no text. finishReason=${response?.finishReason} | steps=${steps} | toolCalls=${toolCalls} | toolResults=${toolResults}`,
    );

    if (response?.reasoningText?.trim()) {
      responseText = response.reasoningText.trim();
    }

    if (!responseText && response?.steps?.length) {
      for (let i = response.steps.length - 1; i >= 0; i--) {
        const step = response.steps[i] as any;
        const t =
          step?.text?.trim() ||
          step?.response?.text?.trim() ||
          step?.content?.trim() ||
          (Array.isArray(step?.content)
            ? step.content
                .map((c: any) => c?.text || c)
                .join(' ')
                .trim()
            : null);
        if (t) {
          responseText = t;
          break;
        }
      }
    }

    if (!responseText && toolResults > 0 && response?.toolResults) {
      const lastToolResult = response.toolResults[response.toolResults.length - 1];
      const toolName =
        (lastToolResult as any)?.payload?.toolName ||
        (lastToolResult as any)?.toolName ||
        'tool';
      const toolResult =
        (lastToolResult as any)?.payload?.result || (lastToolResult as any)?.result;

      if (toolName === 'lookup-candidate') {
        responseText = toolResult?.found
          ? 'Our team will get back to you soon.'
          : 'We can continue and collect your application details here.';
      } else if (toolName === 'submit-candidate-application') {
        responseText = toolResult?.success
          ? 'Thank you! Your application has been submitted. Our team will review it and get back to you soon.'
          : "I've noted your information. Is there anything else you'd like to add?";
      } else if (toolName === 'attach-files-to-existing-lead') {
        responseText = toolResult?.success
          ? "I've attached your files to your application. Our team will review them soon."
          : toolResult?.message || "I couldn't attach the files. Please try sending them again.";
      } else {
        responseText = "I've processed that. Is there anything else you'd like to add?";
      }
    }

    if (!responseText && toolCalls > 0) {
      responseText =
        "I've noted that. Is there anything else you'd like to add, or shall we continue with your application?";
    }
  }

  const raw =
    responseText || 'I apologize, I was unable to generate a response. Please try again.';
  const messageToSend = raw.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  await sendLongWhatsAppMessage(jid, messageToSend);

  const phoneNumber = extractPhoneFromResponse(response);
  if (phoneNumber) {
    storeFilesByPhone(phoneNumber, jid);
    if (context) context.phoneNumber = phoneNumber;
  }

  logTelegramMessage({ chatId: dbId, userId: dbId, sender: 'bot', text: messageToSend, channel: 'whatsapp' }).catch(
    () => {},
  );

  console.log(`📤 [WA] Sent response to ${pushName} (${phone})`);
}

async function handleFileUpload(
  jid: string,
  phone: string,
  msg: proto.IWebMessageInfo,
  fileInfo: {
    type: 'document' | 'video' | 'photo';
    fileName?: string;
    fileType?: string;
    fileSize?: number;
    duration?: number;
  },
): Promise<void> {
  const context = userContexts.get(jid)!;

  const buffer = await downloadWhatsAppMedia(msg);
  if (!buffer || buffer.length === 0) {
    await sendWhatsAppMessage(jid, "I couldn't download your file. Please try sending it again.");
    return;
  }

  console.log(
    `📥 [WA] Downloaded ${fileInfo.fileName || fileInfo.type}: ${(buffer.length / 1024).toFixed(1)} KB`,
  );

  let fileUrl: string | undefined;
  const driveName =
    fileInfo.fileName ||
    (fileInfo.type === 'video'
      ? 'intro-video.mp4'
      : fileInfo.type === 'photo'
        ? 'photo.jpg'
        : 'resume.pdf');
  const driveResult = await uploadFileBuffer(
    buffer,
    `wa-${phone}-${driveName}`,
    fileInfo.fileType,
  );

  if (driveResult) {
    fileUrl = driveResult.downloadUrl;
    console.log(`✅ [WA] File uploaded to Google Drive: ${driveName} → ${driveResult.webViewLink}`);
  } else {
    console.warn(`⚠️ [WA] Google Drive upload failed for ${driveName}`);
  }

  if (fileInfo.type === 'video' || fileInfo.fileType?.startsWith('video/')) {
    context.pendingFiles.push({
      type: 'video',
      fileId: `wa-${Date.now()}`,
      fileName: fileInfo.fileName,
      fileType: fileInfo.fileType,
      fileUrl,
      duration: fileInfo.duration,
    });
  } else if (
    fileInfo.type === 'document' ||
    fileInfo.fileType?.includes('pdf') ||
    fileInfo.fileType?.includes('word') ||
    fileInfo.fileType?.includes('document') ||
    fileInfo.fileName?.match(/\.(pdf|doc|docx|rtf)$/i)
  ) {
    context.pendingFiles.push({
      type: 'resume',
      fileId: `wa-${Date.now()}`,
      fileName: fileInfo.fileName,
      fileType: fileInfo.fileType,
      fileUrl,
    });
  }
}

export function cleanupOldContexts(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [jid, context] of userContexts) {
    if (now - context.lastMessageTime > maxAgeMs) {
      userContexts.delete(jid);
    }
  }
}
