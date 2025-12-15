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
      extractTime = Math.floor(duration * 0.65);
    } else {
      extractTime = parseInt(timestamp);
    }
    
    console.log(`Extracting frame at ${extractTime}s (${((extractTime/duration)*100).toFixed(1)}%)`);
    
    // 4. Create temp directory
    const tempDir = '/tmp/frames';
    await fs.mkdir(tempDir, { recursive: true });
    
    const tempVideo = path.join(tempDir, `${videoId}_video.mp4`);
    const rawFramePath = path.join(tempDir, `${videoId}_raw.jpg`);
    
    // 5. Download full video file
    console.log('Downloading video...');
    await execAsync(
      `yt-dlp -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]" ` +
      `--merge-output-format mp4 ` +
      `-o "${tempVideo}" "${videoUrl}"`,
      { maxBuffer: 100 * 1024 * 1024 }
    );
    
    // 6. Extract frame from downloaded file
    console.log('Extracting frame...');
    await execAsync(
      `ffmpeg -ss ${extractTime} -i "${tempVideo}" -frames:v 1 -q:v 2 "${rawFramePath}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    
    console.log('Cropping to portrait...');
    
    // 7. Crop to 1080x1920 portrait format
    const croppedFramePath = path.join(tempDir, `${videoId}_cropped.jpg`);
    
    await sharp(rawFramePath)
      .resize(1080, 1920, {
        fit: 'cover',
        position: 'centre'
      })
      .jpeg({ 
        quality: 90,
        mozjpeg: true
      })
      .toFile(croppedFramePath);
    
    console.log('Success! Sending file...');
    
    // 8. Send the file
    res.sendFile(croppedFramePath, async (err) => {
      // Clean up temp files after sending
      try {
        await fs.unlink(tempVideo);
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
    /^([a-zA-Z0-9_-]{11})$/
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
    return videoInfo.duration || 300;
  } catch (error) {
    console.error('Error getting duration:', error);
    return 300;
  }
}

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 YouTube Frame Extraction API running on port ${PORT}`);
  console.log(`📍 Ready to process requests at POST /extract-frame`);
});
