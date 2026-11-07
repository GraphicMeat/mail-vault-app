# The Tauri Android library keeps @TauriPlugin classes and their @Command methods.
# WorkManager creates the worker by name, and the shell's JNI functions are found by class and
# method name (src-tauri-mobile/src/android.rs).
-keep class com.mailvault.mvnative.BackgroundFetchWorker { *; }
-keep class com.mailvault.mvnative.Notifier { *; }
-keepclasseswithmembernames class * { native <methods>; }
