const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const { google } = require('googleapis');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'your-cloud-name',
  api_key: process.env.CLOUDINARY_API_KEY || 'your-api-key',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'your-api-secret'
});

// Google Sheets configuration
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '129nC31UKUji9eBxa-Eao2xd7ssgzgCnq_eaE34jJbc8';

// Frame extraction percentages - 24 evenly spaced frames
const FRAME_PERCENTAGES = [
  4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 
  44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 
  84, 88, 92, 96
];

// Ensure temp directory exists
const TEMP_DIR = '/tmp/frames';

async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating temp directory:', error);
  }
}

// Extract video ID from YouTube URL
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\?\/]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Get video duration and title
async function getVideoInfo(videoUrl) {
  try {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-warnings "${videoUrl}"`
    );
    const info = JSON.parse(stdout);
    return {
      duration: info.duration,
      title: info.title
    };
  } catch (error) {
    console.error('Error getting video info:', error);
    throw new Error('Failed to get video information');
  }
}

// Extract and crop a single frame
async function extractFrame(videoPath, timestamp, outputPath, size) {
  try {
    // Extract frame with ffmpeg
    const rawFramePath = outputPath.replace('.jpg', '_raw.jpg');
    await execAsync(
      `ffmpeg -ss ${timestamp} -i "${videoPath}" -frames:v 1 -q:v 2 "${rawFramePath}"`
    );

    // Crop with Sharp
    if (size === 'portrait') {
      // 1080x1350 portrait (4:5 ratio - Facebook/Instagram optimal)
      // Shows 40% more width than 1080x1920 - keeps faces visible!
      await sharp(rawFramePath)
        .resize(1080, 1350, {
          fit: 'cover',
          position: 'center'
        })
        .jpeg({ quality: 90 })
        .toFile(outputPath);
    } else {
      // 1200x628 landscape (scale down entire video, then minimal crop)
      // This shows ~93% of the original video - keeps faces visible!
      await sharp(rawFramePath)
        .resize(1200, 675, { fit: 'inside' })  // Scale down, preserve aspect ratio
        .extract({
          left: 0,
          top: 24,      // Remove just 24px from top
          width: 1200,
          height: 628   // Remove 24px from bottom too
        })
        .jpeg({ quality: 90 })
        .toFile(outputPath);
    }

    // Clean up raw frame
    await fs.unlink(rawFramePath);
    
    return outputPath;
  } catch (error) {
    console.error('Error extracting frame:', error);
    throw error;
  }
}

// Upload image to Cloudinary
async function uploadToCloudinary(imagePath, videoId, percent, size) {
  try {
    const result = await cloudinary.uploader.upload(imagePath, {
      folder: 'youtube-frames',
      public_id: `${videoId}-${percent}-${size}`,
      overwrite: true
    });
    return result.secure_url;
  } catch (error) {
    console.error('Error uploading to Cloudinary:', error);
    throw error;
  }
}

// Add row to Google Sheet
async function addToGoogleSheet(data) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // First, ensure headers exist
    const headerRange = 'Sheet1!A1:K1';
    const headers = [
      'Timestamp',
      'YouTube URL', 
      'Video Title',
      'Video Description',
      'Portrait %',
      'Portrait URL',
      'Landscape %',
      'Landscape URL',
      'Blog Post Link',
      'Status',
      'Processed'
    ];

    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: headerRange,
        valueInputOption: 'RAW',
        resource: { values: [headers] }
      });
    } catch (err) {
      console.log('Headers may already exist');
    }

    // Add the data row
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const row = [
      timestamp,              // A: Timestamp
      data.videoUrl,          // B: YouTube URL
      data.videoTitle,        // C: Video Title
      '',                     // D: Video Description (filled by Make.com)
      `${data.portraitPercent}%`,   // E: Portrait %
      data.portraitUrl,       // F: Portrait URL
      `${data.landscapePercent}%`,  // G: Landscape %
      data.landscapeUrl,      // H: Landscape URL
      '',                     // I: Blog Post Link (filled by Make.com)
      'Pending',              // J: Status
      ''                      // K: Processed (filled by Make.com)
    ];

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:K',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] }
    });

    return response.data;
  } catch (error) {
    console.error('Error adding to Google Sheet:', error);
    throw error;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'YouTube Frame Extractor API',
    endpoints: {
      'GET /': 'This health check',
      'POST /extract-frames-both': 'Extract 6 portrait + 6 landscape frames',
      'POST /save-selection': 'Save selected frames to Cloudinary and Google Sheet'
    }
  });
});

// Extract all frames (portrait and landscape)
app.post('/extract-frames-both', async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  await ensureTempDir();

  const tempVideo = path.join(TEMP_DIR, `${videoId}.mp4`);
  
  try {
    // Get video info
    const { duration, title } = await getVideoInfo(videoUrl);

    // Download video
    console.log('Downloading video...');
    await execAsync(
      `yt-dlp -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]" ` +
      `--merge-output-format mp4 -o "${tempVideo}" "${videoUrl}"`
    );

    // Extract frames for both sizes
    const portraitFrames = [];
    const landscapeFrames = [];

    for (const percent of FRAME_PERCENTAGES) {
      const timestamp = Math.floor((percent / 100) * duration);
      
      // Portrait frame
      const portraitPath = path.join(TEMP_DIR, `${videoId}-${percent}-portrait.jpg`);
      await extractFrame(tempVideo, timestamp, portraitPath, 'portrait');
      const portraitBuffer = await fs.readFile(portraitPath);
      const portraitBase64 = `data:image/jpeg;base64,${portraitBuffer.toString('base64')}`;
      
      portraitFrames.push({
        percent,
        timestamp,
        image: portraitBase64
      });

      // Landscape frame
      const landscapePath = path.join(TEMP_DIR, `${videoId}-${percent}-landscape.jpg`);
      await extractFrame(tempVideo, timestamp, landscapePath, 'landscape');
      const landscapeBuffer = await fs.readFile(landscapePath);
      const landscapeBase64 = `data:image/jpeg;base64,${landscapeBuffer.toString('base64')}`;
      
      landscapeFrames.push({
        percent,
        timestamp,
        image: landscapeBase64
      });

      // Clean up frame files
      await fs.unlink(portraitPath);
      await fs.unlink(landscapePath);
    }

    // Clean up video file
    await fs.unlink(tempVideo);

    res.json({
      videoId,
      videoTitle: title,
      duration,
      portrait: portraitFrames,
      landscape: landscapeFrames
    });

  } catch (error) {
    console.error('Error extracting frames:', error);
    
    // Cleanup
    try {
      await fs.unlink(tempVideo);
    } catch (e) {}

    res.status(500).json({ 
      error: 'Failed to extract frames',
      details: error.message 
    });
  }
});

