// The Notivelo core as an Android library: `gradle assembleRelease` makes build/outputs/aar/NotiveloCore-release.aar.
// An app can also include this folder as a module (settings.gradle.kts: include(":NotiveloCore"); project(":NotiveloCore").projectDir = ...).
// The app's repositories need Google, Maven Central and the platform-verifier repository (see settings.gradle.kts here).
plugins {
    id("com.android.library") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

android {
    namespace = "com.notivelo.core"
    compileSdk = 34
    defaultConfig {
        // 24 (Android 7.0): the NDK build's API level, and what the verifier's revocation checks need.
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // uniffi's Kotlin calls the library through JNA; the AAR carries JNA's own native stubs.
    api("net.java.dev.jna:jna:5.17.0@aar")
    // The generated bindings use @RequiresApi.
    implementation("androidx.annotation:annotation:1.9.1")
    // Must be the version of the rustls-platform-verifier-android crate in Cargo.lock (build-android.sh writes it).
    api("org.rustls:rustls-platform-verifier:${providers.gradleProperty("rustlsPlatformVerifierVersion").get()}")
}
