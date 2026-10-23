import Foundation
import Testing
@testable import MailPilotKit

/// Die erwarteten Bodies sind mit den Zod-Eingabeschemas geprüft (apps/apple/Tools/contract-fixtures.ts).
@Suite("Request-Bodies entsprechen dem Vertrag")
struct RequestEncodingTests {
    let task1 = UUID(uuidString: "33333333-3333-4333-8333-333333333331")!
    let task2 = UUID(uuidString: "33333333-3333-4333-8333-333333333332")!
    let note1 = UUID(uuidString: "44444444-4444-4444-8444-444444444441")!
    let note2 = UUID(uuidString: "44444444-4444-4444-8444-444444444442")!
    let item1 = UUID(uuidString: "55555555-5555-4555-8555-555555555551")!
    let item2 = UUID(uuidString: "55555555-5555-4555-8555-555555555552")!
    let clar1 = UUID(uuidString: "66666666-6666-4666-8666-666666666661")!

    func key(_ n: Int) -> UUID {
        UUID(uuidString: n < 10 ? "dddddddd-dddd-4ddd-8ddd-ddddddddddd\(n)" : "dddddddd-dddd-4ddd-8ddd-dddddddddd\(n)")!
    }

    @Test("Alle Mutationstypen exakt wie MutationBatch")
    func mutations() throws {
        let mutations: [Mutation] = [
            Mutation(idempotencyKey: key(1), clientTimestamp: date("2026-10-23T08:00:00Z"), entityId: task2,
                     kind: .taskCreate(title: "Formular abgeben", nextStep: "Unterschreiben und einscannen", priority: .important, deadline: .onDate(day("2026-10-30")))),
            Mutation(idempotencyKey: key(2), entityId: task1, baseVersion: 4, kind: .taskUpdate(TaskPatch(
                status: .doing, waiting: true, waitingCheckAt: .set(day("2026-10-28")), snoozedUntil: .set(date("2026-10-24T06:00:00Z")),
                plannedFor: .clear, sortKey: .set(2.5), title: .clear, priority: .clear, deadline: .set(.at(date("2026-10-30T11:00:00Z"))),
                estimatedMinutes: .clear))),
            Mutation(idempotencyKey: key(3), entityId: task1, baseVersion: 5, kind: .taskUpdate(TaskPatch(deadlineCleared: true))),
            Mutation(idempotencyKey: key(4), entityId: task1, baseVersion: 5, kind: .taskDismiss),
            Mutation(idempotencyKey: key(5), entityId: task1, baseVersion: 6, kind: .taskRestore),
            Mutation(idempotencyKey: key(6), clientTimestamp: date("2026-10-23T08:01:00Z"), entityId: note1, kind: .noteCreate(taskId: task1, body: "Unterlagen liegen im Ordner „Uni“.")),
            Mutation(idempotencyKey: key(7), entityId: note1, baseVersion: 2, kind: .noteUpdate(body: "Unterlagen liegen im Ordner „Uni/2026“.")),
            Mutation(idempotencyKey: key(8), entityId: note2, baseVersion: 3, kind: .noteDelete),
            Mutation(idempotencyKey: key(9), entityId: item1, kind: .checklistCreate(taskId: task1, title: "PDF herunterladen", position: 3)),
            Mutation(idempotencyKey: key(10), entityId: item1, baseVersion: 1, kind: .checklistUpdate(title: nil, done: true, position: nil)),
            Mutation(idempotencyKey: key(11), entityId: item2, baseVersion: 2, kind: .checklistDelete),
            Mutation(idempotencyKey: key(12), entityId: clar1, kind: .clarificationAnswer(optionId: "yes", text: nil, scope: .permanent)),
            Mutation(idempotencyKey: key(13), entityId: clar1, kind: .clarificationAnswer(optionId: nil, text: "Nur für Gruppe B2", scope: .once)),
        ]
        guard case .object(let expected) = try Fixture.json("mutations-expected"), case .array(let expectedMutations)? = expected["mutations"] else {
            Issue.record("mutations-expected.json unlesbar")
            return
        }
        #expect(expectedMutations.count == mutations.count)
        for (mutation, expectedJSON) in zip(mutations, expectedMutations) {
            #expect(try encodeJSON(mutation) == expectedJSON, "\(mutation.type)")
            // Rückweg: dieselben Werte nach dem Speichern in der Outbox.
            #expect(try APIJSON.decode(Mutation.self, from: APIJSON.encode(mutation)) == mutation)
        }
        // Der Batch-Body wird aus den gespeicherten Bytes zusammengesetzt.
        let endpoint = API.mutations(raw: try mutations.map { try APIJSON.encode($0) })
        guard case .raw(let body)? = endpoint.body else {
            Issue.record("Batch-Body fehlt")
            return
        }
        #expect(try JSONDecoder().decode(JSONValue.self, from: body) == .object(expected))
    }

