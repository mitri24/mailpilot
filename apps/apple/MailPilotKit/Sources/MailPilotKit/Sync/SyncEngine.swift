import Foundation

/// Netzwerkseite der Synchronisierung; in Tests ersetzt durch einen Mock.
public protocol SyncTransport: Sendable {
    /// `POST /v1/sync/mutations` mit unveränderten Outbox-Bytes.
    func pushMutations(_ raw: [Data]) async throws -> [MutationResult]
    /// `GET /v1/sync/changes`
    func fetchChanges(cursor: String?, limit: Int) async throws -> ChangesResponse
    /// `GET /v1/today` (nur für `pendingAnalysisCount`)
    func fetchToday() async throws -> Today
}

extension APIClient: SyncTransport {
    public func pushMutations(_ raw: [Data]) async throws -> [MutationResult] {
        try await send(API.mutations(raw: raw)).results
    }

    public func fetchChanges(cursor: String?, limit: Int) async throws -> ChangesResponse {
        try await send(API.changes(cursor: cursor, limit: limit))
    }

    public func fetchToday() async throws -> Today {
        try await send(API.today())
    }
}

public struct SyncReport: Sendable, Hashable {
    public enum Outcome: Sendable, Hashable {
        case success
        case offline
        case signedOut
        case failed(String)
        /// Lief bereits; ein weiterer Durchlauf folgt automatisch.
        case alreadyRunning
    }

    public var outcome: Outcome
    public var pushed = 0
    public var acknowledged = 0
    public var conflicts = 0
    public var rejected = 0
    /// Vor dem Senden verworfen (vom anderen Gerät inzwischen anders geändert).
    public var dropped = 0
    public var pulledChanges = 0
    public var pages = 0
    public var didReset = false

    public init(outcome: Outcome) { self.outcome = outcome }

    public var succeeded: Bool { outcome == .success }
}

enum SyncFailure: Error {
    case resetLoop
    case noProgress
}

/// Ein Synchronisierungslauf: Outbox in Reihenfolge senden (max. 100 je Stapel), dann Änderungen seit dem Cursor abrufen,
/// bis `hasMore = false`. Bei `resetRequired` Vollabzug; die Outbox bleibt erhalten.
public actor SyncEngine {
    private let store: LocalStore
    private let transport: any SyncTransport
    private let clock: @Sendable () -> Date
    private let isSignedIn: @Sendable () -> Bool
    private let didFinish: @Sendable (SyncReport) async -> Void
    private let batchSize: Int
    private let pageSize: Int
    private var isRunning = false
    private var rerunRequested = false

    public init(store: LocalStore, transport: any SyncTransport, batchSize: Int = 100, pageSize: Int = 500,
                clock: @escaping @Sendable () -> Date = { Date() },
                isSignedIn: @escaping @Sendable () -> Bool,
                didFinish: @escaping @Sendable (SyncReport) async -> Void = { _ in }) {
        self.store = store
        self.transport = transport
        self.batchSize = min(max(batchSize, 1), 100)
        self.pageSize = pageSize
        self.clock = clock
        self.isSignedIn = isSignedIn
        self.didFinish = didFinish
    }

    public func sync() async -> SyncReport {
        if isRunning {
            rerunRequested = true
            return SyncReport(outcome: .alreadyRunning)
        }
        isRunning = true
        var report = await runOnce()
        while rerunRequested, report.succeeded {
            rerunRequested = false
            report = await runOnce()
        }
        rerunRequested = false
        isRunning = false
        await didFinish(report)
        return report
    }

    private func runOnce() async -> SyncReport {
        var report = SyncReport(outcome: .success)
        guard isSignedIn() else {
            report.outcome = .signedOut
            return report
        }
        do {
            var pulledSinceLastPush = false
            for _ in 0..<1000 {
                // Bestätigte Änderungen erst abrufen, dann die nächste Änderung derselben Entität prüfen und senden.
                if try store.hasAcknowledgedEntries() {
                    try await pull(&report)
                    pulledSinceLastPush = true
                }
                let batch = try store.prepareBatch(limit: batchSize, now: clock())
                report.dropped += batch.dropped
                guard !batch.entries.isEmpty else { break }
                pulledSinceLastPush = false
                let results = try await push(batch.entries)
                report.pushed += batch.entries.count
                let counts = try store.applyResults(results, for: batch.entries, now: clock())
                report.acknowledged += counts.acknowledged
                report.conflicts += counts.conflicts
                report.rejected += counts.rejected
                // Ohne Antwort zu diesen Mutationen nicht im selben Lauf erneut senden (nächster Lauf, gleiche Keys).
                if counts.acknowledged + counts.conflicts + counts.rejected == 0 { break }
            }
            if !pulledSinceLastPush {
                try await pull(&report)
            }
            try store.recordSyncSuccess(at: clock())
            if let today = try? await transport.fetchToday() {
                try? store.recordServerToday(pendingAnalysisCount: today.pendingAnalysisCount, at: clock())
            }
        } catch let error as APIError {
            report.outcome = error.isUnauthorized ? .signedOut : (error.isOffline ? .offline : .failed(error.message))
            try? store.recordSyncFailure(message: error.message, offline: error.isOffline, at: clock())
        } catch is CancellationError {
            report.outcome = .failed("Abgebrochen")
        } catch {
            let message = "Synchronisierung fehlgeschlagen: \(error)"
            report.outcome = .failed(message)
            try? store.recordSyncFailure(message: message, offline: false, at: clock())
        }
        return report
    }

    /// Ein ungültiger Stapel (HTTP 400) wird einzeln wiederholt, damit eine fehlerhafte Änderung die anderen nicht blockiert.
    private func push(_ entries: [OutboxEntry]) async throws -> [MutationResult] {
        do {
            return try await transport.pushMutations(entries.map(\.body))
        } catch let error as APIError {
            if case .http(let status, _) = error, status == 400 || status == 422 {
                return try await pushIndividually(entries)
            }
            if error.isRetryable { try? store.recordSendFailure(entries, message: error.message) }
            throw error
        }
    }

    private func pushIndividually(_ entries: [OutboxEntry]) async throws -> [MutationResult] {
        var results: [MutationResult] = []
        for entry in entries {
            do {
                results += try await transport.pushMutations([entry.body])
            } catch let error as APIError {
                guard case .http(let status, _) = error, status == 400 || status == 422 else { throw error }
                results.append(MutationResult(idempotencyKey: entry.idempotencyKey, status: .rejected, entityType: entry.mutation.entityType,
                                              entityId: entry.mutation.entityId, error: MutationError(code: "invalid_request", message: error.message)))
            }
        }
        return results
    }

    private func pull(_ report: inout SyncReport) async throws {
        let started = clock()
        var cursor = try store.syncState().cursor
        var replacing = cursor == nil
        var resets = 0
        while true {
            let page = try await transport.fetchChanges(cursor: cursor, limit: pageSize)
            if page.resetRequired {
                guard resets == 0 else { throw SyncFailure.resetLoop }
                resets += 1
                report.didReset = true
                cursor = nil
                replacing = true
                continue
            }
            try store.apply(changes: page.changes, nextCursor: page.nextCursor, replacingAll: replacing,
                            purgeAcknowledgedBefore: page.hasMore ? nil : started)
            report.pulledChanges += page.changes.count
            report.pages += 1
            replacing = false
            guard page.hasMore else { break }
            guard page.nextCursor != cursor else { throw SyncFailure.noProgress }
            cursor = page.nextCursor
        }
    }
}

