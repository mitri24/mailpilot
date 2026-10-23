import Foundation

/// Kalenderdatum ohne Uhrzeit und ohne Zone (`YYYY-MM-DD`), entspricht `DateOnly` im API-Vertrag.
/// Reine Datumsfristen bleiben so ohne erfundene Uhrzeit.
public struct LocalDate: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init?(year: Int, month: Int, day: Int) {
        guard (1...9999).contains(year), (1...12).contains(month),
              (1...LocalDate.daysIn(month: month, year: year)).contains(day) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    /// Erwartet genau `YYYY-MM-DD`.
    public init?(_ string: String) {
        let bytes = Array(string.utf8)
        guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
              let year = Self.number(bytes, 0, 4),
              let month = Self.number(bytes, 5, 2),
              let day = Self.number(bytes, 8, 2) else { return nil }
        self.init(year: year, month: month, day: day)
    }

    /// Kalendertag des Zeitpunkts `instant` in der Zone `timeZone`.
    public init(_ instant: Date, in timeZone: TimeZone) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: instant)
        self.year = parts.year ?? 1970
        self.month = parts.month ?? 1
        self.day = parts.day ?? 1
    }

    /// Tage seit 1970-01-01 (proleptischer gregorianischer Kalender).
    public init(daysSinceEpoch: Int) {
        let z = daysSinceEpoch + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        self.year = yoe + era * 400 + (month <= 2 ? 1 : 0)
        self.month = month
        self.day = day
    }

    public var daysSinceEpoch: Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /// Wie `addDays` in `packages/contracts/src/time.ts`: reine Kalenderarithmetik.
    public func adding(days: Int) -> LocalDate {
        LocalDate(daysSinceEpoch: daysSinceEpoch + days)
    }

    public func days(until other: LocalDate) -> Int {
        other.daysSinceEpoch - daysSinceEpoch
    }

    /// 0 = Sonntag … 6 = Samstag.
    public var weekday: Int {
        let value = (daysSinceEpoch + 4) % 7
        return value >= 0 ? value : value + 7
    }

    /// Beginn des Tages (00:00) in `timeZone`.
    public func startOfDay(in timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = DateComponents(year: year, month: month, day: day)
        return calendar.date(from: parts) ?? Date(timeIntervalSince1970: TimeInterval(daysSinceEpoch) * 86_400)
    }

    public static func today(in timeZone: TimeZone, now: Date = Date()) -> LocalDate {
        LocalDate(now, in: timeZone)
    }

    public var description: String {
        "\(Self.pad(year, 4))-\(Self.pad(month, 2))-\(Self.pad(day, 2))"
    }

    public static func < (lhs: LocalDate, rhs: LocalDate) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let string = try container.decode(String.self)
        guard let value = LocalDate(string) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Ungültiges Datum: \(string)")
        }
        self = value
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        default:
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
            return leap ? 29 : 28
        }
    }

    static func number(_ bytes: [UInt8], _ start: Int, _ length: Int) -> Int? {
        guard start + length <= bytes.count else { return nil }
        var value = 0
        for byte in bytes[start..<(start + length)] {
            guard byte >= 48, byte <= 57 else { return nil }
            value = value * 10 + Int(byte - 48)
        }
        return value
    }

    static func pad(_ value: Int, _ width: Int) -> String {
        let digits = String(value)
        return digits.count >= width ? digits : String(repeating: "0", count: width - digits.count) + digits
    }
}