    @Test("Übrige Request-Bodies")
    func requestBodies() throws {
        guard case .array(let entries) = try Fixture.json("request-bodies") else {
            Issue.record("request-bodies.json unlesbar")
            return
        }
        var expected: [String: JSONValue] = [:]
        for entry in entries {
            if case .object(let object) = entry, case .string(let name)? = object["name"], let value = object["value"] { expected[name] = value }
        }
        let folder = UUID(uuidString: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc1")!
        let actual: [String: any Encodable] = [
            "taskCreate": TaskCreate(id: task2, title: "Fahrradschloss kaufen", priority: .canWait, deadline: .onDate(day("2026-10-30")), note: "Im Laden am Bahnhof"),
            "accountPatchMarker": AccountPatch(marker: MarkerConfig(strategy: .imapFlagged, acknowledgedLimitations: true)),
            "accountPatchPause": AccountPatch(status: .paused, aliases: ["student@univ.example"], initialImportDays: 30, includeSent: false),
            "correctionNotATask": Correction.notATask,
            "correctionPriority": Correction.wrongPriority(.canWait),
            "correctionDeadlineNone": Correction.wrongDeadline(nil),
            "correctionBelongsTo": Correction.belongsTo(taskId: task1),
            "clarificationAnswer": ClarificationAnswer(optionId: "not_this_time", text: nil, scope: .once),
            "settingsPatch": SettingsPatch(scanTime: "06:30", extraScanIntervalMinutes: .clear, notifyUrgentDeadlines: true, quietHoursStart: .set("22:00"), quietHoursEnd: .clear),
            "appleSignIn": AppleSignIn(identityToken: "eyJraWQiOiJleGFtcGxlIiwiYWxnIjoiUlMyNTYifQ.payload.signature", nonce: "raw-nonce-1234567890",
                                       deviceName: "MacBook", platform: .macos, fullName: "Alex Muster"),
            "devSignIn": DevSignIn(email: "dev@example.com", deviceName: "iPhone", platform: .ios),
            "pushRegistration": PushRegistration(token: "a1b2c3d4e5f60718", environment: .sandbox, platform: .ios),
            "imapCreate": ImapAccountCreate(displayName: "Hochschule", emailAddress: "student@univ.example", host: "imap.univ.example", username: "student",
                                            password: "app-spezifisches-passwort"),
            "messageToTask": MessageToTask(title: "Formular abgeben"),
            "messageLink": MessageToTask(linkToTaskId: task1),
            "rulePatch": RulePatch(applies: false, note: .clear),
            "folderSelection": FolderSelection(selectedFolderIds: [folder]),
            "scanRequestAll": ScanRequest(),
        ]
        #expect(Set(actual.keys) == Set(expected.keys))
        for (name, value) in actual {
            #expect(try normalizedUUIDs(encodeJSON(AnyEncodable(value))) == normalizedUUIDs(expected[name] ?? .null), "\(name)")
        }
    }
}

/// REST-Bodies kodieren UUIDs in Großbuchstaben (Swift-Standard); der Server akzeptiert beides.
func normalizedUUIDs(_ value: JSONValue) -> JSONValue {
    switch value {
    case .string(let s): return UUID(uuidString: s) != nil ? .string(s.lowercased()) : value
    case .array(let values): return .array(values.map(normalizedUUIDs))
    case .object(let values): return .object(values.mapValues(normalizedUUIDs))
    default: return value
    }
}

struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: any Encoder) throws { try value.encode(to: encoder) }
}
