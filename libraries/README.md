# Chip PlatformIO library cache

Third-party Arduino/PlatformIO libraries requested via `compile_firmware` (`libraries` / `libDeps`) are installed here by PlatformIO and reused across builds.

**Runtime location (actual cache):**
- Local default: `~/.chip-build-cache/libraries`
- Production Docker: `$CHIP_BUILD_CACHE_DIR/libraries` (default `/var/cache/chip-build/libraries`)

Mount a persistent volume on `CHIP_BUILD_CACHE_DIR` in production so library downloads survive restarts.

This folder in the repo is a placeholder / documentation stub only. PlatformIO writes downloads under the home-directory cache so installs survive project cleans and are shared across board project dirs (`esp32dev`, `esp32s3`, etc.).

## Usage

```json
POST /api/compile
{
  "source": "...",
  "board": "esp32",
  "libraries": [
    "adafruit/Adafruit GFX Library",
    "adafruit/Adafruit SSD1306"
  ]
}
```

Names resolve from the [PlatformIO Registry](https://registry.platformio.org). Version pins like `bblanchon/ArduinoJson@^7.0.0` are supported.

Omitting `libraries` keeps the previous core-only compile path (no `lib_deps`, no library download overhead).
