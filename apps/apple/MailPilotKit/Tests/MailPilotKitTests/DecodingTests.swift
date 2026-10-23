import Foundation
import Testing
@testable import MailPilotKit

/// Beispielantworten, mit den Zod-Schemas des Vertrags geprüft (apps/apple/Tools/contract-fixtures.ts).
@Suite("JSON-Decoding gegen Vertragsbeispiele")
struct DecodingTests {
    @Test("TaskDetail mit Quellen, Notizen, Checkliste und Verlauf")
    func taskDetail() throws {
        let detail = try Fixture.decode(TaskDetail.self, "task-detail")
        let task = detail.task
        #expect(task.title == "Studienbescheinigung an Claire schicken")
        #expect(task.status == .doing)
        #expect(task.waiting)
        #expect(task.waitingCheckAt == day("2026-10-30"))
        #expect(task.plannedFor == day("2026-10-26"))
        // Offset +02:00 korrekt in UTC umgerechnet.
        #expect(task.snoozedUntil == date("2026-10-24T06:00:00Z"))
        #expect(task.deadline == Deadline(date: day("2026-11-02"), precision: .date, kind: .explicit, sourceQuote: "jusqu'à lundi 2 novembre"))
        #expect(task.estimateSource == .estimate)
        #expect(task.primarySource?.sentAt == date("2026-10-20T09:15:00Z"))
        #expect(task.updatedAt == date("2026-10-22T16:05:12.345Z"))
        #expect(task.latestChange == "Die Frist wurde von Freitag auf Montag verschoben.")
        #expect(detail.sources.count == 2)
        #expect(detail.sources[0].attachments.first?.filename == "formulaire.pdf")
        #expect(detail.sources[1].attachments.first?.size == nil)
        #expect(detail.sources[1].role == .update)
        #expect(detail.notes[1].conflictOfNoteId == detail.notes[0].id)
        #expect(detail.checklist.map(\.done) == [true, false])
        #expect(detail.events.map(\.kind) == [.createdAuto, .deadlineChanged, .statusChanged, .waitingChanged, .correction])
        #expect(detail.events[1].newValue == .object(["date": .string("2026-11-02"), "dateTime": .null, "precision": .string("date")]))
        #expect(detail.events[3].oldValue == .bool(false))
        #expect(detail.events[4].newValue == .array([.number(2.5), .string("x"), .null]))
        #expect(detail.events[0].oldValue == nil)
    }

    @Test("Vollständiger Stand: alle Entitätstypen")
    func changesSnapshot() throws {
        let response = try Fixture.decode(ChangesResponse.self, "changes-snapshot")
        #expect(response.nextCursor == "1042")
        #expect(!response.hasMore)
        #expect(response.changes.count == 11)
        var kinds: [String] = []
        for change in response.changes {
            #expect(!change.isTombstone)
            switch change.data {
            case .settings(let s?): kinds.append("settings"); #expect(s.quietHoursStart == "22:00"); #expect(s.extraScanIntervalMinutes == nil)
            case .account(let a?):
                kinds.append("account")
                if a.provider == .imap {
                    #expect(a.capabilities?.supportedMarkers.contains(.imapFlagged) == true)
                    #expect(a.marker.keyword == "MailPilot")
                    #expect(a.marker.folder == nil)
                    #expect(!a.markerReliable)
                    #expect(a.lastError?.action == "Passwort prüfen")
                }
            case .task(let t?):
                kinds.append("task")
                if t.origin == .manual {
                    #expect(t.manual.deadline == ManualDeadline(dateTime: date("2026-10-30T17:00:00Z"), precision: .datetime))
                    #expect(t.priorityIsManual)
                }
            case .note: kinds.append("note")
            case .checklistItem: kinds.append("checklist_item")
            case .clarification(let c?): kinds.append("clarification"); #expect(c.options.contains { $0.isDeferral })
            case .rule(let r?): kinds.append("rule"); #expect(r.kind == .membership)
            default: Issue.record("Unerwarteter Eintrag \(change)")
            }
        }
        #expect(Set(kinds) == ["settings", "account", "task", "note", "checklist_item", "clarification", "rule"])
    }

    @Test("Delta mit Tombstones und hasMore")
    func changesDelta() throws {
        let response = try Fixture.decode(ChangesResponse.self, "changes-delta")
        #expect(response.hasMore)
        #expect(response.changes.filter(\.isTombstone).count == 4)
        guard case .clarification(let clarification?) = response.changes.last?.data else {
            Issue.record("Rückfrage fehlt")
            return
        }
        #expect(clarification.answer?.answeredAt == date("2026-10-23T06:11:00Z"))
    }

