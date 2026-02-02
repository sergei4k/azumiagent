/**
 * WhatsApp Bot Server
 * Express server to handle Twilio WhatsApp webhooks
 * 
 * Run with: npx tsx src/mastra/integrations/whatsapp-server.ts
 */

// Load environment variables from .env file
import 'dotenv/config';

import express from 'express';
import { handleWhatsAppWebhook } from './whatsapp-webhook';
import { WhatsAppMessage } from './whatsapp-client';

const app = express();

// Twilio sends application/x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Use PORT from environment (Railway, Render, etc.) or fallback to WHATSAPP_WEBHOOK_PORT or 3002
const BASE_PORT = parseInt(process.env.PORT || process.env.WHATSAPP_WEBHOOK_PORT || '3002', 10);
const PORT_MAX_ATTEMPTS = 10;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'azumi-whatsapp-bot' });
});

// WhatsApp webhook endpoint (Twilio sends POST requests here)
app.post('/whatsapp/webhook', async (req, res) => {
  try {
    console.log('📨 Received WhatsApp webhook:', JSON.stringify(req.body, null, 2));
    
    // Twilio expects a TwiML response, but we'll process asynchronously
    // Respond immediately with empty TwiML (we'll send messages via API)
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    
    // Process the message asynchronously
    const message: WhatsAppMessage = {
      MessageSid: req.body.MessageSid,
      AccountSid: req.body.AccountSid,
      From: req.body.From,
      To: req.body.To,
      Body: req.body.Body,
      NumMedia: req.body.NumMedia || '0',
      MediaUrl0: req.body.MediaUrl0,
      MediaContentType0: req.body.MediaContentType0,
      MessageType: req.body.MessageType,
    };
    
    await handleWhatsAppWebhook(message);
    
  } catch (error) {
    console.error('Error in WhatsApp webhook handler:', error);
    // Still return TwiML to prevent Twilio from retrying
    if (!res.headersSent) {
      res.type('text/xml');
      res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  }
});

// Start server, trying alternative ports if base port is in use
function startServer(port: number, attempt: number): void {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`🤖 Azumi WhatsApp Bot server running on port ${port}`);
    console.log(`📡 Webhook endpoint: POST /whatsapp/webhook`);
    console.log(`\nTo configure Twilio webhook:`);
    console.log(`  1. Go to Twilio Console → Messaging → Try it out → Send a WhatsApp message`);
    console.log(`  2. Set "When a message comes in" to: https://your-domain.com/whatsapp/webhook`);
    console.log(`  3. Make sure these env vars are set:`);
    console.log(`     - TWILIO_ACCOUNT_SID`);
    console.log(`     - TWILIO_AUTH_TOKEN`);
    console.log(`     - TWILIO_WHATSAPP_FROM (optional, defaults to sandbox number)`);
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
        console.error(`   Port ${port} is in use. Kill the other process or set WHATSAPP_WEBHOOK_PORT to a different port.`);
      }
      process.exit(1);
    }
  });
}

startServer(BASE_PORT, 1);

export default app;
