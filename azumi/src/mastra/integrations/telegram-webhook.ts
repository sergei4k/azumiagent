/**
 * Telegram Webhook Handler
 * Processes incoming messages and routes them to the Azumi agent
 */

import { mastra } from '../index';
import {
  TelegramUpdate,
  TelegramMessage,
  sendTelegramMessage,
  sendLongMessage,
  sendTypingAction,
  extractFileFromMessage,
  getFileUrl,
} from './telegram-client';

// Store conversation context per user (in production, use Redis or database)
const userContexts: Map<number, {
  lastMessageTime: number;
  pendingFiles: {
    type: 'resume' | 'video';
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
    duration?: number;
  }[];
  phoneNumber?: string; // Store phone number when we learn it
}> = new Map();

import { fileStoreByPhone, FileStoreEntry, webUploadsByUserId } from './shared-file-store';
import { uploadFileFromUrl } from './google-drive';
import { generateUploadLink } from './file-upload-server';
import { logTelegramMessage, upsertCandidateActivity, markApplicationComplete, setLeadIdForChat, getLeadIdForChat } from '../../../db-pg';
import { addNoteToLead } from './amocrm';

/**
 * Store files by phone number (called when we learn the phone number)
 */
export function storeFilesByPhone(phone: string, userId: number): void {
  const context = userContexts.get(userId);
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
    // Normalize phone number for lookup (must match candidate-intake-tool normalizePhone)
    const normalizedPhone = phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
    fileStoreByPhone.set(normalizedPhone, files);
    console.log(`📎 Stored files for phone ${normalizedPhone}:`, {
      hasResume: !!files.resumeFile,
      hasVideo: !!files.introVideoFile,
      resumeHasUrl: !!files.resumeFile?.fileUrl,
      videoHasUrl: !!files.introVideoFile?.fileUrl,
    });
  }
}

/** Same as candidate-intake-tool – used for consistent lookup key. */
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

/**
 * Extract phone-like string from user message (for pre-storing files before agent runs).
 * Matches +7..., 8..., 00..., or 10+ digits with optional spaces/dashes.
 */
function extractPhoneFromMessage(text: string): string | null {
  if (!text?.trim()) return null;
  // +7 999 123 4567, 89991234567, 00 7 ..., 999 123 4567, etc.
  const m = text.match(/\+?[0-9][0-9\s\-\(\)\.]{8,}/);
  return m ? m[0].trim() : null;
}

/**
 * Extract phone number from agent response or tool calls
 */
function extractPhoneFromResponse(response: any): string | null {
  // Check tool calls for phone numbers
  if (response?.toolCalls) {
    for (const toolCall of response.toolCalls) {
      const args = (toolCall as any)?.args || (toolCall as any)?.payload?.args;
      if (args?.phone) {
        return args.phone;
      }
    }
  }
  
  // Check tool results for phone numbers
  if (response?.toolResults) {
    for (const toolResult of response.toolResults) {
      const result = (toolResult as any)?.payload?.result || (toolResult as any)?.result;
      if (result?.phone) {
        return result.phone;
      }
    }
  }
  
  return null;
}

/**
 * Main webhook handler - call this from your HTTP endpoint
 */
