/**
 * WhatsApp Message Handler
 * Processes incoming WhatsApp messages via Baileys and routes them to the Azumi agent.
 * Mirrors the Telegram webhook handler logic.
 *
 * Terminology:
 * - `jid` / full JID — WhatsApp chat address (e.g. `...@s.whatsapp.net`, `...@lid`). Not a phone number.
 * - `jidUserPart` / `jidLocal` — substring before `@`; may be phone-like, LID, or other — never assume E.164.
 * - `phoneDigits` — digits only when resolved as a real phone for CRM (`resolvePhoneDigitsForCrm`).
 */

import type { proto } from '@whiskeysockets/baileys';
import { mastra } from '../index';
import {
  sendWhatsAppMessage,
  sendLongWhatsAppMessage,
  sendWhatsAppTyping,
  downloadWhatsAppMedia,
  jidUserPart,
  resolvePhoneDigitsForCrm,
  waThreadKey,
} from './whatsapp-client';

import { fileStoreByPhone, type FileStoreEntry } from './shared-file-store';
import { uploadFileBuffer } from './google-drive';
import { logTelegramMessage, upsertCandidateActivity } from '../../../db-pg';
import { getWhatsappCrmContextForBot } from './amocrm';
import { runWithIntakeChannelAsync } from './intake-context';

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

/** @param contactKey E.164-like string from user message or context — not a raw JID. */
function storeFilesByPhone(contactKey: string, jid: string): void {
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
    const normalizedPhone = contactKey.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
    fileStoreByPhone.set(normalizedPhone, files);
    console.log(`📎 [WA] Stored files for contact key ${normalizedPhone}:`, {
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

/** Map E.164 digit string (no +) to numeric chat id for Postgres — not a JID. */
function e164DigitsToDbId(digitsString: string): number {
  const digits = digitsString.replace(/\D/g, '');
  return parseInt(digits.slice(-15), 10) || 0;
}

/** Opaque chat id when we have no E.164 phone (e.g. @lid-only). Uses JID local part digits or hash — not a phone. */
function jidToDbId(jid: string): number {
  const user = jidUserPart(jid).replace(/\D/g, '');
  if (user.length >= 7) return parseInt(user.slice(-15), 10) || hashJidToPositiveInt(jid);
  return hashJidToPositiveInt(jid);
}

function hashJidToPositiveInt(jid: string): number {
  let h = 0;
  for (let i = 0; i < jid.length; i++) h = (Math.imul(31, h) + jid.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Main message handler — called for each incoming WhatsApp message
 */
export async function handleWhatsAppMessage(msg: proto.IWebMessageInfo): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  const phoneDigits = resolvePhoneDigitsForCrm(jid, msg.key);
  const jidLocal = jidUserPart(jid);
  if (phoneDigits) {
    console.log(`[WA] CRM phone (E.164 digits): ${phoneDigits}`);
  } else {
    console.log(
      `[WA] No CRM phone for this chat — jid local part is not E.164 (e.g. @lid). jid=${jid} local=${jidLocal}`,
    );
  }
  const pushName = msg.pushName || (phoneDigits ? `+${phoneDigits}` : jidLocal);
  const dbId = phoneDigits ? e164DigitsToDbId(phoneDigits) : jidToDbId(jid);
  const text = extractText(msg);

  if (pausedChats.has(jid)) {
    console.log(`⏸️ [WA] Skipping (paused): ${pushName} (${phoneDigits ?? `jid:${jidLocal}`}): ${text || '[file]'}`);
    return;
  }

  console.log(`📩 [WA] Message from ${pushName} (${phoneDigits ? `crm:${phoneDigits}` : `jid:${jidLocal}`}): ${text || '[file]'}`);

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

    const displayName = (msg.pushName || '').trim() || (phoneDigits ? `+${phoneDigits}` : jidLocal);
    await upsertCandidateActivity({
      chatId: dbId,
      userId: dbId,
      firstName: displayName,
    });
  } catch (e) {
    console.warn('[WA] Failed to log incoming message:', e);
  }

  const crmCtx = await getWhatsappCrmContextForBot(phoneDigits);
  if (!crmCtx.allowBot) {
    console.log(`🛑 [WA] Bot skipped — CRM lead not in "new candidates" status (${phoneDigits ?? jid})`);
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
      await handleFileUpload(jid, phoneDigits, msg, fileInfo);
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
      await handleTextMessage(jid, phoneDigits, pushName, fileNotice, crmCtx.preface);
      return;
    }

    if (text) {
      await handleTextMessage(jid, phoneDigits, pushName, text, crmCtx.preface);
    }
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error(`[WA] Error handling message from ${phoneDigits ?? jid}:`, errMessage);

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
  phoneDigits: string | null,
  pushName: string,
  text: string,
  crmPreface: string,
): Promise<void> {
  const context = userContexts.get(jid);
  const dbId = phoneDigits ? e164DigitsToDbId(phoneDigits) : jidToDbId(jid);
  const threadKey = waThreadKey(jid, phoneDigits);

  if (context?.pendingFiles?.length) {
    const phoneFromMsg = extractPhoneFromMessage(text);
    const phoneToUse =
      phoneFromMsg ?? context.phoneNumber ?? (phoneDigits ? `+${phoneDigits}` : null);
    if (phoneToUse) {
      console.log(
        '[WA] Pre-storing %d pending file(s) by contact key before agent runs',
        context.pendingFiles.length,
      );
      storeFilesByPhone(phoneToUse, jid);
    }
  }

  const agent = mastra.getAgent('azumiAgent');

  const textForAgent = `${crmPreface}\n\n---\nCandidate message:\n${text}`;

  let response;
  try {
    response = await runWithIntakeChannelAsync('whatsapp', () =>
      agent.generate(textForAgent, {
        memory: {
          thread: threadKey,
          resource: `whatsapp-user-${threadKey}`,
        },
        maxSteps: 10,
      }),
    );
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

  console.log(`📤 [WA] Sent response to ${pushName} (${phoneDigits ? `crm:${phoneDigits}` : `jid:${jidUserPart(jid)}`})`);
}

async function handleFileUpload(
  jid: string,
  phoneDigits: string | null,
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
    `wa-${phoneDigits ?? `jid-${jidUserPart(jid)}`}-${driveName}`,
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
