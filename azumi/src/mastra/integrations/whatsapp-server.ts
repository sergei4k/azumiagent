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
import { startWhatsApp, isConnected, onMessage } from './whatsapp-client';
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