export async function handleTelegramWebhook(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  
  if (!message) {
    console.log('Received update without message, skipping');
    return;
  }

  const chatId = message.chat.id;
  const userId = message.from.id;
  const userFirstName = message.from.first_name;
  
  console.log(`📩 Received message from ${userFirstName} (${userId}): ${message.text || '[file]'}`);

  // Log incoming user message (text or caption or file placeholder)
  try {
    const userText =
      message.text?.trim() ||
      message.caption?.trim() ||
      (message.document
        ? `[document: ${message.document.file_name || message.document.file_id}]`
        : message.video
        ? `[video: ${message.video.file_name || message.video.file_id}]`
        : message.photo
        ? '[photo]'
        : '[non-text message]');

    await logTelegramMessage({
      chatId,
      userId,
      sender: 'user',
      text: userText,
    });
  } catch (e) {
    console.warn('Failed to log incoming Telegram message:', e);
  }

  // Track activity for inactivity reminders
  upsertCandidateActivity({ chatId, userId, firstName: userFirstName }).catch(() => {});

  try {
    // Show typing indicator
    await sendTypingAction(chatId);

    // Initialize or get user context
    let context = userContexts.get(userId);
    if (!context) {
      context = { lastMessageTime: Date.now(), pendingFiles: [] };
      userContexts.set(userId, context);
    }
    context.lastMessageTime = Date.now();

    // Pick up any files uploaded via the web upload page
    const webUploads = webUploadsByUserId.get(userId);
    if (webUploads?.length) {
      for (const upload of webUploads) {
        context.pendingFiles.push({
          type: upload.type,
          fileId: `web-upload-${upload.uploadedAt}`,
          fileName: upload.fileName,
          fileType: upload.fileType,
          fileUrl: upload.fileUrl,
        });
        console.log(`📎 Merged web-uploaded ${upload.type} into pendingFiles for user ${userId}: ${upload.fileName}`);
      }
      webUploadsByUserId.delete(userId);
    }

    // Check if user sent a file
    const fileInfo = extractFileFromMessage(message);
    if (fileInfo) {
      await handleFileUpload(chatId, userId, message, fileInfo);
      // If there was a caption, also let the agent process it
      if (message.caption?.trim()) {
        const fileLabel = fileInfo.type === 'video' ? 'intro video' : fileInfo.type === 'document' ? 'resume' : 'file';
        const captionPrompt = `[Candidate just sent their ${fileLabel}${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''}.] They also wrote: ${message.caption.trim()}`;
        await handleTextMessage(chatId, userId, captionPrompt, userFirstName);
      }
      return;
    }

    // Handle text message
    if (message.text) {
      await handleTextMessage(chatId, userId, message.text, userFirstName);
    }

  } catch (error) {
    const errId = `TG-${Date.now().toString(36)}`;
    const errMessage = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    console.error(`[${errId}] Telegram webhook error:`, errMessage);
    if (errStack) console.error(errStack);
    
    try {
      await sendTelegramMessage(
        chatId,
        'I apologize, but I encountered an error processing your message. Please try again or contact us directly at +7 968 599 93 60.'
      );
    } catch (sendErr) {
      console.error(`[${errId}] Failed to send error message to user:`, sendErr);
    }
  }
}

/**
 * Handle text messages by routing to the agent
 */
