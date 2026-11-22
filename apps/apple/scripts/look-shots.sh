#!/usr/bin/env bash
# Screenshots of the native app in the states of docs/rewrite/look/reference/ (corpus mode, no network),
# then side-by-side pictures (reference | native) by docs/rewrite/look/side-by-side.py.
#   bash apps/apple/scripts/look-shots.sh <Notivelo.app> <out dir>
# Writes <out>/native/<viewport>/<state>.png and <out>/side-by-side/<viewport>/<state>.png.
# Viewports: ipad-landscape and ipad-portrait on an iPad whose portrait is 820×1180 pt (landscape is drawn
# by the app turned a quarter, -lookLandscape YES, and the shot turned back with sips), iphone on a 390×844 pt iPhone.
set -uo pipefail
APP="$1"
OUT="$2"
BUNDLE=com.devswartz.notivelo
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$OUT/native"

# A device by the first name available (creating it from the device type if needed): prints "udid|name".
pick() {
  local json u n rt
  json="$(xcrun simctl list devices available -j)"
  for n in "$@"; do
    u="$(echo "$json" | jq -r --arg n "$n" '[.devices[][] | select(.name == $n)][0].udid // empty')"
    if [ -n "$u" ]; then echo "$u|$n"; return 0; fi
  done
  rt="$(xcrun simctl list runtimes -j | jq -r '[.runtimes[] | select(.platform == "iOS" and .isAvailable)] | last | .identifier')"
  for n in "$@"; do
    if u="$(xcrun simctl create "look $n" "$n" "$rt" 2>/dev/null)"; then echo "$u|$n"; return 0; fi
  done
  return 1
}

boot() {
  local udid="$1"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b > /dev/null
  xcrun simctl ui "$udid" appearance light
  xcrun simctl install "$udid" "$APP"
  # Warm-up launch (the first launch after install is slow).
  xcrun simctl launch "$udid" "$BUNDLE" -previewSignedIn YES -lookState page-canvas-boxes > /dev/null 2>&1 && sleep 6
  xcrun simctl terminate "$udid" "$BUNDLE" > /dev/null 2>&1 || true
}

# shoot <udid> <viewport> <landscape 0|1> <theme> <state> [signed-out]
shoot() {
  local udid="$1" vp="$2" land="$3" theme="$4" state="$5" signedout="${6:-}"
  local name="$state" args=(-lookState "$state" -theme "$theme") wait=5
  [ "$theme" != light ] && name="$theme-$state"
  [ -z "$signedout" ] && args+=(-previewSignedIn YES)
  [ "$land" = 1 ] && args+=(-lookLandscape YES)
  case "$state" in edit-*|menu-*|ribbon-menu-*|slash-menu) wait=7 ;; esac
  mkdir -p "$OUT/native/$vp"
  xcrun simctl terminate "$udid" "$BUNDLE" > /dev/null 2>&1 || true
  if ! xcrun simctl launch "$udid" "$BUNDLE" "${args[@]}" > /dev/null; then
    echo "::warning::launch failed: $vp/$name"; return 0
  fi
  sleep "$wait"
  xcrun simctl io "$udid" screenshot "$OUT/native/$vp/$name.png" > /dev/null 2>&1 || { echo "::warning::screenshot failed: $vp/$name"; return 0; }
  [ "$land" = 1 ] && sips -r 270 "$OUT/native/$vp/$name.png" > /dev/null
  echo "shot $vp/$name"
}

defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool true || true

# iPad: 820×1180 pt portrait (iPad Air 11-inch / iPad 10th generation), as the references.
if IPAD="$(pick "iPad Air 11-inch (M3)" "iPad Air 11-inch (M2)" "iPad (A16)" "iPad (10th generation)" "iPad Air (5th generation)")"; then
  UDID="${IPAD%%|*}"
  echo "iPad: ${IPAD#*|} ($UDID)"
  boot "$UDID"
  L=ipad-landscape
  shoot "$UDID" $L 1 light sign-in signed-out
  shoot "$UDID" $L 1 hybrid sign-in signed-out
  shoot "$UDID" $L 1 dark sign-in signed-out
  for theme in hybrid light dark; do
    shoot "$UDID" $L 1 $theme page-canvas-boxes
    shoot "$UDID" $L 1 $theme edit-caret
    shoot "$UDID" $L 1 $theme tasks-today
    shoot "$UDID" $L 1 $theme menu-account
    shoot "$UDID" $L 1 $theme page-settings-and-ink
  done
  for state in page-blocks page-lists page-tasks empty-no-page empty-section empty-tasks-today tasks-my \
               slash-menu menu-page-options menu-section menu-notebook ribbon-menu-block ribbon-menu-text-colour ribbon-collapsed; do
    shoot "$UDID" $L 1 light "$state"
  done
  P=ipad-portrait
  shoot "$UDID" $P 0 light sign-in signed-out
  for state in page-canvas-boxes page-blocks page-lists page-tasks edit-caret tasks-today menu-account empty-no-page; do
    shoot "$UDID" $P 0 light "$state"
  done
  xcrun simctl shutdown "$UDID" || true
else
  echo "::warning::no 820×1180 iPad simulator"
fi

# iPhone: 390×844 pt (iPhone 16e / 14 / 13), as the references.
if PHONE="$(pick "iPhone 16e" "iPhone 14" "iPhone 13" "iPhone 12")"; then
  UDID="${PHONE%%|*}"
  echo "iPhone: ${PHONE#*|} ($UDID)"
  boot "$UDID"
  V=iphone
  shoot "$UDID" $V 0 light sign-in signed-out
  shoot "$UDID" $V 0 hybrid sign-in signed-out
  for state in page-canvas-boxes tasks-today; do
    shoot "$UDID" $V 0 light "$state"
    shoot "$UDID" $V 0 hybrid "$state"
  done
  xcrun simctl shutdown "$UDID" || true
else
  echo "::warning::no 390×844 iPhone simulator"
fi

python3 -m venv "$RUNNER_TEMP/look-venv" && "$RUNNER_TEMP/look-venv/bin/pip" install -q pillow \
  && "$RUNNER_TEMP/look-venv/bin/python" "$ROOT/docs/rewrite/look/side-by-side.py" "$ROOT/docs/rewrite/look/reference" "$OUT/native" "$OUT/side-by-side"
