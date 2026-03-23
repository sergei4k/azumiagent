/**
 * WhatsApp Client using Baileys
 * Handles connection, authentication, and message sending via WhatsApp Web protocol
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type proto,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const AUTH_FOLDER = process.env.WHATSAPP_AUTH_FOLDER || './whatsapp-auth';

const noop = () => {};
const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: noop, debug: noop, info: noop, warn: noop, error: noop,
} as any;

/** Wipe auth state so next restart triggers a fresh QR scan. */
export function resetAuth(): void {
  if (!existsSync(AUTH_FOLDER)) return;
  for (const file of readdirSync(AUTH_FOLDER)) {
    try { rmSync(join(AUTH_FOLDER, file), { recursive: true, force: true }); } catch {}
  }
  console.log('[WA] Auth folder contents cleared');
}

let sock: WASocket | null = null;
let connectionReady = false;
let latestQr: string | null = null;
let reconnectAttempt = 0;

/** Get the latest QR code as a data URL (PNG base64) for web display. */
export async function getQrDataUrl(): Promise<string | null> {
  if (!latestQr) return null;
  return QRCode.toDataURL(latestQr, { width: 400 });
}

export function hasQrPending(): boolean {
  return latestQr !== null;
}

type MessageHandler = (msg: proto.IWebMessageInfo) => void;
let onMessageHandler: MessageHandler | null = null;

export function onMessage(handler: MessageHandler): void {
  onMessageHandler = handler;
}

export function isConnected(): boolean {
  return connectionReady;
}

export async function startWhatsApp(): Promise<WASocket> {
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(undefined); } catch {}
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    console.log(`[WA] Using WhatsApp Web version: ${version.join('.')}`);
  } catch (e) {
    console.warn('[WA] Could not fetch latest version, using default');
  }

  sock = makeWASocket({
    auth: state,
    logger: silentLogger,
    browser: ['Azumi', 'Chrome', '120.0.0'],
    printQRInTerminal: false,
    ...(version ? { version } : {}),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    console.log('[WA] connection.update:', JSON.stringify(update, null, 2));
    const { connection, lastDisconnect, qr: qrString } = update;

    if (qrString) {
      latestQr = qrString;
      console.log('[WA] QR code received, available at /qr');
      try { qrcodeTerminal.generate(qrString, { small: true }); } catch {}
    }

    if (connection === 'close') {
      connectionReady = false;
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
        const reason = statusCode === 405 ? '405 rejected' : 'Logged out';
        console.error(`[WA] ${reason}. Scheduling cleanup and fresh reconnect...`);
        reconnectAttempt++;
        const delay = Math.min(reconnectAttempt * 5000, 60_000);
        console.log(`[WA] Fresh reconnect in ${delay / 1000}s (attempt ${reconnectAttempt})...`);
        setTimeout(async () => {
          try { sock?.ev.removeAllListeners(); sock?.end(undefined); } catch {}
          sock = null;
          await new Promise((r) => setTimeout(r, 500));
          try { resetAuth(); } catch (e) { console.warn('[WA] Could not clear auth:', e); }
          startWhatsApp().catch((err) => {
            console.error('[WA] Reconnect failed:', err);
          });
        }, delay);
      } else {
        reconnectAttempt++;
        const delay = Math.min(reconnectAttempt * 2000, 30_000);
        console.log(`[WA] Connection closed (status ${statusCode}). Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})...`);
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            console.error('[WA] Reconnect failed:', err);
          });
        }, delay);
      }
    } else if (connection === 'open') {
      connectionReady = true;
      reconnectAttempt = 0;
      latestQr = null;
      console.log('[WA] WhatsApp connected successfully!');
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      if (onMessageHandler) {
        onMessageHandler(msg);
      }
    }
  });

  return sock;
}

export function getSocket(): WASocket | null {
  return sock;
}

export async function sendWhatsAppMessage(jid: string, text: string): Promise<void> {
  if (!sock || !connectionReady) {
    throw new Error('WhatsApp not connected');
  }
  await sock.sendMessage(jid, { text });
}

export async function sendWhatsAppTyping(jid: string): Promise<void> {
  if (!sock || !connectionReady) return;
  await sock.sendPresenceUpdate('composing', jid);
}

export async function sendLongWhatsAppMessage(jid: string, text: string): Promise<void> {
  const MAX_LENGTH = 4000;
  let remaining = text;

  while (remaining.length > 0) {
    let chunk: string;

    if (remaining.length <= MAX_LENGTH) {
      chunk = remaining;
      remaining = '';
    } else {
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

    await sendWhatsAppMessage(jid, chunk);

    if (remaining.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export async function downloadWhatsAppMedia(
  msg: proto.IWebMessageInfo,
): Promise<Buffer | null> {
  if (!sock) return null;
  try {
    const buffer = await downloadMediaMessage(msg as any, 'buffer', {}, {
      reuploadRequest: sock.updateMediaMessage,
      logger: silentLogger,
    });
    return buffer as Buffer;
  } catch (e) {
    console.error('Failed to download WhatsApp media:', e);
    return null;
  }
}

/**
 * Local part of a WhatsApp JID (before @), e.g. `7700...@s.whatsapp.net` → `7700...`.
 * This may be a phone-like id, LID, or other identifier — do not assume it is an E.164 phone.
 * @see resolvePhoneDigitsForCrm for CRM-safe phone digits only.
 */
export function jidUserPart(jid: string): string {
  return jid.replace(/@.*$/, '');
}


/** WhatsApp user id for @s.whatsapp.net is digits only; E.164 allows up to 15 (without +). */
function isLikelyPhoneDigits(user: string): boolean {
  return /^\d{7,15}$/.test(user);
}

/**
 * Extract phone digits from a JID string only when it is a known phone-based domain.
 * Returns null for @lid and other non-phone JIDs — do not send the user part to CRM as a phone.
 */
export function extractPhoneDigitsFromJid(jid: string): string | null {
  if (!jid || jid.includes('@lid')) return null;
  if (jid.includes('@s.whatsapp.net') || jid.includes('@c.us')) {
    const user = jidUserPart(jid);
    return isLikelyPhoneDigits(user) ? user : null;
  }
  return null;
}

/**
 * E.164 digits for amoCRM / tools, or null if this chat has no resolvable phone (e.g. only @lid).
 * Uses remoteJidAlt / senderPn when Baileys provides a real @s.whatsapp.net address.
 */
export function resolvePhoneDigitsForCrm(
  remoteJid: string,
  key?: proto.IMessageKey | null,
): string | null {
  const k = key as Record<string, unknown> | undefined;
  const tryJid = (j: unknown): string | null => (typeof j === 'string' ? extractPhoneDigitsFromJid(j) : null);
  return tryJid(k?.remoteJidAlt) ?? tryJid(k?.senderPn) ?? extractPhoneDigitsFromJid(remoteJid);
}

/** Stable Mastra thread id: phone when known, else opaque key from full JID (never treat lid digits as phone). */
export function waThreadKey(jid: string, phoneDigits: string | null): string {
  if (phoneDigits) return `whatsapp-${phoneDigits}`;
  const safe = Buffer.from(jid, 'utf8').toString('base64url').replace(/=+$/, '');
  return `whatsapp-jid-${safe}`;
}
