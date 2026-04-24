#!/usr/bin/env python3
"""
TraderBOT Discord Moderation – One-Shot Installer
==================================================
This script installs every dependency the bot needs and verifies the
project is ready to run with `npm start`.

It will:
  1. Verify Python 3.8+ and Node.js / npm are installed.
  2. Upgrade pip and install Python packages from requirements.txt
     (currently: vosk, used by services/voice_service.py).
  3. Run `npm install` to fetch all Node.js dependencies declared in
     package.json (discord.js, sharp, tesseract.js, etc.).
  4. Create the folders the bot expects (restricted_images/, words/,
     assets/, models/, sound/).
  5. Download the Vosk small English speech model (~40 MB) into
     models/vosk-model-small-en-us-0.15 if it is missing.
  6. Download the Tesseract English traineddata file (eng.traineddata)
     into the project root if it is missing.
  7. Print a summary report.

Run it with:    python installer.py
or on Linux:    python3 installer.py
"""

import os
import sys
import shutil
import subprocess
import zipfile
import urllib.request
import platform
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REQUIREMENTS = ROOT / "requirements.txt"
PACKAGE_JSON = ROOT / "package.json"

VOSK_MODEL_NAME = "vosk-model-small-en-us-0.15"
VOSK_MODEL_URL = f"https://alphacephei.com/vosk/models/{VOSK_MODEL_NAME}.zip"
VOSK_MODEL_DIR = ROOT / "models" / VOSK_MODEL_NAME

TESSERACT_FILE = ROOT / "eng.traineddata"
TESSERACT_URL = (
    "https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata"
)

REQUIRED_FOLDERS = [
    ROOT / "restricted_images",
    ROOT / "words",
    ROOT / "assets",
    ROOT / "models",
    ROOT / "sound",
]


# ---------- pretty printing ----------
def _color(code):
    return f"\033[{code}m" if sys.stdout.isatty() else ""

C_RESET = _color("0")
C_BOLD = _color("1")
C_GREEN = _color("32")
C_YELLOW = _color("33")
C_RED = _color("31")
C_BLUE = _color("36")


def step(msg):
    print(f"\n{C_BOLD}{C_BLUE}==> {msg}{C_RESET}")


def ok(msg):
    print(f"  {C_GREEN}OK{C_RESET}    {msg}")


def warn(msg):
    print(f"  {C_YELLOW}WARN{C_RESET}  {msg}")


def err(msg):
    print(f"  {C_RED}ERR{C_RESET}   {msg}")


# ---------- helpers ----------
def run(cmd, cwd=None):
    """Run a subprocess and stream its output."""
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=cwd or ROOT, check=False)


def have(executable):
    return shutil.which(executable) is not None


def download(url, dest_path):
    print(f"  Downloading {url}")
    print(f"             -> {dest_path}")
    last_pct = [-1]

    def _hook(blocknum, blocksize, totalsize):
        if totalsize <= 0:
            return
        pct = int(blocknum * blocksize * 100 / totalsize)
        if pct != last_pct[0] and pct % 5 == 0:
            sys.stdout.write(f"\r  Progress: {pct}%   ")
            sys.stdout.flush()
            last_pct[0] = pct

    urllib.request.urlretrieve(url, dest_path, _hook)
    print()  # newline after progress line


# ---------- steps ----------
def step_check_runtimes():
    step("Checking required runtimes")
    issues = 0

    py_ok = sys.version_info >= (3, 8)
    if py_ok:
        ok(f"Python {sys.version.split()[0]}")
    else:
        err(f"Python {sys.version.split()[0]} – need 3.8 or newer.")
        issues += 1

    if have("node"):
        v = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
        ok(f"Node.js {v}")
    else:
        err("Node.js is not installed or not on PATH. Install it from https://nodejs.org/.")
        issues += 1

    if have("npm"):
        v = subprocess.run(["npm", "--version"], capture_output=True, text=True).stdout.strip()
        ok(f"npm {v}")
    else:
        err("npm is not installed or not on PATH.")
        issues += 1

    if not have("python") and not have("python3"):
        warn("Python launcher 'python'/'python3' not found on PATH. The Node bot starts the voice service via 'python', make sure it works in your shell.")

    if issues:
        err("Missing runtimes; install them and re-run installer.py.")
        sys.exit(1)


