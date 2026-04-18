import io
import json
import os
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from vosk import Model, KaldiRecognizer
except ImportError:
    raise SystemExit("Please install vosk first: python -m pip install vosk")

PORT = int(os.environ.get("VOICE_SERVICE_PORT", "5000"))
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "models", "vosk-model-small-en-us-0.15")

class TranscriptionHandler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path != "/transcribe":
            self._send_json({"error": "Not found"}, status=404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length)

        try:
            waveform = wave.open(io.BytesIO(raw_body), "rb")
        except wave.Error as ex:
            self._send_json({"error": f"Invalid WAV file: {ex}"}, status=400)
            return

        if waveform.getnchannels() != 1 or waveform.getsampwidth() != 2 or waveform.getframerate() != 16000:
            self._send_json({"error": "WAV must be 16-bit mono PCM at 16000Hz."}, status=400)
            return

        recognizer = KaldiRecognizer(self.server.model, 16000)
        data = waveform.readframes(waveform.getnframes())
        recognizer.AcceptWaveform(data)
        result = recognizer.FinalResult()
        transcript = json.loads(result).get("text", "")

        self._send_json({"transcript": transcript})

    def log_message(self, format, *args):
        return


def run_server():
    if not os.path.isdir(MODEL_DIR):
        raise SystemExit(f"Vosk model not found in {MODEL_DIR}. Download a model and place it there.")

    print(f"Loading Vosk model from {MODEL_DIR}...")
    model = Model(MODEL_DIR)
    server = HTTPServer(("127.0.0.1", PORT), TranscriptionHandler)
    server.model = model
    print(f"Voice transcription service listening on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Voice service stopped.")

if __name__ == "__main__":
    run_server()