// Save selected frames
app.post('/save-selection', async (req, res) => {
  const { 
    videoUrl, 
    videoTitle,
    portraitFrame,
    landscapeFrame 
  } = req.body;

  if (!videoUrl || !portraitFrame || !landscapeFrame) {
    return res.status(400).json({ 
      error: 'videoUrl, portraitFrame, and landscapeFrame are required' 
    });
  }

  const videoId = extractVideoId(videoUrl);
  await ensureTempDir();

  try {
    // Save portrait frame temporarily
    const portraitPath = path.join(TEMP_DIR, `${videoId}-${portraitFrame.percent}-portrait-final.jpg`);
    const portraitBuffer = Buffer.from(
      portraitFrame.image.replace(/^data:image\/jpeg;base64,/, ''),
      'base64'
    );
    await fs.writeFile(portraitPath, portraitBuffer);

    // Save landscape frame temporarily
    const landscapePath = path.join(TEMP_DIR, `${videoId}-${landscapeFrame.percent}-landscape-final.jpg`);
    const landscapeBuffer = Buffer.from(
      landscapeFrame.image.replace(/^data:image\/jpeg;base64,/, ''),
      'base64'
    );
    await fs.writeFile(landscapePath, landscapeBuffer);

    // Upload to Cloudinary
    const portraitUrl = await uploadToCloudinary(
      portraitPath, 
      videoId, 
      portraitFrame.percent, 
      'portrait'
    );
    
    const landscapeUrl = await uploadToCloudinary(
      landscapePath, 
      videoId, 
      landscapeFrame.percent, 
      'landscape'
    );

    // Add to Google Sheet
    const sheetData = {
      videoUrl,
      videoTitle,
      portraitPercent: portraitFrame.percent,
      portraitUrl,
      landscapePercent: landscapeFrame.percent,
      landscapeUrl
    };

    await addToGoogleSheet(sheetData);

    // Cleanup
    await fs.unlink(portraitPath);
    await fs.unlink(landscapePath);

    res.json({
      success: true,
      portraitUrl,
      landscapeUrl,
      message: 'Frames saved to Cloudinary and Google Sheet'
    });

  } catch (error) {
    console.error('Error saving selection:', error);
    res.status(500).json({ 
      error: 'Failed to save frames',
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  ensureTempDir();
});
