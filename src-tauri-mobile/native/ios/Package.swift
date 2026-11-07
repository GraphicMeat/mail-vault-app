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
    .target(
      name: "tauri-plugin-mv-native",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
