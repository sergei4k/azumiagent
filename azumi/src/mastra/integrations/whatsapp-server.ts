/**
 * WhatsApp Bot Server (Baileys)
 * Express server for health/admin endpoints + Baileys persistent connection.
 *
 * Run with: npx tsx src/mastra/integrations/whatsapp-server.ts
 *
 * On first run, scan the QR code printed in the terminal with WhatsApp on your phone.
 * Auth state is persisted to WHATSAPP_AUTH_FOLDER (default ./whatsapp-auth).
 * NOTE: On Railway/ephemeral hosts, mount a persistent volume at that path
 *       so the session survives redeploys.
 */

import 'dotenv/config';

import express from 'express';
import { startWhatsApp, isConnected, onMessage, getQrDataUrl, hasQrPending } from './whatsapp-client';
import { handleWhatsAppMessage } from './whatsapp-webhook';
import { getRecentChats, getChatMessages } from '../../../db-pg';
import { getAdminDashboardHtml } from './admin-dashboard';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || process.env.WHATSAPP_PORT || '3002', 10);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'azumi-whatsapp-bot',
    whatsapp_connected: isConnected(),
  });
});

app.get('/qr', async (_req, res) => {
  if (isConnected()) {
    return res.type('html').send('<h1>WhatsApp is already connected</h1>');
  }
  if (!hasQrPending()) {
    return res.type('html').send(
      '<h1>No QR code yet</h1><p>Waiting for WhatsApp to generate one... Refresh in a few seconds.</p><script>setTimeout(()=>location.reload(),3000)</script>',
    );
  }
  const dataUrl = await getQrDataUrl();
  if (!dataUrl) {
    return res.type('html').send('<h1>QR expired — refresh to retry</h1>');
  }
  res.type('html').send(`
    <html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff">
      <h1>Scan with WhatsApp</h1>
      <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
      <img src="${dataUrl}" style="border-radius:12px" />
      <p style="color:#888;margin-top:16px">This page auto-refreshes every 15s</p>
      <script>setTimeout(()=>location.reload(),15000)</script>
    </body></html>
  `);
});

app.get('/admin', (_req, res) => {
  res.type('html').send(getAdminDashboardHtml());
});

app.get('/admin/chats', async (_req, res) => {
  try {
    const chats = await getRecentChats();
    res.json(chats);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

app.get('/admin/chats/:chatId', async (req, res) => {
  const chatIdNum = Number(req.params.chatId);
  if (!Number.isFinite(chatIdNum)) {
    return res.status(400).json({ error: 'Invalid chatId' });
  }
  try {
    const messages = await getChatMessages(chatIdNum);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

async function start() {
  await startWhatsApp();

  onMessage((msg) => {
    handleWhatsAppMessage(msg).catch((err) => {
      console.error('[WA] Unhandled error in message handler:', err);
    });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🤖 Azumi WhatsApp Bot server running on port ${PORT}`);
    console.log(`📱 WhatsApp: scan QR code in terminal to connect`);
    console.log(`🏥 Health check: GET /health`);
    console.log(`📊 Admin dashboard: GET /admin`);
  });
}

start().catch((err) => {
  console.error('Failed to start WhatsApp server:', err);
  process.exit(1);
});

export default app;
