const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);
const app = express();

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'online',
    message: 'YouTube Frame Extraction API',
    endpoints: {
      extract: 'POST /extract-frame'
    }
  });
});

// Main extraction endpoint
app.post('/extract-frame', async (req, res) => {
  const { videoUrl, timestamp = 'auto' } = req.body;
  
  console.log(`Processing: ${videoUrl}`);
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }
  
  try {
    // 1. Extract video ID from URL
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    console.log(`Video ID: ${videoId}`);
    
    // 2. Get video duration
    console.log('Getting video info...');
    const duration = await getVideoDuration(videoUrl);
    console.log(`Duration: ${duration}s`);
    
    // 3. Calculate extraction timestamp
    let extractTime;
    if (timestamp === 'auto') {
      // Extract from 65% through (optimal for most videos)
      extractTime = Math.floor(duration * 0.65);
    } else {
      extractTime = parseInt(timestamp);
    }
    
    console.log(`Extracting frame at ${extractTime}s (${((extractTime/duration)*100).toFixed(1)}%)`);
    
    // 4. Create temp directory if it doesn't exist
    const tempDir = '/tmp/frames';
    await fs.mkdir(tempDir, { recursive: true });
    
    // 5. Download frame using yt-dlp and ffmpeg
    const rawFramePath = path.join(tempDir, `${videoId}_raw.jpg`);
    
    console.log('Downloading and extracting frame...');
    await execAsync(
      `yt-dlp -f "best[height<=1080]" ` +
      `--external-downloader ffmpeg ` +
      `--external-downloader-args "-ss ${extractTime} -t 2" ` +
      `-o - "${videoUrl}" | ` +
      `ffmpeg -i pipe:0 -ss 1 -vframes 1 -q:v 2 "${rawFramePath}"`,
      { maxBuffer: 50 * 1024 * 1024 } // 50MB buffer
    );
    
    console.log('Frame extracted, cropping to portrait...');
    
    // 6. Crop to 1080x1920 portrait format
    const croppedFramePath = path.join(tempDir, `${videoId}_cropped.jpg`);
    
    await sharp(rawFramePath)
      .resize(1080, 1920, {
        fit: 'cover',
        position: 'centre' // Smart center crop
      })
      .jpeg({ 
        quality: 90,
        mozjpeg: true // Better compression
      })
      .toFile(croppedFramePath);
    
    console.log('Success! Sending file...');
    
    // 7. Send the file
    res.sendFile(croppedFramePath, async (err) => {
      // Clean up temp files after sending
      try {
        await fs.unlink(rawFramePath);
        await fs.unlink(croppedFramePath);
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Failed to extract frame. Check if video URL is valid and accessible.'
    });
  }
});

// Helper function to extract video ID from YouTube URL
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // Just the ID
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

// Get video duration using yt-dlp
async function getVideoDuration(videoUrl) {
  try {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-warnings "${videoUrl}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    
    const videoInfo = JSON.parse(stdout);
    return videoInfo.duration || 300; // Default 5 minutes if not found
  } catch (error) {
    console.error('Error getting duration:', error);
    return 300; // Default fallback
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 YouTube Frame Extraction API running on port ${PORT}`);
  console.log(`📍 Ready to process requests at POST /extract-frame`);
});
