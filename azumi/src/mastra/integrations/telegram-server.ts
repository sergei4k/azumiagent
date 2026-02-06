/**
 * Telegram Bot Server
 * Express server to handle Telegram webhooks
 * 
 * Run with: npx tsx src/mastra/integrations/telegram-server.ts
 */

// Load environment variables from .env file
import 'dotenv/config';

import express from 'express';
import { handleTelegramWebhook } from './telegram-webhook';
import { setWebhook, getWebhookInfo, deleteWebhook } from './telegram-client';
import { initDb } from '../../../db';

const app = express();
app.use(express.json());

// Use PORT from environment (Railway, Render, etc.) or fallback to TELEGRAM_WEBHOOK_PORT or 3001
const BASE_PORT = parseInt(process.env.PORT || process.env.TELEGRAM_WEBHOOK_PORT || '3001', 10);
const PORT_MAX_ATTEMPTS = 10;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'azumi-telegram-bot' });
});

// Telegram webhook endpoint
app.post('/telegram/webhook', async (req, res) => {
  try {
    console.log('📨 Received Telegram update:', JSON.stringify(req.body, null, 2));
    
    // Respond immediately to Telegram (they expect quick response)
    res.sendStatus(200);
    
    // Process the update asynchronously
    await handleTelegramWebhook(req.body);
    
  } catch (error) {
    console.error('Error in webhook handler:', error);
    // Still return 200 to prevent Telegram from retrying
    if (!res.headersSent) {
      res.sendStatus(200);
    }
  }
});

// Endpoint to set up the webhook (call this once after deploying)
app.post('/telegram/setup-webhook', async (req, res) => {
  const { webhookUrl } = req.body;
  
  if (!webhookUrl) {
    return res.status(400).json({ error: 'webhookUrl is required' });
  }

  try {
    const success = await setWebhook(`${webhookUrl}/telegram/webhook`);
    const info = await getWebhookInfo();
    
    res.json({
      success,
      webhook: info,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get current webhook status
app.get('/telegram/webhook-info', async (req, res) => {
  try {
    const info = await getWebhookInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Delete webhook (for switching to polling or debugging)
app.delete('/telegram/webhook', async (req, res) => {
  try {
    const success = await deleteWebhook();
    res.json({ success });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Start server, trying alternative ports if base port is in use
async function startServer(port: number, attempt: number): Promise<void> {
  // Initialize database (create table and add missing columns)
  try {
    await initDb();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    // Don't exit - server can still start, but DB operations will fail
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`🤖 Azumi Telegram Bot server running on port ${port}`);
    console.log(`📡 Webhook endpoint: POST /telegram/webhook`);
    console.log(`\nTo set up webhook, POST to /telegram/setup-webhook with:`);
    console.log(`  { "webhookUrl": "https://your-domain.com" }`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < PORT_MAX_ATTEMPTS) {
      const nextPort = BASE_PORT + attempt;
      console.warn(`⚠️ Port ${port} in use, trying ${nextPort}...`);
      console.warn(`   If using ngrok, run: ngrok http ${nextPort}`);
      startServer(nextPort, attempt + 1);
    } else {
      console.error('Failed to start server:', err.message);
      if (err.code === 'EADDRINUSE') {
        console.error(`   Port ${port} is in use. Kill the other process or set TELEGRAM_WEBHOOK_PORT to a different port.`);
      }
      process.exit(1);
    }
  });
}

startServer(BASE_PORT, 1);

export default app;
