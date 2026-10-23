import Foundation
import Testing
@testable import MailPilotKit

@Suite("Datum, Zeitstempel, JSON-Grundlagen")
struct PrimitivesTests {
    @Test("YYYY-MM-DD wird streng geprüft")
    func localDateParsing() throws {
        #expect(LocalDate("2026-10-30")?.description == "2026-10-30")
        #expect(LocalDate("2028-02-29") != nil)
        #expect(LocalDate("2026-02-29") == nil)
        #expect(LocalDate("2026-13-01") == nil)
        #expect(LocalDate("2026-1-01") == nil)
        #expect(LocalDate("2026-10-30T00:00:00Z") == nil)
        #expect(LocalDate("+026-10-30") == nil)
    }

    @Test("Kalenderarithmetik wie addDays in time.ts")
    func localDateArithmetic() {
        #expect(day("2026-02-28").adding(days: 1).description == "2026-03-01")
        #expect(day("2028-02-28").adding(days: 1).description == "2028-02-29")
        #expect(day("2026-12-31").adding(days: 1).description == "2027-01-01")
        #expect(day("2026-03-01").adding(days: -1).description == "2026-02-28")
        #expect(day("1970-01-01").daysSinceEpoch == 0)
        #expect(LocalDate(daysSinceEpoch: day("2026-10-23").daysSinceEpoch) == day("2026-10-23"))
        #expect(day("2026-10-23").weekday == 5) // Freitag
        #expect(day("2026-10-20") < day("2026-10-21"))
    }

    @Test("Lokales Datum eines Zeitpunkts in Europe/Paris (Sommerzeit)")
    func localDateInZone() {
        #expect(LocalDate(date("2026-03-29T23:30:00Z"), in: paris).description == "2026-03-30")
        #expect(LocalDate(date("2026-10-25T22:30:00Z"), in: paris).description == "2026-10-25")
        #expect(LocalDate(date("2026-10-25T23:30:00Z"), in: paris).description == "2026-10-26")
        #expect(day("2026-10-25").startOfDay(in: paris) == date("2026-10-24T22:00:00Z"))
    }

    @Test("ISO-8601 mit und ohne Bruchteile, Z und Offset", arguments: [
        ("2026-10-30T09:00:00Z", 1_793_350_800.0),
        ("2026-10-30T09:00:00.000Z", 1_793_350_800.0),
        ("2026-10-30T09:00:00.5Z", 1_793_350_800.5),
        ("2026-10-30T10:00:00+01:00", 1_793_350_800.0),
        ("2026-10-30T04:30:00-04:30", 1_793_350_800.0),
        ("2026-10-30T09:00:00.123456Z", 1_793_350_800.123456),
    ])
    func timestampParsing(input: String, expected: Double) throws {
        let parsed = try #require(ISOTimestamp.parse(input))
        #expect(abs(parsed.timeIntervalSince1970 - expected) < 0.000_001)
    }

    @Test("Ungültige Zeitstempel werden abgelehnt", arguments: [
        "2026-10-30 09:00:00Z", "2026-10-30T09:00:00", "2026-10-30T24:00:00Z", "2026-02-30T09:00:00Z", "2026-10-30T09:00:00+0100", "2026-10-30T09:00:00.Z",
    ])
    func timestampRejects(input: String) {
        #expect(ISOTimestamp.parse(input) == nil)
    }

    @Test("Formatierung wie toISOString() (UTC, Millisekunden)")
    func timestampFormatting() {
        #expect(ISOTimestamp.format(date("2026-10-30T10:00:00+01:00")) == "2026-10-30T09:00:00.000Z")
        #expect(ISOTimestamp.format(date("2026-10-22T16:05:12.345Z")) == "2026-10-22T16:05:12.345Z")
        #expect(ISOTimestamp.format(Date(timeIntervalSince1970: -1)) == "1969-12-31T23:59:59.000Z")
    }

    @Test("JSONValue unterscheidet Zahl, Wahrheitswert, Text, null")
    func jsonValueTypes() throws {
        let values = try JSONDecoder().decode([JSONValue].self, from: Data(#"[1, true, 0, false, 1.5, "x", null, [2], {"a": "b"}]"#.utf8))
        #expect(values == [.number(1), .bool(true), .number(0), .bool(false), .number(1.5), .string("x"), .null, .array([.number(2)]), .object(["a": .string("b")])])
    }

    @Test("Patch-Felder: weglassen, null, Wert")
    func fieldUpdateEncoding() throws {
        let patch = TaskPatch(status: .doing, plannedFor: .clear, title: .set("Neu"))
        #expect(try encodeJSON(patch) == .object(["status": .string("doing"), "plannedFor": .null, "title": .string("Neu")]))
        let decoded = try APIJSON.decode(TaskPatch.self, from: Data(#"{"plannedFor":null,"sortKey":3}"#.utf8))
        #expect(decoded.plannedFor == .clear)
        #expect(decoded.sortKey == .set(3))
        #expect(decoded.title == .unchanged)
        #expect(decoded.status == nil)
    }

    @Test("Feldweises Zusammenfassen: spätere Änderung gewinnt, Frist als ein Feld")
    func patchMerging() {
        let first = TaskPatch(status: .doing, deadlineCleared: true)
        let second = TaskPatch(status: .done, deadline: .set(.onDate(day("2026-11-02"))))
        let merged = first.merged(with: second)
        #expect(merged.status == .done)
        #expect(merged.deadline == .set(.onDate(day("2026-11-02"))))
        #expect(merged.deadlineCleared == nil)
        #expect(merged.fieldNames == ["status", "deadline"])
        #expect(merged.removing(fields: ["deadline"]).fieldNames == ["status"])
    }

    @Test("Nonce für Sign in with Apple: SHA-256 als Kleinbuchstaben-Hex")
    func nonce() {
        #expect(AppleSignInNonce.sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let raw = AppleSignInNonce.random()
        #expect(raw.count == 32)
        #expect(raw != AppleSignInNonce.random())
        #expect(raw.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }

    @Test("Deutsche Texte für Datum und Alter")
    func germanText() {
        let today = day("2026-10-23")
        #expect(GermanText.day(today, today: today) == "heute")
        #expect(GermanText.day(day("2026-10-24"), today: today) == "morgen")
        #expect(GermanText.day(day("2026-10-30"), today: today) == "Fr., 30. Okt.")
        #expect(GermanText.day(day("2027-01-04"), today: today) == "Mo., 4. Jan. 2027")
        let now = date("2026-10-23T08:00:00Z")
        #expect(GermanText.age(of: now.addingTimeInterval(-30), now: now) == "gerade eben")
        #expect(GermanText.age(of: now.addingTimeInterval(-300), now: now) == "vor 5 Min.")
        #expect(GermanText.age(of: now.addingTimeInterval(-7200), now: now) == "vor 2 Std.")
        #expect(GermanText.estimate(minutes: 30, source: .estimate) == "ca. 30 Min. (Schätzung)")
        #expect(GermanText.estimate(minutes: nil, source: nil) == nil)
        #expect(GermanText.deadline(.onDate(day("2026-10-20")), in: paris, now: now) == "überfällig seit Di., 20. Okt.")
        #expect(GermanText.deadline(.at(date("2026-10-24T12:00:00Z")), in: paris, now: now) == "bis morgen, 14:00")
        #expect(GermanText.deadline(.onDate(day("2026-10-24"), kind: .suggested), in: paris, now: now) == "Vorschlag: morgen")
    }
}
