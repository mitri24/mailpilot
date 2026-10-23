// swift-tools-version:6.1
import PackageDescription

let package = Package(
    name: "MailPilotKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        // Modelle, API-Client, Sync, Cache, Outbox, Widget-Snapshot, Heute-Ranking
        .library(name: "MailPilotKit", targets: ["MailPilotKit"]),
        // Gemeinsame SwiftUI-Views für iOS und macOS
        .library(name: "MailPilotUI", targets: ["MailPilotUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1"),
    ],
    targets: [
        .target(
            name: "MailPilotKit",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")]
        ),
        .target(
            name: "MailPilotUI",
            dependencies: ["MailPilotKit"]
        ),
        .testTarget(
            name: "MailPilotKitTests",
            dependencies: ["MailPilotKit"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
