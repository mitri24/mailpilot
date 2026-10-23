# ADR 0002: swift-testing statt XCTest für die Apple-Clients

Status: angenommen (2026-10-23)

## Problem

Der Auftrag nennt XCTest für Client- und Synchronisierungstests. Auf dem Entwicklungsrechner gibt es nur die Command Line Tools (Swift 6.3.2), kein Xcode. Dort liegt nur `Testing.framework`, kein `XCTest.framework`; ein Testtarget mit `import XCTest` bricht mit `error: no such module 'XCTest'` ab (am 2026-10-23 geprüft). Die Tests des gemeinsamen Packages `MailPilotKit` müssen aber hier laufen, damit Outbox, Synchronisierung und Heute-Ranking nachweisbar geprüft sind.

## Entscheidung

Die Tests in `apps/apple/MailPilotKit/Tests` verwenden swift-testing (`import Testing`, `@Test`, `#expect`). Mit den Command Line Tools laufen sie über

```sh
FW=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
LIB=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
swift test -Xswiftc -F -Xswiftc $FW -Xlinker -F -Xlinker $FW -Xlinker -rpath -Xlinker $FW -Xlinker -rpath -Xlinker $LIB
```

## Folgen

- Die Tests laufen ohne Xcode auf jedem Mac mit Command Line Tools; mit Xcode genügen `swift test` oder ⌘U, dort laufen swift-testing-Tests ebenfalls.
- Keine XCTest-Hilfen wie `XCTestExpectation` oder UI-Tests; asynchroner Code wird mit `async`-Tests geprüft, Netzwerk über Mock-Transport und Mock-`URLProtocol`.
- UI-Tests der Apps (XCUITest) würden Xcode voraussetzen und sind nicht Teil dieser Entscheidung.
