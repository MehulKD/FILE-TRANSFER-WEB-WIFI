/**
 * LAN File Transfer Server
 * ------------------------
 * A single Node.js process that serves:
 *   - an "upload" page (for the sending device)
 *   - a "receive" page (for the receiving device, live-updating)
 *   - a JSON + multipart HTTP API for uploads and file listing
 *   - a WebSocket channel that pushes file-list updates to every
 *     connected browser the instant a new file finishes uploading
 *
 * Also handles, server-side, on upload:
 *   - thumbnail generation for photos AND videos (so even formats a
 *     phone browser can't natively preview — HEIC, MKV, etc. — still
 *     show a real picture in the live list)
 *   - optional format conversion, chosen per-upload by the sender
 *     (e.g. "convert everything to JPEG / MP4" or "keep original")
 *
 * Everything runs over the local network only. No cloud, no accounts.
 */

const express = require('express');
const multer = require('multer');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { WebSocketServer } = require('ws');

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const THUMB_DIR = path.join(UPLOAD_DIR, '.thumbnails');
const MAX_FILE_SIZE_MB = 4096; // 4GB per file ceiling (4K video can be large)

for (const dir of [UPLOAD_DIR, THUMB_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------------------------------------------------------------------
// Format support — as broad as practical. Browsers/OSes are inconsistent
// about the MIME type they report for some of these (HEIC, MKV, raw camera
// formats, etc.), so extension is treated as the primary signal and MIME
// type as a fallback signal.
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = [
  '.jpg', '.jpeg', '.jpe', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff',
  '.heic', '.heif', '.avif', '.svg', '.ico', '.jfif', '.apng',
  // Common camera RAW formats (previewed as a generic icon if sharp can't
  // decode a particular vendor's RAW variant; original is still saved).
  '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.srw',
];

const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.flv',
  '.mpg', '.mpeg', '.3gp', '.3g2', '.ogv', '.ts', '.m2ts', '.mts', '.qt',
];

// Formats a browser can convert straight into an <img>/<video> src without
// server help — used only to decide whether we can skip building a preview
// thumbnail and just point at the original file instead.
const WEB_SAFE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.jpe', '.png', '.gif', '.webp', '.svg', '.jfif', '.apng'];

// Image formats sharp can convert INTO (offered as "convert to" choices).
const IMAGE_OUTPUT_FORMATS = {
  jpeg: { ext: '.jpg', apply: (img) => img.jpeg({ quality: 90 }) },
  png: { ext: '.png', apply: (img) => img.png() },
  webp: { ext: '.webp', apply: (img) => img.webp({ quality: 90 }) },
};

// Video formats ffmpeg can convert INTO (offered as "convert to" choices).
const VIDEO_OUTPUT_FORMATS = {
  mp4: {
    ext: '.mp4',
    apply: (cmd) => cmd.outputOptions([
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    ]),
  },
  webm: {
    ext: '.webm',
    apply: (cmd) => cmd.outputOptions(['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus']),
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name) {
  const base = path.basename(name).replace(/[\u0000-\u001f]/g, '');
  return base.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'file';
}

/** If "photo.jpg" already exists, produce "photo (1).jpg", "photo (2).jpg", etc. */
function uniqueDestination(originalName) {
  const safe = sanitizeFilename(originalName);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  let candidate = safe;
  let counter = 1;
  while (fs.existsSync(path.join(UPLOAD_DIR, candidate))) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

function classify(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return 'file';
}

function isAcceptedFile(originalname, mimetype) {
  const ext = path.extname(originalname).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext)) return true;
  // Fallback for the rare case a file arrives with an unrecognized
  // extension but a clear image/video MIME type.
  return mimetype.startsWith('image/') || mimetype.startsWith('video/');
}

function thumbFilenameFor(finalName) {
  return `${finalName}.thumb.jpg`;
}

/** Resized JPEG preview so even non-web-safe formats (HEIC, TIFF, RAW...) show a picture. */
async function generateImageThumbnail(imagePath, outputPath) {
  try {
    await sharp(imagePath)
      .rotate() // respect EXIF orientation (iOS photos are often "rotated" via metadata)
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toFile(outputPath);
    return true;
  } catch (err) {
    console.warn(`[thumbnail] image preview failed for ${path.basename(imagePath)}: ${err.message}`);
    return false;
  }
}

/** Grabs one frame ~10% into the video as a JPEG thumbnail. */
function generateVideoThumbnail(videoPath, thumbDir, thumbFilename) {
  return new Promise((resolve) => {
    try {
      ffmpeg(videoPath)
        .on('end', () => resolve(true))
        .on('error', (err) => {
          console.warn(`[thumbnail] video preview failed for ${path.basename(videoPath)}: ${err.message}`);
          resolve(false);
        })
        .screenshots({ timestamps: ['10%'], filename: thumbFilename, folder: thumbDir, size: '480x?' });
    } catch (err) {
      console.warn(`[thumbnail] video preview failed for ${path.basename(videoPath)}: ${err.message}`);
      resolve(false);
    }
  });
}

async function convertImage(inputPath, outputPath, format) {
  const spec = IMAGE_OUTPUT_FORMATS[format];
  if (!spec) return false;
  try {
    await spec.apply(sharp(inputPath).rotate()).toFile(outputPath);
    return true;
  } catch (err) {
    console.warn(`[convert] image conversion to ${format} failed for ${path.basename(inputPath)}: ${err.message}`);
    return false;
  }
}

function convertVideo(inputPath, outputPath, format) {
  const spec = VIDEO_OUTPUT_FORMATS[format];
  if (!spec) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const cmd = ffmpeg(inputPath)
        .on('end', () => resolve(true))
        .on('error', (err) => {
          console.warn(`[convert] video conversion to ${format} failed for ${path.basename(inputPath)}: ${err.message}`);
          resolve(false);
        });
      spec.apply(cmd).save(outputPath);
    } catch (err) {
      console.warn(`[convert] video conversion to ${format} failed for ${path.basename(inputPath)}: ${err.message}`);
      resolve(false);
    }
  });
}