async function handleTextMessage(
  chatId: number,
  userId: number,
  text: string,
  userFirstName: string
): Promise<void> {
  const context = userContexts.get(userId);

  // Pre-store files by phone BEFORE agent runs, so submit/attach-files tools can find them.
  // We learn phone from: this message (regex), or from previous turn (context.phoneNumber).
  if (context?.pendingFiles?.length) {
    const phoneFromMessage = extractPhoneFromMessage(text);
    const phoneToUse = phoneFromMessage ?? context.phoneNumber;
    if (phoneToUse) {
      console.log('Pre-storing %d pending file(s) by phone (from %s) before agent runs', context.pendingFiles.length, phoneFromMessage ? 'message' : 'context');
      storeFilesByPhone(phoneToUse, userId);
    }
  }

  // Get agent from mastra instance (includes storage configuration)
  const agent = mastra.getAgent('azumiAgent');

  // Generate response from agent with memory context
  let response;
  try {
    response = await agent.generate(text, {
      memory: {
        thread: `telegram-${userId}`,
        resource: `telegram-user-${userId}`,
      },
      // Ensure agent continues after tool calls to produce a final message
      maxSteps: 10,
    });
  } catch (err) {
    console.error('❌ Agent generate failed:', err);
    throw err;
  }

  let responseText = response?.text?.trim() || null;

  if (!responseText) {
    const steps = response?.steps?.length ?? 0;
    const toolCalls = response?.toolCalls?.length ?? 0;
    const toolResults = response?.toolResults?.length ?? 0;
    console.warn(
      `⚠️ Agent returned no text. finishReason=${response?.finishReason} | steps=${steps} | toolCalls=${toolCalls} | toolResults=${toolResults}`
    );
    
    // Try reasoningText first
    if (response?.reasoningText?.trim()) {
      responseText = response.reasoningText.trim();
      console.warn('   → Using reasoningText as reply');
    }
    
    // Try extracting text from steps (look for assistant messages)
    if (!responseText && response?.steps?.length) {
      for (let i = response.steps.length - 1; i >= 0; i--) {
        const step = response.steps[i] as any;
        // Check multiple possible locations for text
        const t = step?.text?.trim() || 
                  step?.response?.text?.trim() || 
                  step?.content?.trim() ||
                  (Array.isArray(step?.content) ? step.content.map((c: any) => c?.text || c).join(' ').trim() : null);
        if (t) {
          responseText = t;
          console.warn(`   → Using text from step ${i}`);
          break;
        }
      }
    }
    
    // If we have tool results, try to generate a message from them
    if (!responseText && toolResults > 0 && response?.toolResults) {
      const lastToolResult = response.toolResults[response.toolResults.length - 1];
      const toolName = (lastToolResult as any)?.payload?.toolName || (lastToolResult as any)?.toolName || 'tool';
      const toolResult = (lastToolResult as any)?.payload?.result || (lastToolResult as any)?.result;
      
      // Generate contextual message based on which tool was called
      if (toolName === 'lookup-candidate') {
        const found = toolResult?.found;
        responseText = found 
          ? "I've checked our records. How can I help you today?"
          : "I don't see an existing application. Let's start a new one!";
      } else if (toolName === 'submit-candidate-application') {
        const success = toolResult?.success;
        responseText = success
          ? "Thank you! Your application has been submitted. Our team will review it and get back to you soon."
          : "I've noted your information. Is there anything else you'd like to add?";
      } else if (toolName === 'check-requirements') {
        responseText = "I've checked the requirements for you. Do you have any questions about them?";
      } else if (toolName === 'schedule-callback') {
        responseText = "I've scheduled a callback for you. A recruiter will contact you soon.";
      } else if (toolName === 'attach-files-to-existing-lead') {
        responseText = toolResult?.success
          ? "I've attached your files to your application. Our team will review them soon."
          : toolResult?.message || "I couldn't attach the files. Please try sending them again with your phone number.";
      } else if (toolName === 'add-note-to-candidate-lead') {
        responseText = toolResult?.success
          ? "I've recorded that update in your application."
          : "I couldn't save that update. Please try again.";
      } else {
        responseText = "I've processed that. Is there anything else you'd like to add, or shall we continue with your application?";
      }
      console.warn(`   → Generated message from tool result (${toolName})`);
    }
    
    // Generic fallback if we had tool calls but no results yet
    if (!responseText && toolCalls > 0) {
      responseText = "I've noted that. Is there anything else you'd like to add, or shall we continue with your application?";
      console.warn('   → Using generic tool-calls fallback');
    }
  }

  const raw = responseText || 'I apologize, I was unable to generate a response. Please try again.';
  const messageToSend = raw.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  await sendLongMessage(chatId, messageToSend);

  // Check if agent learned a phone number: store files by phone and remember for next turn
  const phoneNumber = extractPhoneFromResponse(response);
  if (phoneNumber) {
    storeFilesByPhone(phoneNumber, userId);
    if (context) context.phoneNumber = phoneNumber;
  }

  // Extract lead IDs from tool results and mark completion
  let detectedLeadId: number | null = null;

  const allToolResults = response?.toolResults ?? [];
  // Also check inside steps for tool results (Mastra may nest them)
  if (response?.steps?.length) {
    for (const step of response.steps as any[]) {
      if (step?.toolResults?.length) {
        allToolResults.push(...step.toolResults);
      }
    }
  }

  for (const tr of allToolResults) {
    const name = (tr as any)?.toolName || (tr as any)?.payload?.toolName;
    const result = (tr as any)?.result || (tr as any)?.payload?.result;

    console.log(`🔧 Tool result: name=${name}, keys=${result ? Object.keys(result).join(',') : 'null'}`);

    if (name === 'create-preliminary-lead' && result?.success && result?.leadId) {
      detectedLeadId = result.leadId;
      await setLeadIdForChat(chatId, result.leadId);
      console.log(`📌 Linked chat ${chatId} → CRM lead ${result.leadId}`);
    }
    if (name === 'submit-candidate-application' && result?.success) {
      markApplicationComplete(chatId).catch(() => {});
    }
    if (name === 'lookup-candidate' && result?.found && result?.candidate?.applicationId) {
      const m = result.candidate.applicationId.match(/^AZM-(\d+)$/);
      if (m) {
        detectedLeadId = parseInt(m[1], 10);
        await setLeadIdForChat(chatId, detectedLeadId);
        console.log(`📌 Linked returning candidate chat ${chatId} → CRM lead ${detectedLeadId}`);
      }
    }
  }

  // Log conversation to amoCRM lead in real-time
  logMessagesToCRM(chatId, text, messageToSend, detectedLeadId).catch((err) =>
    console.warn('CRM message log failed:', err),
  );

  console.log(`📤 Sent response to ${userFirstName} (${userId})`);
}

