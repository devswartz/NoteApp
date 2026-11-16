// swift-tools-version: 5.9
import PackageDescription

// The iPad's native pen layer (docs/PLAN_INK.md, phase I2) and the ink engine it draws with.
// NvInkFFI.xcframework is the Rust engine (crates/nv-ink, `ffi` feature) built by
// scripts/build-ink-ios.sh; it isn't committed, so run that script (macOS) before building the app.
// Tests: `swift test` here on a Mac (the framework has a macOS slice for them).
let package = Package(
    name: "NvInk",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "NvInk", targets: ["NvInk"]),
    ],
    targets: [
        .binaryTarget(name: "NvInkFFI", path: "NvInkFFI.xcframework"),
        .target(name: "NvInk", dependencies: ["NvInkFFI"]),
        .testTarget(name: "NvInkTests", dependencies: ["NvInk"]),
    ],
    swiftLanguageVersions: [.v5]
)
