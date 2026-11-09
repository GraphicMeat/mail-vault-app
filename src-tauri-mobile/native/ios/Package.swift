// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-mv-native",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-mv-native",
      type: .static,
      targets: ["tauri-plugin-mv-native"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    // The shell's C exports, declared in C so Swift calls them with the C calling convention.
    .target(
      name: "MvShellC",
      path: "ShellC"),
    .target(
      name: "tauri-plugin-mv-native",
      dependencies: [
        .byName(name: "Tauri"),
        "MvShellC",
      ],
      path: "Sources",
      // App Store subscriptions (Store.swift).
      linkerSettings: [.linkedFramework("StoreKit")])
  ]
)
