/**
 * Web-based file upload for large files that exceed Telegram's bot download limit (~20 MB).
 *
 * Flow:
 * 1. Candidate sends a large video in Telegram
 * 2. Bot detects it's too big and generates a unique upload link
 * 3. Candidate taps the link → simple mobile page → picks video → uploads
 * 4. Server uploads to Google Drive and stores the result for the candidate's context
 * 5. Bot sends a Telegram confirmation message
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { uploadFileBuffer } from './google-drive';
import { sendTelegramMessage } from './telegram-client';
import { webUploadsByUserId } from './shared-file-store';

// ── Token management ────────────────────────────────────────────────────

interface UploadToken {
  chatId: number;
  userId: number;
  userFirstName: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

const tokenStore = new Map<string, UploadToken>();

// Clean expired tokens every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokenStore) {
    if (data.expiresAt < now) tokenStore.delete(token);
  }
}, 60 * 60 * 1000);

/**
 * Generate a short upload token for a Telegram user.
 * Returns the full upload URL ready to send in a message.
 */
export function generateUploadLink(params: {
  chatId: number;
  userId: number;
  userFirstName: string;
}): string {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  tokenStore.set(token, {
    ...params,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    used: false,
  });

  const appUrl =
    process.env.APP_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null) ||
    `http://localhost:${process.env.PORT || '3001'}`;

  return `${appUrl}/upload/${token}`;
}

// ── Multer config ───────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

// ── Express router ──────────────────────────────────────────────────────

export function createUploadRouter(): Router {
  const router = Router();

  // Serve the upload page
  router.get('/upload/:token', (req: Request, res: Response) => {
    const data = tokenStore.get(req.params.token);
    if (!data || data.expiresAt < Date.now()) {
      return res.status(410).send(pageHtml('Link Expired', 'This upload link has expired. Please go back to the Telegram chat and request a new one.', true));
    }
    if (data.used) {
      return res.status(410).send(pageHtml('Already Uploaded', 'You have already uploaded a file with this link. If you need to upload again, please go back to the Telegram chat.', true));
    }
    res.send(uploadFormHtml(req.params.token, data.userFirstName));
  });

  // Handle the upload
  router.post('/upload/:token', (req: Request, res: Response) => {
    const data = tokenStore.get(req.params.token);
    if (!data || data.expiresAt < Date.now()) {
      return res.status(410).send(pageHtml('Link Expired', 'This upload link has expired.', true));
    }
    if (data.used) {
      return res.status(410).send(pageHtml('Already Uploaded', 'A file was already uploaded with this link.', true));
    }

    // Use multer as middleware inline so we can catch its errors (file too large, etc.)
    upload.single('video')(req, res, async (multerErr) => {
      if (multerErr) {
        const msg =
          multerErr instanceof multer.MulterError && multerErr.code === 'LIMIT_FILE_SIZE'
            ? 'The file is too large (max 100 MB). Please compress it or send a shorter video.'
            : `Upload error: ${multerErr.message}`;
        return res.status(400).send(pageHtml('Upload Failed', msg, true));
      }

      if (!req.file) {
        return res.status(400).send(pageHtml('No File', 'No file was received. Please try again.', true));
      }

      // Mark used immediately to prevent double uploads
      data.used = true;

      try {
        const fileName = req.file.originalname || 'intro-video.mp4';
        const mimeType = req.file.mimetype || 'video/mp4';

        console.log(`📤 Web upload: ${fileName} (${(req.file.size / (1024 * 1024)).toFixed(1)} MB) from user ${data.userId}`);

        const driveResult = await uploadFileBuffer(
          req.file.buffer,
          fileName,
          mimeType,
        );

        if (!driveResult) {
          data.used = false; // allow retry
          return res.status(500).send(pageHtml('Upload Failed', 'We could not save your file. Please try again.', true));
        }

        // Store for the webhook handler to pick up
        const existing = webUploadsByUserId.get(data.userId) || [];
        existing.push({
          type: 'video',
          fileUrl: driveResult.downloadUrl,
          fileName,
          fileType: mimeType,
          uploadedAt: Date.now(),
        });
        webUploadsByUserId.set(data.userId, existing);

        // Notify candidate in Telegram
        try {
          await sendTelegramMessage(
            data.chatId,
            `✅ Your video has been uploaded successfully! Thank you, ${data.userFirstName}. We will include it with your application.`,
          );
        } catch (e) {
          console.warn('Could not send Telegram confirmation:', e);
        }

        console.log(`✅ Web upload complete: ${fileName} → Drive ${driveResult.fileId} for user ${data.userId}`);
        return res.send(pageHtml('Upload Successful!', 'Your video has been received. You can close this page and go back to Telegram.', false));
      } catch (error) {
        console.error('Web upload error:', error);
        data.used = false;
        return res.status(500).send(pageHtml('Something Went Wrong', 'Please try again. If the problem continues, go back to Telegram and contact us.', true));
      }
    });
  });

  return router;
}

