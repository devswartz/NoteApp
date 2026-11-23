// Plugin versions: the core module (target/android/NotiveloCore/build.gradle.kts, from crates/nv-core/kotlin/) pins
// AGP 8.7.3 and Kotlin 2.0.21; a module in the same build must use the same versions, so these match it.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.paparazzi) apply false
}