/**
 * Log a user+bot message exchange to the candidate's amoCRM lead as a note.
 * @param knownLeadId - pass directly when just extracted from tool results to avoid race conditions
 */
async function logMessagesToCRM(chatId: number, userText: string, botText: string, knownLeadId?: number | null): Promise<void> {
  const leadId = knownLeadId ?? (await getLeadIdForChat(chatId));
  if (!leadId) return;

  const timestamp = new Date().toLocaleString('ru-RU');
  const note = `💬 Telegram (${timestamp})

👤 Кандидат:
${userText}

🤖 Бот:
${botText}`;

  try {
    await addNoteToLead(leadId, note);
    console.log(`💬 Logged conversation to CRM lead ${leadId}`);
  } catch (err) {
    console.warn(`Failed to log messages to CRM lead ${leadId}:`, err);
  }
}

/**
 * Handle file uploads (resume, video, photos)
 */
async function handleFileUpload(
  chatId: number,
  userId: number,
  message: TelegramMessage,
  fileInfo: {
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileSize?: number;
    duration?: number;
    type: 'document' | 'video' | 'photo';
  }
): Promise<void> {
  const context = userContexts.get(userId)!;

  // Telegram Bot API limit: bots can only download files up to ~20 MB.
  // For larger files, Telegram returns "Bad Request: file is too big".
  const MAX_DOWNLOAD_SIZE_BYTES = 18 * 1024 * 1024; // 18 MB safety margin

  if (fileInfo.fileSize && fileInfo.fileSize > MAX_DOWNLOAD_SIZE_BYTES) {
    const sizeMb = (fileInfo.fileSize / (1024 * 1024)).toFixed(1);
    console.warn(
      `Telegram file too large to download via bot API (${sizeMb} MB). file_id=${fileInfo.fileId}`
    );

    const isVideo = fileInfo.type === 'video' || fileInfo.fileType?.startsWith('video/');

    if (isVideo) {
      // Generate a web upload link so the candidate can upload directly
      const uploadUrl = generateUploadLink({
        chatId,
        userId,
        userFirstName: message.from.first_name,
      });

      await sendTelegramMessage(
        chatId,
        `Your video is too large for Telegram (about ${sizeMb} MB). ` +
          `No worries! Please tap the link below to upload it directly:\n\n` +
          `${uploadUrl}\n\n` +
          `Just tap, pick the video from your gallery, and it will be uploaded automatically.`
      );
    } else {
      await sendTelegramMessage(
        chatId,
        `Your file is too large for Telegram bots to download (about ${sizeMb} MB). Telegram only allows bots to download files up to around 20 MB.\n\nPlease send a smaller version or a shareable link instead.`
      );
    }

    return;
  }

  // Get the file URL from Telegram
  let fileUrl: string | undefined;
  try {
    fileUrl = await getFileUrl(fileInfo.fileId);
  } catch (error) {
    console.error('Failed to get file URL:', error);
    await sendTelegramMessage(
      chatId,
      `I couldn't download your file due to a Telegram error ("${(error as Error).message}"). This often happens when the file is too large for bots.\n\nPlease try sending a smaller file (up to ~20 MB) or share a link instead.`
    );
    return;
  }

  // Upload to Google Drive for permanent storage (replaces fileUrl with Drive link if configured)
  if (fileUrl) {
    const driveResult = await uploadFileFromUrl(
      fileUrl,
      fileInfo.fileName || (fileInfo.type === 'video' ? 'intro-video.mp4' : 'resume.pdf'),
      fileInfo.fileType
    );
    if (driveResult) fileUrl = driveResult.downloadUrl;
  }

  // Determine if this is a resume or video
  if (fileInfo.type === 'video' || fileInfo.fileType?.startsWith('video/')) {
    // It's a video - likely intro video
    context.pendingFiles.push({
      type: 'video',
      fileId: fileInfo.fileId,
      fileName: fileInfo.fileName,
      fileType: fileInfo.fileType,
      fileUrl,
      duration: fileInfo.duration,
    });

    const durationInfo = fileInfo.duration 
      ? ` (${Math.floor(fileInfo.duration / 60)}:${(fileInfo.duration % 60).toString().padStart(2, '0')})`
      : '';

    await sendTelegramMessage(
      chatId,
      `✅ Thank you! I've received your introduction video${durationInfo}. This will help families get to know you better!\n\nIs there anything else you'd like to add or shall we continue?`
    );

  } else if (
    fileInfo.type === 'document' ||
    fileInfo.fileType?.includes('pdf') ||
    fileInfo.fileType?.includes('word') ||
    fileInfo.fileType?.includes('document') ||
    fileInfo.fileName?.match(/\.(pdf|doc|docx|rtf)$/i)
  ) {
    // It's likely a resume/CV
    context.pendingFiles.push({
      type: 'resume',
      fileId: fileInfo.fileId,
      fileName: fileInfo.fileName,
      fileType: fileInfo.fileType,
      fileUrl,
    });

    await sendTelegramMessage(
      chatId,
      `✅ Thank you! I've received your resume${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''}.\n\nIs there anything else you'd like to share, or shall we continue with your application?`
    );

  } else if (fileInfo.type === 'photo') {
    // Photo - could be document photo or profile photo
    await sendTelegramMessage(
      chatId,
      `I received your photo. If this is a document (like a certificate), please send it as a file for better quality. If you meant to send your resume or video, please send those as well.`
    );

  } else {
    // Unknown file type
    await sendTelegramMessage(
      chatId,
      `I received your file${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''}. Could you let me know what this is? Is it your resume/CV or introduction video?`
    );
  }
}

/**
 * Get pending files for a user (to include in application submission)
 */
export function getPendingFiles(userId: number): {
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
} {
  const context = userContexts.get(userId);
  if (!context) return {};

  const result: ReturnType<typeof getPendingFiles> = {};

  for (const file of context.pendingFiles) {
    if (file.type === 'resume' && !result.resumeFile) {
      result.resumeFile = {
        fileId: file.fileId,
        fileName: file.fileName,
        fileType: file.fileType,
        fileUrl: file.fileUrl,
      };
    }
    if (file.type === 'video' && !result.introVideoFile) {
      result.introVideoFile = {
        fileId: file.fileId,
        fileName: file.fileName,
        fileType: file.fileType,
        fileUrl: file.fileUrl,
        duration: file.duration,
      };
    }
  }

  return result;
}

/**
 * Clear pending files after submission
 */
export function clearPendingFiles(userId: number): void {
  const context = userContexts.get(userId);
  if (context) {
    context.pendingFiles = [];
  }
}

/**
 * Clean up old contexts (call periodically)
 */
export function cleanupOldContexts(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [userId, context] of userContexts) {
    if (now - context.lastMessageTime > maxAgeMs) {
      userContexts.delete(userId);
    }
  }
}
