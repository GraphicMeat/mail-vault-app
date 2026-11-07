import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mailvault.mvnative"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

// As the Tauri Android library itself (tauri crate, mobile/android/build.gradle.kts).
kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    // `ActivityResult` for the picker callback; the version tauri-android itself uses.
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
}
