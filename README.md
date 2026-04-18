# TraderBOT Discord Moderation

Local Discord moderation bot with image analysis, link filtering, and offline voice monitoring.

## Features

- Deletes messages containing links.
- Compares images against a local restricted image folder and removes matches.
- If an image contains a link and is not restricted, it blurs the image and reposts the blurred version.
- Joins voice/stage channels when users connect and listens for restricted speech.
- Mutes users for 30 seconds for first/second offenses.
- Times out users for 60 seconds on the third offense.
- Uses a local Python voice transcription service with Vosk for offline speech recognition.

## Setup

1. Copy `config.example.json` to `config.json` and set your bot token.
2. Install Node dependencies:
   ```bash
   npm install
   ```
3. Install Python dependencies:
   ```bash
   python -m pip install vosk
   ```
4. Download a Vosk model locally and put it in `models/`.
   Example model folder: `models/vosk-model-small-en-us-0.15`
5. Add restricted words to `words/restrictedword.txt`.
6. Place restricted images in `restricted_images/`.

## Running

Start the bot:
```bash
npm start
```

If the voice service is enabled in `config.json`, the bot will attempt to start the local Python transcription service automatically.

## Optional C++ helper

There is a sample C++ image similarity helper in `cpp/image_similarity.cpp` for offline image comparison using OpenCV.

Compile with:
```bash
g++ -std=c++17 cpp/image_similarity.cpp -o cpp/image_similarity `pkg-config --cflags --libs opencv4`
```

Then run:
```bash
./cpp/image_similarity restricted.png test.png
```
