// swift-tools-version:5.9
// The Notivelo core for Swift apps. Assembled by crates/nv-core/build-xcframework.sh into
// target/apple/NotiveloCore/; this file is copied there as is.
import PackageDescription

let package = Package(
    name: "NotiveloCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "NotiveloCore", targets: ["NotiveloCore"])],
    targets: [
        .binaryTarget(name: "nv_coreFFI", path: "nv_coreFFI.xcframework"),
        // Security: the core checks TLS certificates with the system's verifier (rustls-platform-verifier).
        .target(name: "NotiveloCore", dependencies: ["nv_coreFFI"], path: "Sources/NotiveloCore",
                linkerSettings: [.linkedFramework("Security"), .linkedFramework("CoreFoundation")]),
        .testTarget(name: "NotiveloCoreTests", dependencies: ["NotiveloCore"], path: "Tests/NotiveloCoreTests"),
    ]
)
