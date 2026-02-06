/**
 * WhatsApp Webhook Handler
 * Processes incoming messages from Twilio and routes them to the Azumi agent
 */

import { mastra } from '../index';
import {
  WhatsAppMessage,
  sendWhatsAppMessage,
  sendLongMessage,
  extractFileFromMessage,
  downloadFile,
} from './whatsapp-client';

// Store conversation context per user (keyed by phone number)
// In production, use Redis or database
const userContexts: Map<string, {
  lastMessageTime: number;
  pendingFiles: {
    type: 'resume' | 'video';
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
    duration?: number;
  }[];
  phoneNumber: string; // Always available for WhatsApp
}> = new Map();

import { fileStoreByPhone, FileStoreEntry } from './shared-file-store';
import { uploadFileFromUrl } from './google-drive';

/**
 * Store files by phone number (called when we learn the phone number)
 */
export function storeFilesByPhone(phone: string, userId: string): void {
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
    const normalizedPhone = normalizePhone(phone);
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
  // Remove whatsapp: prefix if present
  const cleaned = phone.replace(/^whatsapp:/, '');
  return cleaned.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

/**
 * Extract phone number from WhatsApp From field
 */
function extractPhoneFromWhatsApp(from: string): string {
  // Remove whatsapp: prefix
  return from.replace(/^whatsapp:/, '');
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
export async function handleWhatsAppWebhook(message: WhatsAppMessage): Promise<void> {
  const from = message.From;
  const body = message.Body;
  const phoneNumber = extractPhoneFromWhatsApp(from);
  
  console.log(`📩 Received WhatsApp message from ${phoneNumber}: ${body || '[file]'}`);

  try {
    // Initialize or get user context
    let context = userContexts.get(phoneNumber);
    if (!context) {
      context = {
        lastMessageTime: Date.now(),
        pendingFiles: [],
        phoneNumber,
      };
      userContexts.set(phoneNumber, context);
    }
    context.lastMessageTime = Date.now();

    // Check if user sent a file
    const fileInfo = extractFileFromMessage(message);
    if (fileInfo) {
      await handleFileUpload(from, phoneNumber, message, fileInfo);
      // If there was a caption, also let the agent process it
      if (body?.trim()) {
        const fileLabel = fileInfo.type === 'video' ? 'intro video' : fileInfo.type === 'document' ? 'resume' : 'file';
        const captionPrompt = `[Candidate just sent their ${fileLabel}${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''}.] They also wrote: ${body.trim()}`;
        await handleTextMessage(from, phoneNumber, captionPrompt);
      }
      return;
    }

    // Handle text message
    if (body) {
      await handleTextMessage(from, phoneNumber, body);
    }

  } catch (error) {
    console.error('Error handling WhatsApp message:', error);
    
    await sendWhatsAppMessage(
      from,
      'I apologize, but I encountered an error processing your message. Please try again or contact us directly at +7 968 599 93 60.'
    );
  }
}

/**
 * Handle text messages by routing to the agent
 */
async function handleTextMessage(
  from: string,
  phoneNumber: string,
  text: string
): Promise<void> {
  const context = userContexts.get(phoneNumber);

  // Pre-store files by phone BEFORE agent runs, so submit tool can find them.
  // We learn phone either from this message (regex) or from a previous turn (stored later via extractPhoneFromResponse).
  if (context?.pendingFiles?.length) {
    const phoneFromMessage = extractPhoneFromMessage(text);
    if (phoneFromMessage) {
      console.log('Pre-storing %d pending file(s) by phone (from message) before agent runs', context.pendingFiles.length);
      storeFilesByPhone(phoneFromMessage, phoneNumber);
    } else {
      // For WhatsApp, we always have the phone number, so store files immediately
      console.log('Pre-storing %d pending file(s) by phone (from WhatsApp From field) before agent runs', context.pendingFiles.length);
      storeFilesByPhone(phoneNumber, phoneNumber);
    }
  }

  // Get agent from mastra instance (includes storage configuration)
  const agent = mastra.getAgent('azumiAgent');

  // Generate response from agent with memory context
  let response;
  try {
    response = await agent.generate(text, {
      memory: {
        thread: `whatsapp-${phoneNumber}`,
        resource: `whatsapp-user-${phoneNumber}`,
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
  await sendLongMessage(from, messageToSend);

  // Check if agent learned a phone number and store files by phone
  const phoneFromResponse = extractPhoneFromResponse(response);
  if (phoneFromResponse) {
    storeFilesByPhone(phoneFromResponse, phoneNumber);
  } else {
    // For WhatsApp, we always have the phone number, so store files if we have any
    if (context?.pendingFiles?.length) {
      storeFilesByPhone(phoneNumber, phoneNumber);
    }
  }

  console.log(`📤 Sent response to ${phoneNumber}`);
}

/**
 * Handle file uploads (resume, video, photos)
 */
async function handleFileUpload(
  from: string,
  phoneNumber: string,
  message: WhatsAppMessage,
  fileInfo: {
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
    duration?: number;
    type: 'document' | 'video' | 'image' | 'audio';
  }
): Promise<void> {
  const context = userContexts.get(phoneNumber)!;

  // Get the file URL (Twilio provides it directly in MediaUrl0)
  let fileUrl = fileInfo.fileUrl;

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

    await sendWhatsAppMessage(
      from,
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

    await sendWhatsAppMessage(
      from,
      `✅ Thank you! I've received your resume${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''}.\n\nIs there anything else you'd like to share, or shall we continue with your application?`
    );

  } else if (fileInfo.type === 'image') {
    // Photo - could be document photo or profile photo
    await sendWhatsAppMessage(
      from,
      `I received your photo. If this is a document (like a certificate), please send it as a file for better quality. If you meant to send your resume or video, please send those as well.`
    );

  } else {
    // Unknown file type
    await sendWhatsAppMessage(
      from,
      `I received your file${fileInfo.fileName ? ` (${fileInfo.fileName})` : ''}. Could you let me know what this is? Is it your resume/CV or introduction video?`
    );
  }
}

/**
 * Get pending files for a user (to include in application submission)
 */
export function getPendingFiles(phoneNumber: string): {
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
  const context = userContexts.get(phoneNumber);
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
export function clearPendingFiles(phoneNumber: string): void {
  const context = userContexts.get(phoneNumber);
  if (context) {
    context.pendingFiles = [];
  }
}

/**
 * Clean up old contexts (call periodically)
 */
export function cleanupOldContexts(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [phoneNumber, context] of userContexts) {
    if (now - context.lastMessageTime > maxAgeMs) {
      userContexts.delete(phoneNumber);
    }
  }
}