/// Wiederholung nach Netzwerkfehlern: exponentiell, gedeckelt, mit Streuung.
public struct Backoff: Sendable, Hashable {
    public var baseSeconds: Double
    public var maximumSeconds: Double
    public var jitter: Double

    public init(baseSeconds: Double = 2, maximumSeconds: Double = 300, jitter: Double = 0.2) {
        self.baseSeconds = baseSeconds
        self.maximumSeconds = maximumSeconds
        self.jitter = jitter
    }

    /// `attempt` ab 1; `random` in 0…1.
    public func delay(forAttempt attempt: Int, random: Double = Double.random(in: 0...1)) -> Duration {
        let exponent = Double(max(0, min(attempt - 1, 20)))
        let raw = min(maximumSeconds, baseSeconds * pow(2, exponent))
        let spread = 1 + jitter * (2 * min(max(random, 0), 1) - 1)
        return .milliseconds(Int((raw * spread * 1000).rounded()))
    }
}

/// Entprellt Synchronisierungen nach Änderungen und wiederholt sie nach Fehlern.
public actor SyncScheduler {
    private let engine: SyncEngine
    private let backoff: Backoff
    private let sleep: @Sendable (Duration) async throws -> Void
    private var debounceTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var failures = 0
    private var reportHandler: (@Sendable (SyncReport) async -> Void)?

    public init(engine: SyncEngine, backoff: Backoff = Backoff(),
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.engine = engine
        self.backoff = backoff
        self.sleep = sleep
    }

    public func setReportHandler(_ handler: @escaping @Sendable (SyncReport) async -> Void) {
        reportHandler = handler
    }

    /// Sofort (Öffnen, manuelles Aktualisieren).
    @discardableResult
    public func syncNow() async -> SyncReport {
        debounceTask?.cancel()
        debounceTask = nil
        retryTask?.cancel()
        retryTask = nil
        return await perform()
    }

    /// Nach einer lokalen Änderung, entprellt.
    public func scheduleSync(after delay: Duration = .milliseconds(1500)) {
        debounceTask?.cancel()
        let sleep = sleep
        debounceTask = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            await self?.debounceFired()
        }
    }

    public var consecutiveFailures: Int { failures }

    private func debounceFired() async {
        debounceTask = nil
        retryTask?.cancel()
        retryTask = nil
        _ = await perform()
    }

    private func retryFired() async {
        retryTask = nil
        _ = await perform()
    }

    private func perform() async -> SyncReport {
        let report = await engine.sync()
        switch report.outcome {
        case .success:
            failures = 0
        case .offline, .failed:
            failures += 1
            scheduleRetry()
        case .signedOut, .alreadyRunning:
            break
        }
        await reportHandler?(report)
        return report
    }

    private func scheduleRetry() {
        retryTask?.cancel()
        let delay = backoff.delay(forAttempt: failures)
        let sleep = sleep
        retryTask = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            await self?.retryFired()
        }
    }
}
