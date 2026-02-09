#!/usr/bin/env npx tsx
/**
 * One-time script to get a Google Drive OAuth refresh token.
 * Run locally: npx tsx scripts/get-google-drive-token.ts
 *
 * Prerequisites:
 * 1. Create OAuth 2.0 credentials in Google Cloud Console (APIs & Services → Credentials)
 * 2. Add "Authorized redirect URIs": http://localhost:3000/oauth/callback
 * 3. Add "Authorized JavaScript origins": http://localhost:3000
 * 4. Enable Google Drive API for your project
 *
 * Env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *
 * After running, add GOOGLE_REFRESH_TOKEN to your .env and Railway.
 */

import 'dotenv/config';
import { createServer } from 'http';
import { google } from 'googleapis';

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const SCOPES = ['https://www.googleapis.com/auth/drive'];

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force refresh token even if user previously authorized
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Error</h1><p>${error}</p><p>You can close this tab.</p>`);
        server.close();
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing authorization code');
        server.close();
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        const refreshToken = tokens.refresh_token;

        if (!refreshToken) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<h1>No refresh token</h1><p>Try revoking app access at <a href="https://myaccount.google.com/permissions">Google Account permissions</a> and run this script again.</p><p>You can close this tab.</p>'
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<h1>Success</h1><p>Add this to your .env and Railway:</p><pre>GOOGLE_REFRESH_TOKEN=${refreshToken}</pre><p>You can close this tab.</p>`
          );
          console.log('\n✅ Refresh token received!\n');
          console.log('Add to your .env:');
          console.log(`GOOGLE_REFRESH_TOKEN=${refreshToken}`);
          console.log('\nAlso set: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DRIVE_FOLDER_ID');
          console.log('GOOGLE_DRIVE_FOLDER_ID = any folder ID from your My Drive (right-click folder → Get link)\n');
        }
      } catch (e) {
        console.error('Token exchange failed:', e);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to exchange code for token. Check console.');
      }

      server.close();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/auth') {
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, () => {
    console.log('\n🔗 Open this URL in your browser to authorize:\n');
    console.log(`   http://localhost:${PORT}/auth\n`);
    console.log('After authorizing, the refresh token will appear here and in the browser.\n');
  });
}

main();