def step_create_folders():
    step("Creating project folders")
    for folder in REQUIRED_FOLDERS:
        folder.mkdir(parents=True, exist_ok=True)
        ok(f"{folder.relative_to(ROOT)}/")


def step_python_deps():
    step("Installing Python packages (requirements.txt)")
    if not REQUIREMENTS.exists():
        warn("requirements.txt not found, skipping.")
        return
    run([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])
    result = run([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS)])
    if result.returncode == 0:
        ok("Python packages installed.")
    else:
        err("pip install failed. See output above.")
        sys.exit(1)


def step_node_deps():
    step("Installing Node.js packages (npm install)")
    if not PACKAGE_JSON.exists():
        err("package.json not found.")
        sys.exit(1)
    npm_cmd = "npm.cmd" if platform.system() == "Windows" else "npm"
    result = run([npm_cmd, "install"])
    if result.returncode == 0:
        ok("Node packages installed.")
    else:
        err("npm install failed. See output above.")
        sys.exit(1)


def step_vosk_model():
    step("Downloading Vosk speech model (offline voice transcription)")
    if VOSK_MODEL_DIR.exists() and any(VOSK_MODEL_DIR.iterdir()):
        ok(f"Vosk model already present at {VOSK_MODEL_DIR.relative_to(ROOT)}")
        return

    VOSK_MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    zip_path = ROOT / "models" / f"{VOSK_MODEL_NAME}.zip"
    try:
        download(VOSK_MODEL_URL, zip_path)
        print("  Extracting...")
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(ROOT / "models")
        zip_path.unlink(missing_ok=True)
        if VOSK_MODEL_DIR.exists():
            ok("Vosk model installed.")
        else:
            err("Vosk archive extracted but model folder was not found.")
    except Exception as e:
        err(f"Failed to download Vosk model: {e}")
        warn("You can download it manually from " + VOSK_MODEL_URL +
             f" and unzip it into models/{VOSK_MODEL_NAME}/")


def step_tesseract_model():
    step("Downloading Tesseract English language data")
    if TESSERACT_FILE.exists() and TESSERACT_FILE.stat().st_size > 1_000_000:
        ok(f"{TESSERACT_FILE.name} already present.")
        return
    try:
        download(TESSERACT_URL, TESSERACT_FILE)
        ok(f"{TESSERACT_FILE.name} installed.")
    except Exception as e:
        warn(f"Could not download {TESSERACT_FILE.name}: {e}")
        warn("OCR may still work because tesseract.js downloads it on first use, "
             "but having it locally is faster.")


def step_summary():
    step("Installation summary")
    print(f"  Project root: {ROOT}")
    print(f"  Vosk model:    {'present' if VOSK_MODEL_DIR.exists() else 'MISSING'}")
    print(f"  Tesseract:     {'present' if TESSERACT_FILE.exists() else 'MISSING'}")
    print(f"  node_modules:  {'present' if (ROOT / 'node_modules').exists() else 'MISSING'}")
    print()
    print(f"{C_BOLD}{C_GREEN}Setup complete!{C_RESET}")
    print()
    print("Next steps:")
    print(f"  1. Make sure DISCORD_TOKEN is set in your environment, or in config.json.")
    print(f"  2. Start the bot:  {C_BOLD}npm start{C_RESET}")
    print(f"  3. Open the control web page (default port 5050) and choose")
    print(f"     YES or NO to start the voice service.")


def main():
    print(f"{C_BOLD}TraderBOT installer{C_RESET}")
    print(f"Working directory: {ROOT}")
    step_check_runtimes()
    step_create_folders()
    step_python_deps()
    step_node_deps()
    step_vosk_model()
    step_tesseract_model()
    step_summary()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted by user.")
        sys.exit(130)
