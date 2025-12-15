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
      extract: 'POST /extract-frame',
      extractMultiple: 'POST /extract-frames-multiple'
    }
  });
});

// Extract multiple frames
app.post('/extract-frames-multiple', async (req, res) => {
  const { videoUrl } = req.body;
  
  console.log(`Processing multiple frames: ${videoUrl}`);
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }
  
  try {
    // 1. Extract video ID
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    console.log(`Video ID: ${videoId}`);
    
    // 2. Get video duration
    console.log('Getting video info...');
    const duration = await getVideoDuration(videoUrl);
    console.log(`Duration: ${duration}s`);
    
    // 3. Calculate 3 timestamps: 50%, 65%, 75%
    const timestamps = [
      { percent: 50, time: Math.floor(duration * 0.50), label: 'middle' },
      { percent: 65, time: Math.floor(duration * 0.65), label: 'climax' },
      { percent: 75, time: Math.floor(duration * 0.75), label: 'late' }
    ];
    
    console.log(`Extracting frames at: ${timestamps.map(t => `${t.time}s (${t.percent}%)`).join(', ')}`);
    
    // 4. Create temp directory
    const tempDir = '/tmp/frames';
    await fs.mkdir(tempDir, { recursive: true });
    
    const tempVideo = path.join(tempDir, `${videoId}_video.mp4`);
    
    // 5. Download video once
    console.log('Downloading video...');
    await execAsync(
      `yt-dlp -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]" ` +
      `--merge-output-format mp4 ` +
      `-o "${tempVideo}" "${videoUrl}"`,
      { maxBuffer: 100 * 1024 * 1024 }
    );
    
    // 6. Extract and process all 3 frames
    const results = [];
    
    for (const ts of timestamps) {
      console.log(`Processing ${ts.label} frame (${ts.percent}%)...`);
      
      const rawFramePath = path.join(tempDir, `${videoId}_raw_${ts.label}.jpg`);
      const croppedFramePath = path.join(tempDir, `${videoId}_cropped_${ts.label}.jpg`);
      
      // Extract frame
      await execAsync(
        `ffmpeg -ss ${ts.time} -i "${tempVideo}" -frames:v 1 -q:v 2 "${rawFramePath}"`,
        { maxBuffer: 10 * 1024 * 1024 }
      );
      
      // Crop to portrait
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
      
      // Read as base64
      const imageBuffer = await fs.readFile(croppedFramePath);
      const base64Image = imageBuffer.toString('base64');
      
      results.push({
        label: ts.label,
        percent: ts.percent,
        timestamp: ts.time,
        image: `data:image/jpeg;base64,${base64Image}`
      });
      
      // Cleanup raw frame
      await fs.unlink(rawFramePath);
      await fs.unlink(croppedFramePath);
    }
    
    // Cleanup video
    await fs.unlink(tempVideo);
    
    console.log('Success! Sending 3 frames...');
    
    res.json({
      videoId: videoId,
      duration: duration,
      frames: results
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Failed to extract frames.'
    });
  }
});

// Single frame extraction (original endpoint)
app.post('/extract-frame', async (req, res) => {
  const { videoUrl, timestamp = 'auto' } = req.body;
  
  console.log(`Processing: ${videoUrl}`);
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }
  
  try {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    console.log(`Video ID: ${videoId}`);
    
    const duration = await getVideoDuration(videoUrl);
    console.log(`Duration: ${duration}s`);
    
    let extractTime;
    if (timestamp === 'auto') {
      extractTime = Math.floor(duration * 0.65);
    } else {
      extractTime = parseInt(timestamp);
    }
    
    console.log(`Extracting frame at ${extractTime}s`);
    
    const tempDir = '/tmp/frames';
    await fs.mkdir(tempDir, { recursive: true });
    
    const tempVideo = path.join(tempDir, `${videoId}_video.mp4`);
    const rawFramePath = path.join(tempDir, `${videoId}_raw.jpg`);
    
    console.log('Downloading video...');
    await execAsync(
      `yt-dlp -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]" ` +
      `--merge-output-format mp4 ` +
      `-o "${tempVideo}" "${videoUrl}"`,
      { maxBuffer: 100 * 1024 * 1024 }
    );
    
    console.log('Extracting frame...');
    await execAsync(
      `ffmpeg -ss ${extractTime} -i "${tempVideo}" -frames:v 1 -q:v 2 "${rawFramePath}"`,
      { maxBuffer: 10 * 1024 * 1024 }
    );
    
    console.log('Cropping to portrait...');
    
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
    
    res.sendFile(croppedFramePath, async (err) => {
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
      details: 'Failed to extract frame.'
    });
  }
});

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 YouTube Frame Extraction API running on port ${PORT}`);
  console.log(`📍 Ready to process requests at POST /extract-frame`);
  console.log(`📍 Ready to process requests at POST /extract-frames-multiple`);
});
