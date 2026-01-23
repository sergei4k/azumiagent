# Deployment Guide - 24/7 Bot Hosting

This guide shows you how to deploy your Telegram bot to run 24/7 in the cloud.

## Option 1: Railway (Recommended - Easiest)

### Steps:

1. **Create Railway Account**
   - Go to https://railway.app
   - Sign up with GitHub

2. **Push Code to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/yourusername/azumiagent.git
   git push -u origin main
   ```

3. **Deploy on Railway**
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect Node.js

4. **Set Environment Variables**
   - Go to your project → Variables tab
   - Add all variables from your `.env` file:
     - `TELEGRAM_BOT_TOKEN`
     - `TELEGRAM_WEBHOOK_PORT` (set to `3001` or leave default)
     - `AMOCRM_SUBDOMAIN`
     - `AMOCRM_ACCESS_TOKEN`
     - `AMOCRM_KZPIPELINE`
     - `AMOCRM_STATUS_ID`
     - `GOOGLE_GENERATIVE_AI_API_KEY`
     - Any other variables you use

5. **Get Your Public URL**
   - Railway gives you a URL like: `https://your-app.railway.app`
   - Copy this URL

6. **Set Telegram Webhook**
   - Once deployed, visit: `https://your-app.railway.app/telegram/setup-webhook`
   - Or use curl:
     ```bash
     curl -X POST https://your-app.railway.app/telegram/setup-webhook \
       -H "Content-Type: application/json" \
       -d '{"webhookUrl": "https://your-app.railway.app"}'
     ```

7. **Verify**
   - Visit: `https://your-app.railway.app/telegram/webhook-info`
   - Should show your webhook is set

**Cost:** Free tier available, then ~$5/month

---

## Option 2: Render

### Steps:

1. **Create Render Account**
   - Go to https://render.com
   - Sign up with GitHub

2. **Create New Web Service**
   - Connect your GitHub repo
   - Settings:
     - **Build Command:** `npm install`
     - **Start Command:** `npm run telegram`
     - **Environment:** Node

3. **Set Environment Variables**
   - Add all your `.env` variables in the Environment tab

4. **Deploy**
   - Render will build and deploy automatically
   - Get your URL: `https://your-app.onrender.com`

5. **Set Webhook** (same as Railway)

**Cost:** Free tier (spins down after inactivity), $7/month for always-on

---

## Option 3: DigitalOcean App Platform

### Steps:

1. **Create DigitalOcean Account**
   - Go to https://www.digitalocean.com

2. **Create App**
   - App Platform → Create App → GitHub
   - Select your repo
   - Auto-detects Node.js

3. **Configure**
   - Build command: `npm install`
   - Run command: `npm run telegram`
   - Add environment variables

4. **Deploy & Set Webhook**

**Cost:** $5/month minimum

---

## Option 4: VPS (Most Control)

### Using DigitalOcean Droplet:

1. **Create Droplet**
   - Ubuntu 22.04
   - $6/month minimum

2. **SSH into Server**
   ```bash
   ssh root@your-server-ip
   ```

3. **Install Node.js**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

4. **Clone & Setup**
   ```bash
   git clone https://github.com/yourusername/azumiagent.git
   cd azumiagent/azumi
   npm install
   ```

5. **Install PM2 (Process Manager)**
   ```bash
   npm install -g pm2
   pm2 start npm --name "telegram-bot" -- run telegram
   pm2 save
   pm2 startup  # Follow instructions to auto-start on reboot
   ```

6. **Set Environment Variables**
   ```bash
   nano .env  # Add all your variables
   ```

7. **Setup Nginx (for HTTPS)**
   ```bash
   sudo apt install nginx certbot python3-certbot-nginx
   # Configure nginx to proxy to localhost:3001
   sudo certbot --nginx -d your-domain.com
   ```

8. **Set Webhook**
   - Use your domain: `https://your-domain.com`

**Cost:** $6-12/month

---

## Important Notes

### After Deployment:

1. **Update Webhook URL**
   - Your bot will stop working with ngrok URL
   - Set new webhook to your deployed URL

2. **Environment Variables**
   - Never commit `.env` to GitHub
   - Set all variables in your hosting platform

3. **Database Persistence**
   - If you want conversation memory to persist, update `index.ts`:
     ```typescript
     storage: new LibSQLStore({
       id: "mastra-storage",
       url: "file:./mastra.db",  // Changed from ":memory:"
     }),
     ```

4. **Monitoring**
   - Check logs regularly
   - Set up alerts if available
   - Monitor uptime

### Testing:

1. **Health Check**
   - Visit: `https://your-url.com/health`
   - Should return: `{"status":"ok"}`

2. **Test Bot**
   - Send a message to your bot
   - Check server logs

---

## Quick Comparison

| Platform | Ease | Cost | Always-On | Best For |
|----------|------|------|-----------|----------|
| Railway | ⭐⭐⭐⭐⭐ | Free/$5 | ✅ | Quick setup |
| Render | ⭐⭐⭐⭐ | Free/$7 | Free tier: ❌ | Simple apps |
| DigitalOcean App | ⭐⭐⭐ | $5+ | ✅ | Production |
| VPS | ⭐⭐ | $6+ | ✅ | Full control |

---

## Recommended: Start with Railway

Railway is the easiest:
- ✅ Free tier available
- ✅ Auto-deploys from GitHub
- ✅ Built-in HTTPS
- ✅ Simple environment variable setup
- ✅ Good for production

Just push to GitHub, connect to Railway, add env vars, and you're done!
