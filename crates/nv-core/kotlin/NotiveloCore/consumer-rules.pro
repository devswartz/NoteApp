# Kept in the app's shrinker run (R8/ProGuard): JNA and uniffi find their classes by reflection and from native code.
-dontwarn java.awt.*
-keep class com.sun.jna.* { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }
-keep class com.notivelo.core.** { *; }
# The certificate verifier's Kotlin component, called from Rust through JNI.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