    @Test("Unbekannter Entitätstyp eines neueren Servers wird übersprungen, nicht als Fehler behandelt")
    func unknownEntityType() throws {
        let json = #"{"changes":[{"seq":"5","entityType":"label","entityId":"00000000-0000-4000-8000-000000000001","op":"upsert","version":1,"data":{"x":1}}],"nextCursor":"5","hasMore":false,"resetRequired":false,"serverTime":"2026-10-23T08:00:00.000Z"}"#
        let response = try APIJSON.decode(ChangesResponse.self, from: Data(json.utf8))
        #expect(response.changes.first?.data == .unknown("label"))
    }

    @Test("Mutationsergebnisse aller Arten")
    func mutationResults() throws {
        let results = try Fixture.decode(MutationBatchResult.self, "mutation-batch-result").results
        #expect(results.map(\.status) == [.applied, .duplicate, .conflict, .conflict, .rejected])
        #expect(results[2].conflictingFields == ["status"])
        #expect(results[3].createdEntityId != nil)
        #expect(results[4].version == nil)
        #expect(results[4].error?.message == "Eintrag nicht gefunden")
        #expect(results[4].entityType == .checklistItem)
    }

    @Test("Weitere Antworten des Vertrags")
    func otherResponses() throws {
        let today = try Fixture.decode(Today.self, "today")
        #expect(today.pendingAnalysisCount == 12)
        #expect(today.lastSuccessfulUpdateAt == date("2026-10-23T05:00:04Z"))
        #expect(today.accountsNeedingAttention.first?.action == "Passwort prüfen")

        let message = try Fixture.decode(MessageDetail.self, "message-detail")
        #expect(message.open.appleMailURL?.scheme == "message")
        #expect(message.open.webLinkURL == nil)
        #expect(message.remoteContentBlocked == 2)
        #expect(message.attachments.first?.inline == false)
        #expect(message.message.language == "fr")

        let list = try Fixture.decode(MessageList.self, "message-list")
        #expect(list.messages[1].analysisStatus == .budgetPaused)
        #expect(list.messages[1].from == nil)

        let session = try Fixture.decode(SessionResponse.self, "session")
        #expect(session.user.devLogin)
        #expect(session.expiresAt == date("2027-01-21T08:00:00Z"))

        #expect(try Fixture.decode(Usage.self, "usage").spentCents == 123.45)
        #expect(try Fixture.decode(UserSettings.self, "settings").timezone == "Europe/Paris")
        let runs = try Fixture.decode(ScanList.self, "scan-list").runs
        #expect(runs.map(\.status) == [.running, .failed])
        #expect(runs[1].accountId == nil)
        let suggestion = try Fixture.decode(SetupSuggestion.self, "setup-suggestion")
        #expect(suggestion.imap?.port == 993)
        #expect(try Fixture.decode(OAuthStart.self, "oauth-start").authorizationURL?.host == "accounts.google.com")
        #expect(try Fixture.decode(AccountCheck.self, "account-check").action == "Konto erneut verbinden")
        #expect(try Fixture.decode(AccountList.self, "accounts").accounts.count == 2)
        #expect(try Fixture.decode(FolderList.self, "folders").folders.map(\.role) == [.inbox, .sent, .spam])
        #expect(try Fixture.decode(RuleList.self, "rules").rules.first?.value.applies == true)
        #expect(try Fixture.decode(ClarificationList.self, "clarifications").clarifications.first?.options.count == 4)
        #expect(try Fixture.decode(TaskMutationResponse.self, "task-mutation-response").task?.version == 8)
        #expect(try Fixture.decode(CorrectionResult.self, "correction-result").mergeId != nil)
        let error = try Fixture.decode(ErrorBody.self, "error")
        #expect(error.error.code == "idempotency_key_reused")
        #expect(error.error.details == .object(["reason": .string("hash")]))
    }

    @Test("Cache-Rundlauf: Kodieren und Dekodieren ändert nichts")
    func roundTrip() throws {
        let detail = try Fixture.decode(TaskDetail.self, "task-detail")
        let again = try APIJSON.decode(TaskDetail.self, from: APIJSON.encode(detail))
        #expect(again == detail)
    }
}
