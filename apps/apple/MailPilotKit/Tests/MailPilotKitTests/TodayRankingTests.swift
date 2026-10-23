import Foundation
import Testing
@testable import MailPilotKit

/// Fixture aus dem echten Servercode (apps/apple/Tools/today-parity.ts → services/api/src/domain/today.ts).
struct TodayParityFixture: Decodable, Sendable {
    struct Expected: Decodable, Sendable {
        var ranks: [String: Int]
        var dueDates: [String: String?]
        var actionable: [String: Bool]
        var sortedActionableIds: [UUID]
        var nextIds: [UUID]
        var moreUrgentIds: [UUID]
        var waitingCount: Int
        var canWaitCount: Int
    }

    struct Scenario: Decodable, Sendable {
        var name: String
        var now: Date
        var timeZone: String
        var today: String
        var tasks: [TaskItem]
        var expected: Expected
    }

    var source: String
    var scenarios: [Scenario]
}

@Suite("Heute-Ranking: Parität mit services/api/src/domain/today.ts")
struct TodayRankingTests {
    static let fixture: TodayParityFixture = {
        do { return try Fixture.decode(TodayParityFixture.self, "today-parity") } catch { fatalError("today-parity.json: \(error)") }
    }()

    static var scenarioNames: [String] { fixture.scenarios.map(\.name) }

    @Test("Gleiche Ränge, Fälligkeiten, Reihenfolge und Zählungen wie der Server", arguments: scenarioNames)
    func parity(name: String) throws {
        let scenario = try #require(Self.fixture.scenarios.first { $0.name == name })
        let zone = try #require(TimeZone(identifier: scenario.timeZone))
        let today = LocalDate(scenario.now, in: zone)
        #expect(today.description == scenario.today)

        for task in scenario.tasks {
            let key = task.id.lowercased
            #expect(TodayRanking.rank(of: task, today: today, in: zone) == scenario.expected.ranks[key], "Rang von \(task.title)")
            #expect(TodayRanking.dueDate(of: task, in: zone)?.description == scenario.expected.dueDates[key] ?? nil, "Fälligkeit von \(task.title)")
            #expect(TodayRanking.isActionableNow(task, now: scenario.now) == scenario.expected.actionable[key], "Ausführbar: \(task.title)")
        }

        let all = scenario.tasks.filter { ($0.status == .todo || $0.status == .doing) && $0.mergedIntoTaskId == nil }
        let sorted = TodayRanking.sortForToday(all.filter { TodayRanking.isActionableNow($0, now: scenario.now) }, today: today, in: zone)
        #expect(sorted.map(\.id) == scenario.expected.sortedActionableIds)

        let result = TodayRanking.computeToday(tasks: scenario.tasks, openClarifications: 0, accounts: [], pendingAnalysisCount: 0, timeZone: zone, now: scenario.now)
        #expect(result.next.map(\.id) == scenario.expected.nextIds)
        #expect(result.moreUrgent.map(\.id) == scenario.expected.moreUrgentIds)
        #expect(result.waitingCount == scenario.expected.waitingCount)
        #expect(result.canWaitCount == scenario.expected.canWaitCount)
    }

    @Test("Vorgeschlagene Bearbeitungsdaten sind keine Fristen")
    func suggestedDeadlines() {
        let task = makeTask(priority: .canWait, deadline: .onDate(day("2026-05-02"), kind: .suggested))
        #expect(TodayRanking.dueDate(of: task, in: paris) == nil)
        #expect(TodayRanking.rank(of: task, today: day("2026-05-01"), in: paris) == 4)
    }

    @Test("Weitere dringende Aufgaben werden nie abgeschnitten")
    func moreUrgentIsNeverTruncated() {
        let now = date("2026-10-23T08:00:00Z")
        let tasks = (0..<12).map { index in
            makeTask("Kritisch \(index)", priority: .critical, createdAt: date("2026-10-01T08:00:00Z").addingTimeInterval(Double(index)))
        }
        let today = TodayRanking.computeToday(tasks: tasks, openClarifications: 2, accounts: [], pendingAnalysisCount: nil, timeZone: paris, now: now)
        #expect(today.next.count == 3)
        #expect(today.moreUrgent.count == 9)
        #expect(today.openClarifications == 2)
    }

    @Test("Kontofehler mit Handlung, letzte Aktualisierung, ungeprüfte Mails")
    func accountMeta() {
        let now = date("2026-10-23T08:00:00Z")
        let ok = Account(provider: .gmail, displayName: "Privat", emailAddress: "a@example.com", lastSuccessfulFetchAt: date("2026-10-23T05:00:00Z"),
                         pendingAnalysisCount: 3, createdAt: now)
        let failing = Account(provider: .imap, displayName: "Hochschule", emailAddress: "b@example.com", status: .active,
                              lastSuccessfulFetchAt: date("2026-10-23T06:00:00Z"), pendingAnalysisCount: 2,
                              lastError: AccountError(code: "timeout", message: "", at: date("2026-10-23T07:00:00Z"), action: nil), createdAt: now)
        let reauth = Account(provider: .microsoft, displayName: "Arbeit", emailAddress: "c@example.com", status: .needsReauth, createdAt: now)
        let today = TodayRanking.computeToday(tasks: [], openClarifications: 0, accounts: [ok, failing, reauth], pendingAnalysisCount: nil, timeZone: paris, now: now)
        #expect(today.lastSuccessfulUpdateAt == date("2026-10-23T06:00:00Z"))
        #expect(today.pendingAnalysisCount == 5)
        #expect(today.accountsNeedingAttention.map(\.displayName).sorted() == ["Arbeit", "Hochschule"])
        #expect(today.accountsNeedingAttention.first { $0.displayName == "Arbeit" }?.action == "Konto erneut verbinden")
        #expect(today.accountsNeedingAttention.first { $0.displayName == "Hochschule" }?.problem == "Letzter Abruf fehlgeschlagen")
        #expect(today.accountsNeedingAttention.first { $0.displayName == "Hochschule" }?.action == "Verbindung prüfen")
        let serverCount = TodayRanking.computeToday(tasks: [], openClarifications: 0, accounts: [ok], pendingAnalysisCount: 12, timeZone: paris, now: now)
        #expect(serverCount.pendingAnalysisCount == 12)
    }
}
