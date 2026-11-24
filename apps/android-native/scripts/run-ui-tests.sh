#!/usr/bin/env bash
# Runs the emulator UI tests (app/src/androidTest) on the booted emulator, then collects what helps to read a failure:
# failure screenshots (/sdcard/Download/nv-shots), logcat. Called from .github/workflows/android-native.yml by the
# emulator runner, from apps/android-native (the core module must be built first).
set -u
cd "$(dirname "$0")/.."
OUT="${UI_TEST_OUT:-ui-test-out}"
mkdir -p "$OUT"
VER=$(sed -n 's/^rustlsPlatformVerifierVersion=//p' ../../target/android/NotiveloCore/gradle.properties)
# A slow software-rendered emulator can raise 'System UI isn't responding' over the app: hide such dialogs.
adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put secure anr_show_background 0 || true
adb logcat -c || true
adb shell mkdir -p /sdcard/Download/nv-shots || true
./gradlew --no-daemon --console=plain -PrustlsPlatformVerifierVersion="$VER" connectedDebugAndroidTest
status=$?
adb pull /sdcard/Download/nv-shots "$OUT/screenshots" || true
adb logcat -d > "$OUT/logcat.txt" || true
exit $status
