import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

// versionName and the build 0 versionCode come from scripts/bump-version.sh. MV_BUILD (0..99) is
// added so a rejected upload can be sent again under a higher code. Tauri's own tauri.properties
// is not used: it derives a different, non-monotonic code.
val mvVersion = Properties().apply {
    file("../../../version.properties").inputStream().use { load(it) }
}
val mvBuild = (System.getenv("MV_BUILD") ?: "0").toIntOrNull()?.takeIf { it in 0..99 }
    ?: throw GradleException("MV_BUILD must be an integer from 0 to 99")

// Release signing is read from the environment only. All four set: signed. Any missing: unsigned.
val mvSigning = listOf(
    "MV_ANDROID_KEYSTORE", "MV_ANDROID_KEYSTORE_PASSWORD", "MV_ANDROID_KEY_ALIAS", "MV_ANDROID_KEY_PASSWORD",
).associateWith { System.getenv(it) }
val mvSigned = mvSigning.values.all { !it.isNullOrEmpty() }

android {
    compileSdk = 36
    namespace = "com.mailvault.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.mailvault.app"
        minSdk = 26
        targetSdk = 36
        versionCode = mvVersion.getProperty("versionCode").toInt() + mvBuild
        versionName = mvVersion.getProperty("versionName")
    }
    signingConfigs {
        if (mvSigned) {
            create("release") {
                storeFile = file(mvSigning.getValue("MV_ANDROID_KEYSTORE")!!)
                storePassword = mvSigning.getValue("MV_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = mvSigning.getValue("MV_ANDROID_KEY_ALIAS")
                keyPassword = mvSigning.getValue("MV_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (mvSigned) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn("MailVault: MV_ANDROID_KEYSTORE* not all set, the release build is UNSIGNED and cannot be uploaded")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// rustls-platform-verifier (core's TLS on Android) calls a small Kotlin component through JNI. It
// ships inside the crate as a local Maven repo; `cargo metadata` says where the crate is.
fun rustlsPlatformVerifierMaven(): File {
    val metadata = providers.exec {
        workingDir = File(rootDir, "../..")
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--filter-platform", "aarch64-linux-android", "--manifest-path", "Cargo.toml",
        )
    }.standardOutput.asText.get()
    @Suppress("UNCHECKED_CAST")
    val packages = (JsonSlurper().parseText(metadata) as Map<String, Any>)["packages"] as List<Map<String, Any>>
    val manifest = packages.first { it["name"] == "rustls-platform-verifier-android" }["manifest_path"] as String
    return File(File(manifest).parentFile, "maven")
}

repositories {
    maven {
        url = uri(rustlsPlatformVerifierMaven())
        metadataSources.artifact()
    }
}

dependencies {
    // Kept in step with the Rust crate by cargo, so always the version the local repo holds.
    implementation("rustls:rustls-platform-verifier:latest.release")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")