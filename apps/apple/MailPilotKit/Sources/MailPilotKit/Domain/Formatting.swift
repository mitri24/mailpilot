import Foundation

/// Deutsche Texte, ohne Abhängigkeit von der Gerätesprache (deterministisch und testbar).
public enum GermanText {
    static let weekdays = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."]
    static let months = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."]

    /// „heute“, „morgen“, „gestern“ oder „Fr., 30. Okt.“ (Jahr nur, wenn abweichend).
    public static func day(_ date: LocalDate, today: LocalDate) -> String {
        switch today.days(until: date) {
        case 0: return "heute"
        case 1: return "morgen"
        case -1: return "gestern"
        default:
            let base = "\(weekdays[date.weekday]), \(date.day). \(months[date.month - 1])"
            return date.year == today.year ? base : "\(base) \(date.year)"
        }
    }

    public static func time(_ instant: Date, in timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: instant)
        return "\(LocalDate.pad(parts.hour ?? 0, 2)):\(LocalDate.pad(parts.minute ?? 0, 2))"
    }

    public static func dateTime(_ instant: Date, in timeZone: TimeZone, now: Date) -> String {
        let today = LocalDate(now, in: timeZone)
        return "\(day(LocalDate(instant, in: timeZone), today: today)), \(time(instant, in: timeZone))"
    }

    /// „gerade eben“, „vor 5 Min.“, „vor 3 Std.“, „vor 2 Tagen“.
    public static func age(of instant: Date, now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(instant))
        switch seconds {
        case ..<60: return "gerade eben"
        case ..<3600: return "vor \(Int(seconds / 60)) Min."
        case ..<86_400: return "vor \(Int(seconds / 3600)) Std."
        default:
            let days = Int(seconds / 86_400)
            return days == 1 ? "vor 1 Tag" : "vor \(days) Tagen"
        }
    }

    public static func status(_ status: TaskStatus) -> String {
        switch status {
        case .todo: return "To Do"
        case .doing: return "Doing"
        case .done: return "Erledigt"
        case .dismissed: return "Nicht relevant"
        }
    }

    public static func priority(_ priority: Priority) -> String {
        switch priority {
        case .critical: return "Kritisch"
        case .important: return "Wichtig"
        case .canWait: return "Kann warten"
        }
    }

    /// SF-Symbol je Priorität, damit Prioritäten nie nur über Farbe erkennbar sind.
    public static func prioritySymbol(_ priority: Priority) -> String {
        switch priority {
        case .critical: return "exclamationmark.2"
        case .important: return "exclamationmark"
        case .canWait: return "arrow.down"
        }
    }

    public static func deadlineKind(_ kind: DeadlineKind) -> String {
        switch kind {
        case .explicit: return "Frist laut Mail"
        case .uncertain: return "Frist, unsicher erkannt"
        case .suggested: return "Vorschlag, keine Frist"
        }
    }

    /// Kurzform für Karten: „bis morgen“, „bis Fr., 30. Okt., 14:00“, „überfällig seit gestern“.
    public static func deadline(_ deadline: Deadline, in timeZone: TimeZone, now: Date) -> String {
        let today = LocalDate(now, in: timeZone)
        let due: LocalDate
        var timeSuffix = ""
        switch deadline.precision {
        case .date:
            guard let date = deadline.date else { return "Frist unbekannt" }
            due = date
        case .datetime:
            guard let instant = deadline.dateTime else { return "Frist unbekannt" }
            due = LocalDate(instant, in: timeZone)
            timeSuffix = ", \(time(instant, in: timeZone))"
        }
        if deadline.kind == .suggested {
            return "Vorschlag: \(day(due, today: today))\(timeSuffix)"
        }
        if due < today {
            return "überfällig seit \(day(due, today: today))"
        }
        return "bis \(day(due, today: today))\(timeSuffix)"
    }

    /// Zeitaufwand nur mit Herkunft; ohne Angabe wird nichts erfunden.
    public static func estimate(minutes: Int?, source: EstimateSource?) -> String? {
        guard let minutes else { return nil }
        let amount = minutes >= 60 && minutes % 60 == 0 ? "\(minutes / 60) Std." : "\(minutes) Min."
        switch source {
        case .user: return "\(amount) (deine Angabe)"
        case .estimate: return "ca. \(amount) (Schätzung)"
        case nil: return "\(amount) (Herkunft unbekannt)"
        }
    }

    public static func field(_ name: String) -> String {
        switch name {
        case "status": return "Status"
        case "waiting": return "Warte auf Antwort"
        case "waitingCheckAt": return "Nachsehdatum"
        case "snoozedUntil": return "Später anzeigen"
        case "plannedFor": return "Eingeplant für"
        case "sortKey", "position": return "Reihenfolge"
        case "title": return "Titel"
        case "nextStep": return "Nächster Schritt"
        case "priority": return "Priorität"
        case "deadline": return "Frist"
        case "estimatedMinutes": return "Zeitaufwand"
        case "body": return "Notiz"
        case "answer": return "Antwort"
        case "done": return "Erledigt-Haken"
        default: return name
        }
    }

    public static func fields(_ names: [String]) -> String {
        names.map(field).joined(separator: ", ")
    }

    public static func accountStatus(_ status: AccountStatus) -> String {
        switch status {
        case .active: return "Verbunden"
        case .paused: return "Pausiert"
        case .error: return "Fehler"
        case .needsReauth: return "Erneute Anmeldung nötig"
        case .removed: return "Entfernt"
        }
    }

    public static func provider(_ provider: Provider) -> String {
        switch provider {
        case .gmail: return "Gmail"
        case .microsoft: return "Microsoft 365 / Outlook"
        case .imap: return "IMAP"
        }
    }

    public static func marker(_ strategy: MarkerStrategy) -> String {
        switch strategy {
        case .none: return "Keine Markierung"
        case .imapKeyword: return "IMAP-Schlüsselwort"
        case .imapFlagged: return "Standard-Markierung (Fähnchen)"
        case .imapCopyFolder: return "Kopie in eigenen Ordner"
        case .gmailLabel: return "Gmail-Label"
        case .graphCategory: return "Outlook-Kategorie"
        case .graphFlag: return "Outlook-Kennzeichnung"
        }
    }

    /// Sachliche Erklärung, was in Apple Mail tatsächlich sichtbar ist.
    public static func markerExplanation(_ strategy: MarkerStrategy) -> String {
        switch strategy {
        case .none:
            return "Mails werden nicht verändert. Welche Mails übernommen wurden, siehst du nur in MailPilot."
        case .imapKeyword:
            return "Setzt ein eigenes IMAP-Schlüsselwort. Apple Mail zeigt solche Schlüsselwörter in der Regel nicht an."
        case .imapFlagged:
            return "Setzt die normale Markierung (Fähnchen). Apple Mail zeigt sie an, sie ist aber nicht von deinen eigenen Markierungen zu unterscheiden. Erledigen entfernt sie nicht."
        case .imapCopyFolder:
            return "Legt eine Kopie in einem eigenen Ordner ab. Nur nach ausdrücklicher Aktivierung; die Originalmail bleibt, wo sie ist."
        case .gmailLabel:
            return "Setzt ein Gmail-Label. In Apple Mail erscheinen Labels höchstens als Ordner, nicht als Markierung an der Mail."
        case .graphCategory:
            return "Setzt eine Outlook-Kategorie. Apple Mail zeigt Kategorien nicht an."
        case .graphFlag:
            return "Setzt die Outlook-Kennzeichnung. Ob Apple Mail sie anzeigt, hängt von der Kontoart ab und ist nicht garantiert."
        }
    }

    public static func analysisStatus(_ status: AnalysisStatus) -> String {
        switch status {
        case .pending: return "Noch nicht geprüft"
        case .analyzed: return "Geprüft"
        case .skipped: return "Übersprungen"
        case .failed: return "Prüfung fehlgeschlagen"
        case .budgetPaused: return "Wartet (KI-Budget erreicht)"
        case .tooLarge: return "Zu groß für die Prüfung"
        }
    }

    public static func runStatus(_ status: RunStatus) -> String {
        switch status {
        case .queued: return "Wartet"
        case .running: return "Läuft"
        case .succeeded: return "Abgeschlossen"
        case .partial: return "Teilweise abgeschlossen"
        case .failed: return "Fehlgeschlagen"
        }
    }

    public static func folderRole(_ role: FolderRole) -> String {
        switch role {
        case .inbox: return "Posteingang"
        case .sent: return "Gesendet"
        case .archive: return "Archiv"
        case .drafts: return "Entwürfe"
        case .spam: return "Spam"
        case .trash: return "Papierkorb"
        case .other: return "Ordner"
        }
    }

    public static func bytes(_ size: Int?) -> String {
        guard let size else { return "Größe unbekannt" }
        switch size {
        case ..<1024: return "\(size) B"
        case ..<(1024 * 1024): return "\(size / 1024) KB"
        default:
            let tenths = Int((Double(size) / 1_048_576 * 10).rounded())
            return "\(tenths / 10),\(tenths % 10) MB"
        }
    }

    public static func euros(cents: Double) -> String {
        let rounded = Int(cents.rounded())
        return "\(rounded / 100),\(LocalDate.pad(rounded % 100, 2)) €"
    }

    public static func count(_ n: Int, _ singular: String, _ plural: String) -> String {
        n == 1 ? "1 \(singular)" : "\(n) \(plural)"
    }
}
