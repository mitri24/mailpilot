import Foundation

/// ISO-8601-Zeitstempel wie `Timestamp` im Vertrag: `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)`.
/// Eigener Parser, weil Formatter-Klassen nicht `Sendable` sind und Sekundenbruchteile optional sein müssen.
public enum ISOTimestamp {
    public static func parse(_ string: String) -> Date? {
        let b = Array(string.utf8)
        guard b.count >= 20,
              let year = LocalDate.number(b, 0, 4), b[4] == UInt8(ascii: "-"),
              let month = LocalDate.number(b, 5, 2), b[7] == UInt8(ascii: "-"),
              let day = LocalDate.number(b, 8, 2),
              b[10] == UInt8(ascii: "T") || b[10] == UInt8(ascii: "t"),
              let hour = LocalDate.number(b, 11, 2), b[13] == UInt8(ascii: ":"),
              let minute = LocalDate.number(b, 14, 2), b[16] == UInt8(ascii: ":"),
              let second = LocalDate.number(b, 17, 2),
              hour < 24, minute < 60, second < 60,
              let date = LocalDate(year: year, month: month, day: day) else { return nil }

        var index = 19
        var fraction = 0.0
        if index < b.count, b[index] == UInt8(ascii: ".") {
            index += 1
            var scale = 0.1
            let start = index
            while index < b.count, b[index] >= 48, b[index] <= 57 {
                fraction += Double(b[index] - 48) * scale
                scale /= 10
                index += 1
            }
            guard index > start else { return nil }
        }
        guard index < b.count else { return nil }

        var offsetSeconds = 0
        switch b[index] {
        case UInt8(ascii: "Z"), UInt8(ascii: "z"):
            index += 1
        case UInt8(ascii: "+"), UInt8(ascii: "-"):
            let sign = b[index] == UInt8(ascii: "-") ? -1 : 1
            guard let offsetHours = LocalDate.number(b, index + 1, 2), index + 3 < b.count,
                  b[index + 3] == UInt8(ascii: ":"),
                  let offsetMinutes = LocalDate.number(b, index + 4, 2),
                  offsetHours < 24, offsetMinutes < 60 else { return nil }
            offsetSeconds = sign * (offsetHours * 3600 + offsetMinutes * 60)
            index += 6
        default:
            return nil
        }
        guard index == b.count else { return nil }

        let seconds = Double(date.daysSinceEpoch) * 86_400
            + Double(hour * 3600 + minute * 60 + second)
            - Double(offsetSeconds)
            + fraction
        return Date(timeIntervalSince1970: seconds)
    }

    /// UTC mit Millisekunden, wie `Date.prototype.toISOString()` auf dem Server.
    public static func format(_ date: Date) -> String {
        let totalMs = Int64((date.timeIntervalSince1970 * 1000).rounded())
        var days = totalMs / 86_400_000
        var msOfDay = totalMs % 86_400_000
        if msOfDay < 0 {
            msOfDay += 86_400_000
            days -= 1
        }
        let d = LocalDate(daysSinceEpoch: Int(days))
        let hour = Int(msOfDay / 3_600_000)
        let minute = Int(msOfDay / 60_000 % 60)
        let second = Int(msOfDay / 1000 % 60)
        let millis = Int(msOfDay % 1000)
        return "\(d)T\(LocalDate.pad(hour, 2)):\(LocalDate.pad(minute, 2)):\(LocalDate.pad(second, 2)).\(LocalDate.pad(millis, 3))Z"
    }
}

/// Einheitliche Kodierung für API, Cache und Outbox.
public enum APIJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            guard let date = ISOTimestamp.parse(string) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Ungültiger Zeitstempel: \(string)")
            }
            return date
        }
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISOTimestamp.format(date))
        }
        // Stabile Bytes: dieselbe Mutation ergibt immer denselben Body.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        try encoder().encode(value)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try decoder().decode(type, from: data)
    }

    public static func string<T: Encodable>(_ value: T) throws -> String {
        String(decoding: try encode(value), as: UTF8.self)
    }
}

/// Beliebiger JSON-Wert, z. B. `oldValue`/`newValue` im Verlauf.
public enum JSONValue: Hashable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// Kurze, lesbare Darstellung für den Verlauf.
    public var displayText: String {
        switch self {
        case .null: return "–"
        case .bool(let value): return value ? "ja" : "nein"
        case .number(let value):
            return value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        case .string(let value): return value
        case .array(let values): return values.map(\.displayText).joined(separator: ", ")
        case .object(let values):
            if case .string(let date)? = values["date"] { return date }
            if case .string(let dateTime)? = values["dateTime"] { return dateTime }
            return values.keys.sorted().map { "\($0): \(values[$0]!.displayText)" }.joined(separator: ", ")
        }
    }
}

/// Dreiwertiges Patch-Feld: weglassen, explizit `null` oder Wert (Vertrag: `.nullable().optional()`).
public enum FieldUpdate<Value> {
    case unchanged
    case clear
    case set(Value)

    public var isUnchanged: Bool {
        if case .unchanged = self { return true }
        return false
    }

    /// `nil` für unverändert, `.some(nil)` für löschen.
    public var change: Value?? {
        switch self {
        case .unchanged: return nil
        case .clear: return .some(nil)
        case .set(let value): return .some(value)
        }
    }

    public init(_ value: Value?) {
        self = value.map { .set($0) } ?? .clear
    }

    /// Späterer Wert gewinnt.
    public func overridden(by later: FieldUpdate<Value>) -> FieldUpdate<Value> {
        later.isUnchanged ? self : later
    }
}

extension FieldUpdate: Sendable where Value: Sendable {}
extension FieldUpdate: Equatable where Value: Equatable {}
extension FieldUpdate: Hashable where Value: Hashable {}

extension KeyedEncodingContainer {
    mutating func encodeUpdate<T: Encodable>(_ update: FieldUpdate<T>, forKey key: Key) throws {
        switch update {
        case .unchanged: break
        case .clear: try encodeNil(forKey: key)
        case .set(let value): try encode(value, forKey: key)
        }
    }

    /// Schreibt `null` statt den Schlüssel wegzulassen (Pflichtfeld, das `null` sein darf).
    mutating func encodeNullable<T: Encodable>(_ value: T?, forKey key: Key) throws {
        if let value {
            try encode(value, forKey: key)
        } else {
            try encodeNil(forKey: key)
        }
    }
}

extension KeyedDecodingContainer {
    func decodeUpdate<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> FieldUpdate<T> {
        guard contains(key) else { return .unchanged }
        if try decodeNil(forKey: key) { return .clear }
        return .set(try decode(T.self, forKey: key))
    }
}
