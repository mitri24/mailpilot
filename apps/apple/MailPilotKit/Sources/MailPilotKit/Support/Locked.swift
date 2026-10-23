import Foundation

/// Threadsicherer Behälter auf Basis von `NSLock`. `Synchronization.Mutex` gibt es erst ab iOS 18 / macOS 15.
public final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    public init(_ value: Value) {
        self.value = value
    }

    public func withLock<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }

    public var current: Value {
        withLock { $0 }
    }

    public func set(_ newValue: Value) {
        withLock { $0 = newValue }
    }
}
