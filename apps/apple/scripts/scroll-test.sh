#!/usr/bin/env bash
# Runs the scroll UI test (UITests/ScrollTests.swift) on an iPhone and an iPad simulator; fails if either fails.
#   bash apps/apple/scripts/scroll-test.sh <derived data dir>
set -uo pipefail
DD="$1"
cd "$(dirname "$0")/.."
pick() {
  local json u n rt
  json="$(xcrun simctl list devices available -j)"
  for n in "$@"; do
    u="$(echo "$json" | jq -r --arg n "$n" '[.devices[][] | select(.name == $n)][0].udid // empty')"
    if [ -n "$u" ]; then echo "$u|$n"; return 0; fi
  done
  rt="$(xcrun simctl list runtimes -j | jq -r '[.runtimes[] | select(.platform == "iOS" and .isAvailable)] | last | .identifier')"
  for n in "$@"; do
    if u="$(xcrun simctl create "scroll $n" "$n" "$rt" 2>/dev/null)"; then echo "$u|$n"; return 0; fi
  done
  return 1
}
fail=0
run() {
  local label="$1"; shift
  local dev log
  dev="$(pick "$@")" || { echo "::error::no $label simulator"; fail=1; return; }
  local udid="${dev%%|*}"
  log="$DD-scroll-$label.log"
  echo "== $label: ${dev#*|} ($udid)"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b > /dev/null
  if ! xcodebuild test -project Notivelo.xcodeproj -scheme Notivelo -destination "platform=iOS Simulator,id=$udid" \
        -only-testing:NotiveloUITests/ScrollTests -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO > "$log" 2>&1; then
    echo "::error::the page does not scroll on the $label (or the test could not run)"
    grep -E "error:|XCTAssert|failed|Test Case" "$log" | sort -u | head -n 30
    tail -n 25 "$log"
    fail=1
  else
    grep -E "Test Case.*(passed|failed)" "$log" | head
    echo "scroll ok on the $label"
  fi
  xcrun simctl shutdown "$udid" || true
}
run iphone "iPhone 16e" "iPhone 14" "iPhone 13" "iPhone 12"
run ipad "iPad Air 11-inch (M3)" "iPad Air 11-inch (M2)" "iPad (A16)" "iPad (10th generation)" "iPad Air (5th generation)"
exit $fail
