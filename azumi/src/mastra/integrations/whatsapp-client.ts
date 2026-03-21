/**
 * WhatsApp Client using Baileys
 * Handles connection, authentication, and message sending via WhatsApp Web protocol
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type proto,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

const AUTH_FOLDER = process.env.WHATSAPP_AUTH_FOLDER || './whatsapp-auth';

let sock: WASocket | null = null;
let connectionReady = false;

type MessageHandler = (msg: proto.IWebMessageInfo) => void;
let onMessageHandler: MessageHandler | null = null;

export function onMessage(handler: MessageHandler): void {
  onMessageHandler = handler;
}

export function isConnected(): boolean {
  return connectionReady;
}

export async function startWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr: qrString } = update;

    if (qrString) {
      qrcode.generate(qrString, { small: true });
      console.log('📱 Scan the QR code above with WhatsApp on your phone');
    }

    if (connection === 'close') {
      connectionReady = false;
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `WhatsApp connection closed (status ${statusCode}). ${shouldReconnect ? 'Reconnecting...' : 'Logged out — delete auth folder and restart to re-scan QR.'}`,
      );

      if (shouldReconnect) {
        startWhatsApp();
      }
    } else if (connection === 'open') {
      connectionReady = true;
      console.log('✅ WhatsApp connected successfully!');
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
    });
    return buffer as Buffer;
  } catch (e) {
    console.error('Failed to download WhatsApp media:', e);
    return null;
  }
}

/** Extract phone number from WhatsApp JID (e.g. "77081234567@s.whatsapp.net" → "77081234567") */
export function phoneFromJid(jid: string): string {
  return jid.replace(/@.*$/, '');
}
