#!/usr/bin/env bash
# Source this (do not execute) before cross-compiling for Android:
#   source scripts/mobile-env.sh
# Derives the Android SDK/NDK/JDK paths from the environment, falling back to the Homebrew
# locations on the Mac mini. Targets NDK API level 26.

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"

_mv_ndk_api=26

if [ -z "${NDK_HOME:-}" ]; then
    # Newest installed NDK (version dirs sort lexically; the NDK uses fixed-width majors).
    NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/*/ 2>/dev/null | sort | tail -n 1)"
    NDK_HOME="${NDK_HOME%/}"
fi
export NDK_HOME

case "$(uname -s)-$(uname -m)" in
    Darwin-*) _mv_host_tag=darwin-x86_64 ;; # the NDK ships one universal darwin toolchain
    Linux-*) _mv_host_tag=linux-x86_64 ;;
    *) _mv_host_tag=windows-x86_64 ;;
esac

_mv_bin="$NDK_HOME/toolchains/llvm/prebuilt/$_mv_host_tag/bin"
export CC_aarch64_linux_android="$_mv_bin/aarch64-linux-android${_mv_ndk_api}-clang"
export AR_aarch64_linux_android="$_mv_bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"

unset _mv_ndk_api _mv_host_tag _mv_bin
