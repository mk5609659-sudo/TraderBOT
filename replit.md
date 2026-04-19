# TraderBOT Discord Moderation

A Discord bot for automated server moderation with link filtering, image analysis, and optional offline voice monitoring.

## Tech Stack

- **Runtime:** Node.js 20 (main bot) + Python 3.12 (voice service)
- **Discord:** discord.js v14, @discordjs/voice, @discordjs/opus
- **Image Processing:** sharp (perceptual hashing + blurring)
- **Voice/Speech:** Vosk (offline speech-to-text, Python)
- **HTTP:** axios

## Project Layout

- `index.js` — Main bot entry point
- `services/voice_service.py` — Internal Python HTTP server for speech-to-text
- `cpp/image_similarity.cpp` — Optional C++ image similarity helper (requires OpenCV)
- `words/restrictedword.txt` — Restricted words list
- `sound/connected.mp3` — Audio played on voice channel connect
- `config.json` — Bot configuration (token, ports, thresholds)
- `models/vosk-model-small-en-us-0.15/` — Vosk model directory (must be downloaded separately)

## Configuration

- `DISCORD_TOKEN` secret — Discord bot token (set in Replit Secrets)
- `config.json` — All other settings (voice service port, image folder, mute durations, etc.)

## Running

The bot runs via the "Start application" workflow (`npm start`).

### Voice Service (optional)

The voice transcription feature requires the Vosk model. Download it and place it at:
```
models/vosk-model-small-en-us-0.15/
```
Download from: https://alphacephei.com/vosk/models

Set `startPythonVoiceService: false` in `config.json` to disable the voice service.

## Features

1. **Link Filtering** — Detects and deletes URLs in messages
2. **Image Moderation** — Perceptual hash comparison against restricted images folder; blurs images in link messages
3. **Voice Monitoring** — Joins voice channels, transcribes audio via Vosk, mutes/timeouts members who use restricted words
