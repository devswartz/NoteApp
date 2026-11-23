// The native Android app (docs/rewrite/PLAN.md). The Rust core is built first, by crates/nv-core/build-android.sh,
// which writes the Gradle library module target/android/NotiveloCore (jniLibs + the generated Kotlin bindings).
// It is included here as a module; nothing generated is committed.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
        // The certificate verifier's Kotlin component (rustls-platform-verifier), which the core module depends on.
        maven { url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/") }
    }
}
rootProject.name = "NotiveloNative"
include(":app")

val coreModule = file("../../target/android/NotiveloCore")
require(coreModule.resolve("build.gradle.kts").exists()) {
    "The core module is missing: run `bash crates/nv-core/build-android.sh` from the repository root first (needs the NDK and cargo-ndk)."
}
include(":NotiveloCore")
project(":NotiveloCore").projectDir = coreModule