/**
 * Given a just-uploaded temp file plus the sender's requested output
 * format, optionally converts it, then always builds a preview thumbnail
 * (for images/video), then returns the client-facing file record.
 */
async function processUploadedFile(file, body) {
  const kind = classify(file.filename);
  let finalName = file.filename;
  let currentPath = file.path;
  const originalExt = path.extname(finalName).toLowerCase();

  if (kind === 'image') {
    const desired = (body.imageFormat || 'original').toLowerCase();
    const spec = IMAGE_OUTPUT_FORMATS[desired];
    if (spec && spec.ext !== originalExt) {
      const candidateName = uniqueDestination(path.basename(finalName, originalExt) + spec.ext);
      const candidatePath = path.join(UPLOAD_DIR, candidateName);
      if (await convertImage(currentPath, candidatePath, desired)) {
        fs.unlinkSync(currentPath);
        finalName = candidateName;
        currentPath = candidatePath;
      }
    }
    await generateImageThumbnail(currentPath, path.join(THUMB_DIR, thumbFilenameFor(finalName)));
  } else if (kind === 'video') {
    const desired = (body.videoFormat || 'original').toLowerCase();
    const spec = VIDEO_OUTPUT_FORMATS[desired];
    if (spec && spec.ext !== originalExt) {
      const candidateName = uniqueDestination(path.basename(finalName, originalExt) + spec.ext);
      const candidatePath = path.join(UPLOAD_DIR, candidateName);
      if (await convertVideo(currentPath, candidatePath, desired)) {
        fs.unlinkSync(currentPath);
        finalName = candidateName;
        currentPath = candidatePath;
      }
    }
    await generateVideoThumbnail(currentPath, THUMB_DIR, thumbFilenameFor(finalName));
  }

  return fileToRecord(finalName);
}

function fileToRecord(filename) {
  const filePath = path.join(UPLOAD_DIR, filename);
  const stat = fs.statSync(filePath);
  const kind = classify(filename);
  const thumbName = thumbFilenameFor(filename);
  const hasThumb = fs.existsSync(path.join(THUMB_DIR, thumbName));
  return {
    name: filename,
    size: stat.size,
    uploadedAt: stat.mtimeMs,
    kind,
    webSafe: WEB_SAFE_IMAGE_EXTENSIONS.includes(path.extname(filename).toLowerCase()),
    url: `/uploads/${encodeURIComponent(filename)}`,
    thumbUrl: hasThumb ? `/thumbnails/${encodeURIComponent(thumbName)}` : null,
  };
}

function listFiles() {
  return fs
    .readdirSync(UPLOAD_DIR)
    .filter((f) => !f.startsWith('.')) // skips the .thumbnails directory too
    .map(fileToRecord)
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(data);
  });
}

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) results.push(net.address);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Multer (multipart upload) configuration
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Multer gives us the original name in latin1; fix UTF-8 filenames
    // (common with emoji / non-ASCII names from iOS Photos).
    const fixedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, uniqueDestination(fixedName));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (isAcceptedFile(file.originalname, file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.originalname}`));
    }
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: true, dotfiles: 'deny' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/formats', (req, res) => {
  res.json({
    imageFormats: Object.keys(IMAGE_OUTPUT_FORMATS),
    videoFormats: Object.keys(VIDEO_OUTPUT_FORMATS),
  });
});

app.get('/api/files', (req, res) => {
  res.json({ files: listFiles() });
});

app.get('/thumbnails/:name', (req, res) => {
  const safe = sanitizeFilename(req.params.name);
  const thumbPath = path.join(THUMB_DIR, safe);
  if (!thumbPath.startsWith(THUMB_DIR) || !fs.existsSync(thumbPath)) return res.status(404).end();
  res.sendFile(thumbPath);
});

app.post('/api/upload', (req, res) => {
  upload.array('files', 100)(req, res, async (err) => {
    if (err) {
      const status = err.message.startsWith('Unsupported') ? 415 : 400;
      return res.status(status).json({ error: err.message });
    }
    try {
      const results = [];
      // Processed one at a time (not in parallel) so video conversion
      // doesn't try to fully saturate the CPU across many files at once.
      for (const file of req.files || []) {
        results.push(await processUploadedFile(file, req.body));
      }
      if (results.length > 0) broadcast({ type: 'files-added', files: results });
      res.json({ ok: true, uploaded: results });
    } catch (procErr) {
      console.error('[upload] processing error:', procErr);
      res.status(500).json({ error: 'Server failed to process one or more files.' });
    }
  });
});

app.delete('/api/files/:name', (req, res) => {
  const safe = sanitizeFilename(req.params.name);
  const filePath = path.join(UPLOAD_DIR, safe);
  if (!filePath.startsWith(UPLOAD_DIR)) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  const thumbPath = path.join(THUMB_DIR, thumbFilenameFor(safe));
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  broadcast({ type: 'file-removed', name: safe });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket: send the current list the moment a client connects
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', files: listFiles() }));
  broadcast({ type: 'peer-count', count: wss.clients.size });

  ws.on('close', () => {
    broadcast({ type: 'peer-count', count: wss.clients.size });
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('\nLAN File Transfer is running.\n');
  console.log(`  Local:    http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  Network:  http://${ip}:${PORT}`));
  console.log('\nOpen the "Network" URL on both devices (same WiFi).');
  console.log(`Files are stored in: ${UPLOAD_DIR}\n`);
});