// ── HTML templates ──────────────────────────────────────────────────────

function pageHtml(title: string, message: string, isError: boolean): string {
  const color = isError ? '#e74c3c' : '#27ae60';
  const icon = isError ? '⚠️' : '✅';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} – Azumi Staff</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{background:#fff;border-radius:16px;padding:40px 24px;max-width:420px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
.icon{font-size:48px;margin-bottom:16px}
h1{font-size:20px;color:#1a1a2e;margin-bottom:12px}
p{color:#555;font-size:15px;line-height:1.5}
.bar{height:4px;border-radius:2px;width:60px;margin:16px auto 0;background:${color}}
</style>
</head>
<body>
<div class="c">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <div class="bar"></div>
</div>
</body>
</html>`;
}

function uploadFormHtml(token: string, firstName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Upload Video – Azumi Staff</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{background:#fff;border-radius:16px;padding:32px 24px;max-width:420px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}
.logo{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:4px}
.sub{color:#888;font-size:13px;margin-bottom:20px}
.greet{font-size:15px;color:#333;margin-bottom:24px;line-height:1.4}
.drop{border:2px dashed #ccc;border-radius:12px;padding:36px 16px;cursor:pointer;transition:all .2s}
.drop:hover,.drop.over{border-color:#4a90d9;background:#f0f7ff}
.drop-icon{font-size:48px;margin-bottom:10px}
.drop-text{font-size:16px;color:#333;font-weight:500}
.drop-hint{font-size:12px;color:#999;margin-top:6px}
.info{display:none;padding:12px;background:#f0f7ff;border-radius:8px;margin:16px 0;font-size:14px;color:#333;word-break:break-all}
.btn{display:none;width:100%;padding:16px;background:#4a90d9;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer;transition:all .2s}
.btn:hover{background:#3a7bc8}
.btn:disabled{background:#bbb;cursor:not-allowed}
.prog{display:none;margin-top:16px}
.prog-bar{height:6px;background:#eee;border-radius:3px;overflow:hidden}
.prog-fill{height:100%;background:#4a90d9;border-radius:3px;width:0%;transition:width .3s}
.prog-txt{font-size:13px;color:#666;margin-top:8px}
input[type=file]{display:none}
</style>
</head>
<body>
<div class="c">
  <div class="logo">Azumi Staff</div>
  <div class="sub">Video Upload</div>
  <div class="greet">Hello, ${firstName}! Please upload your introduction video below.</div>

  <form id="f" method="POST" enctype="multipart/form-data">
    <div class="drop" id="drop" onclick="document.getElementById('fi').click()">
      <div class="drop-icon">🎥</div>
      <div class="drop-text">Tap to select your video</div>
      <div class="drop-hint">Max 100 MB</div>
    </div>
    <input type="file" id="fi" name="video" accept="video/*,.mp4,.mov,.avi,.mkv">
    <div class="info" id="info"></div>
    <button type="submit" class="btn" id="btn">Upload Video</button>
    <div class="prog" id="prog">
      <div class="prog-bar"><div class="prog-fill" id="pf"></div></div>
      <div class="prog-txt" id="pt">Uploading... 0%</div>
    </div>
  </form>
</div>

<script>
var fi=document.getElementById('fi'),info=document.getElementById('info'),
    btn=document.getElementById('btn'),drop=document.getElementById('drop'),
    form=document.getElementById('f'),prog=document.getElementById('prog'),
    pf=document.getElementById('pf'),pt=document.getElementById('pt');

fi.addEventListener('change',pick);
drop.addEventListener('dragover',function(e){e.preventDefault();drop.classList.add('over')});
drop.addEventListener('dragleave',function(){drop.classList.remove('over')});
drop.addEventListener('drop',function(e){e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files.length){fi.files=e.dataTransfer.files;pick()}});

function pick(){
  var f=fi.files[0];if(!f)return;
  var mb=(f.size/1048576).toFixed(1);
  info.textContent=f.name+' ('+mb+' MB)';
  info.style.display='block';
  btn.style.display='block';
  drop.style.display='none';
}

form.addEventListener('submit',function(e){
  e.preventDefault();
  btn.disabled=true;btn.textContent='Uploading...';
  prog.style.display='block';
  var fd=new FormData(form);
  var xhr=new XMLHttpRequest();
  xhr.open('POST',window.location.href);
  xhr.upload.onprogress=function(e){
    if(e.lengthComputable){var p=Math.round(e.loaded/e.total*100);pf.style.width=p+'%';pt.textContent='Uploading... '+p+'%'}
  };
  xhr.onload=function(){document.open();document.write(xhr.responseText);document.close()};
  xhr.onerror=function(){pt.textContent='Upload failed. Please try again.';btn.disabled=false;btn.textContent='Retry'};
  xhr.send(fd);
});
</script>
</body>
</html>`;
}
