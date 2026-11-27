#!/usr/bin/env bash
# electron-builder notarises the app before it builds the dmg, so the dmg people download has
# no ticket of its own and Gatekeeper refuses it offline. Sign, notarise and staple the dmg too.
set -euo pipefail
cd "$(dirname "$0")/.."
DMG="${1:-$(ls -t release/*.dmg | head -1)}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application}"
: "${APPLE_API_KEY:?set APPLE_API_KEY to the .p8 path}"
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"

codesign --sign "$IDENTITY" --timestamp --force "$DMG"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG"
