# 🎤 B2 + Whisper Browser Transcriber

Client-side Speech-to-Text demo using [Transformers.js](https://huggingface.co/docs/transformers.js) and [Backblaze B2](https://www.backblaze.com/cloud-storage?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples) cloud storage.

Run [OpenAI's Whisper](https://openai.com/research/whisper) entirely in your browser - no server GPU needed, with audio files and transcripts stored in cost-effective B2 storage.

## 🚀 Technologies

- **[Transformers.js](https://huggingface.co/docs/transformers.js)** - Run AI models like Whisper in the browser with WebAssembly
- **[Whisper](https://github.com/openai/whisper)** - OpenAI's automatic speech recognition model
- **[Backblaze B2](https://www.backblaze.com/cloud-storage?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples)** - S3-compatible cloud storage at $6/TB/month

## ✨ What This Demonstrates

- **Client-side AI**: Run Whisper entirely in browser (no server GPU required)
- **Cost-effective Storage**: Store audio and transcripts in Backblaze B2
- **Secure Uploads**: Direct browser-to-cloud uploads with pre-signed URLs
- **Simple Architecture**: Complete flow from upload → transcribe → store

## Architecture

```
User → Upload Audio → B2 Storage
                    ↓
Browser Whisper (Transformers.js) → Transcribe
                    ↓
      Transcript → B2 Storage
```

### Flow

1. User selects/drops audio file in browser
2. Backend generates pre-signed PUT URL for B2
3. Browser uploads audio directly to B2
4. Browser loads Whisper model (Xenova/whisper-tiny.en)
5. Browser transcribes audio locally
6. Backend generates pre-signed PUT URL for transcript
7. Browser uploads transcript JSON to B2

## 🚀 Quick Start

### Prerequisites

- **Node.js 18+**
- **[Backblaze B2 Account](https://www.backblaze.com/cloud-storage?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples)** (free tier available)
  - Create a bucket
  - Generate an Application Key with `readFiles`, `writeFiles`, `writeBuckets` permissions

### 1. Clone & Install

```bash
git clone https://github.com/backblaze-b2-samples/b2-whisper-transformersjs-transcriber.git
cd b2-whisper-transcriber/backend
npm install
```

### 2. Configure B2 Credentials

```bash
cp .env.example .env
```

Edit `.env` with your [B2 credentials](https://www.backblaze.com/docs/cloud-storage-enable-backblaze-b2?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples):

```env
B2_ENDPOINT=https://s3.us-west-002.backblazeb2.com
B2_REGION=us-west-002
B2_KEY_ID=your_key_id_here
B2_APP_KEY=your_app_key_here
B2_BUCKET=your-bucket-name
```

> Get your B2 endpoint and region from your [bucket details page](https://secure.backblaze.com/b2_buckets.htm?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples)

### 3. Start the App

```bash
npm start
```

**That's it!** The server automatically:
- ✅ Configures B2 CORS for browser uploads
- ✅ Serves both frontend and API
- ✅ Opens at `http://localhost:3000`

### 4. Use the App

1. Open **http://localhost:3000** in your browser
2. Upload an audio file (MP3, WAV, M4A, etc.)
3. Click **"Transcribe with Whisper"**
4. View transcription and access files in B2

> ⚠️ First run downloads the Whisper model (~40MB) - this takes 1-2 minutes

## Manual CORS Setup

If auto-setup fails (missing permissions), run manually:

```bash
npm run setup-cors
```

**Required B2 Key Permissions**:
- `listBuckets`
- `readFiles`
- `writeFiles`
- `writeBucketSettings` ← Required for CORS setup

**Alternative - B2 CLI**:

```bash
b2 update-bucket --cors-rules '[
  {
    "corsRuleName": "allowBrowserUploads",
    "allowedOrigins": ["*"],
    "allowedHeaders": ["*"],
    "allowedOperations": ["s3_put", "s3_get", "s3_head"],
    "maxAgeSeconds": 3600
  }
]' <bucket-name> allPublic
```

**Alternative - B2 Web Console**:
1. Go to https://secure.backblaze.com/b2_buckets.htm
2. Click your bucket → Bucket Settings → CORS Rules
3. Add the rules shown above

## Usage

1. Open the frontend in your browser  
2. Ensure the Backend API URL is correct (default: `http://localhost:3000`)  
3. Drag and drop an audio file or click to browse  
   - Or download this **[example audio clip](https://f001.backblazeb2.com/file/odh-datasets/samplemedia/audio/One-small-step-for-man.mp3)** to test  
4. Audio automatically uploads to B2  
5. Click **"Transcribe with Whisper"**  
6. Wait for transcription (first run downloads model)  
7. View results and access files in B2

## Deployment

### Deploy Backend

**Railway / Render / Fly.io**:
- Set environment variables from `.env`
- Deploy `backend/` directory
- Update frontend `apiUrl` to deployed URL

**Docker**:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
CMD ["node", "server.js"]
```

### Deploy Frontend

**Static Hosting** (Netlify, Vercel, Cloudflare Pages):
- Deploy `frontend/` directory
- Set API URL in settings or hardcode in `index.html:170`

**B2 Static Hosting**:
- Upload `frontend/index.html` to B2 bucket
- Enable website hosting on bucket
- Access via B2 website URL

## B2 Configuration

### Bucket Settings

1. Create bucket (Private or Public based on needs)
2. For public access to audio/transcripts, set bucket to Public
3. Enable CORS if frontend hosted on different domain:

```json
[
  {
    "corsRuleName": "allowAll",
    "allowedOrigins": ["*"],
    "allowedHeaders": ["*"],
    "allowedOperations": ["s3_put", "s3_get"],
    "maxAgeSeconds": 3600
  }
]
```

### Generate B2 Keys

```bash
# Using B2 CLI
b2 create-key <keyName> listBuckets,readFiles,writeFiles
```

Or use B2 Web UI → App Keys → Create Key

## API Endpoints

### POST /api/presign-audio

Request:
```json
{
  "filename": "audio.mp3",
  "contentType": "audio/mpeg"
}
```

Response:
```json
{
  "uploadUrl": "https://...",
  "publicUrl": "https://...",
  "key": "audio/uuid.mp3",
  "fileId": "uuid"
}
```

### POST /api/presign-transcript

Request:
```json
{
  "fileId": "uuid"
}
```

Response:
```json
{
  "uploadUrl": "https://...",
  "publicUrl": "https://...",
  "key": "transcripts/uuid.json"
}
```

## 🔧 Technical Details

### Whisper Model

- **Model**: [Xenova/whisper-tiny.en](https://huggingface.co/Xenova/whisper-tiny.en) (English only, 39M params)
- **Library**: [Transformers.js](https://huggingface.co/docs/transformers.js) - Run transformers in the browser
- **Quantization**: q8 (8-bit) for speed
- **Size**: ~40MB download (cached in browser)
- **Speed**: ~30 seconds for 1 minute audio

### Storage

- **Provider**: [Backblaze B2](https://www.backblaze.com/b2/cloud-storage.html?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples)
- **API**: S3-compatible API with pre-signed URLs
- **Pricing**: $6/TB/month storage, uploads are FREE
- **Documentation**: [B2 S3-Compatible API Docs](https://www.backblaze.com/b2/docs/s3_compatible_api.html?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples)

### Supported Audio Formats

MP3, WAV, OGG, M4A, WEBM, FLAC

### Browser Compatibility

- Chrome 90+
- Edge 90+
- Firefox 90+
- Safari 15.4+

Requires WebAssembly and ES6 modules support.

## Limitations

- First transcription loads model (~40MB, one-time)
- Whisper-tiny less accurate than base/small/medium
- English only (use `Xenova/whisper-tiny` for multilingual)
- Browser must stay open during transcription
- Large files (>30min) may be slow

## 🎯 Potential Improvements

- [ ] Add recording directly in browser (MediaRecorder API)
- [ ] Support larger Whisper models (base, small, medium)
- [ ] Progress callback for transcription
- [ ] Batch processing multiple files
- [ ] Word-level timestamps
- [ ] Speaker diarization
- [ ] Multi-language support using `Xenova/whisper-tiny` (not `-tiny.en`)

## 📚 Learn More

- **[Transformers.js Documentation](https://huggingface.co/docs/transformers.js)** - Run AI models in the browser
- **[Transformers.js GitHub](https://github.com/xenova/transformers.js)** - Source code and examples
- **[Backblaze B2 Documentation](https://www.backblaze.com/b2/docs/?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples)** - Cloud storage API docs
- **[B2 S3-Compatible API](https://www.backblaze.com/b2/docs/s3_compatible_api.html?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=audiosamples)** - S3 compatibility guide
- **[OpenAI Whisper](https://github.com/openai/whisper)** - Original Whisper model
- **[Whisper Models on Hugging Face](https://huggingface.co/models?search=whisper)** - Pre-trained models

## Troubleshooting

### CORS Error: "Access to fetch has been blocked by CORS policy"

**Problem**: Browser shows CORS error when uploading audio.

**Solution**:
1. Run `npm run setup-cors` in the backend directory
2. Or manually configure CORS on your B2 bucket (see Setup section)
3. Verify CORS is set: Go to B2 Console → Your Bucket → Settings → CORS Rules

**Required CORS settings**:
- Allowed Origins: `*` (or specific origins like `http://localhost:8080`)
- Allowed Methods: `GET`, `PUT`, `HEAD`
- Allowed Headers: `*`

### Backend Connection Error

**Problem**: Frontend can't connect to backend API.

**Solution**:
1. Verify backend is running: `curl http://localhost:3000/health`
2. Check API URL in frontend matches backend (default: `http://localhost:3000`)
3. Look for CORS errors in backend logs

### Transcription Fails or Hangs

**Problem**: Whisper model fails to load or transcribe.

**Solution**:
1. **First run takes time**: Model downloads ~40MB, wait 1-2 minutes
2. **Check browser console**: Look for specific errors
3. **Try smaller file**: Test with <1 minute audio first
4. **Clear cache**: Hard refresh browser (Ctrl+Shift+R / Cmd+Shift+R)
5. **Use supported browser**: Chrome, Edge, or Firefox recommended

### Upload Works but Can't Access Files

**Problem**: Files upload but URLs don't work.

**Solution**:
1. Check bucket is public or URLs are pre-signed
2. Verify endpoint URL matches bucket region
3. Try accessing URL directly in browser
4. Check B2 bucket lifecycle rules aren't deleting files

### ContentScript.bundle.js Errors

**Problem**: Console shows errors from `contentScript.bundle.js`.

**Solution**: These are from browser extensions (like Claude Code). Safe to ignore - they don't affect the app.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
