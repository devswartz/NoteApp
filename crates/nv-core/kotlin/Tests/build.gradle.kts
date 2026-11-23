// The Kotlin bindings on a plain JVM, against the core built for the host (crates/nv-core/test-kotlin-jvm.sh).
plugins {
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
}

// The generated bindings (nv_core.kt) and the folder with libnv_core.so, both from the script.
val generated = providers.gradleProperty("nvGenerated")
val libDir = providers.gradleProperty("nvLibDir")
val corpusDir = providers.gradleProperty("nvCorpusDir")

kotlin { jvmToolchain(17) }

sourceSets {
    test { kotlin.srcDir(generated) }
}

dependencies {
    testImplementation("net.java.dev.jna:jna:5.17.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.11.4")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("jna.library.path", libDir.get())
    environment("NV_CORPUS_DIR", corpusDir.get())
    testLogging { events("passed", "failed"); showStandardStreams = true }
}
