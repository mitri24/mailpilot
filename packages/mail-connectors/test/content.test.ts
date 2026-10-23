import { describe, expect, it } from "vitest";
import { computeContentHash, normalizeMessageId, normalizeText, processBody, processMime, reduceForAnalysis, sanitizeEmailHtml } from "../src/index.js";

function mime(headers: Record<string, string>, body: string, contentType = "text/plain; charset=utf-8"): string {
  const base: Record<string, string> = {
    From: "Max Muster <Max@Example.org>",
    To: "Anna Beispiel <anna@example.com>",
    Subject: "Angebot",
    Date: "Thu, 22 Oct 2026 10:15:00 +0200",
    "Message-ID": "<abc-123@example.org>",
    "MIME-Version": "1.0",
    "Content-Type": contentType,
    ...headers,
  };
  return `${Object.entries(base)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\r\n")}\r\n\r\n${body}\r\n`;
}

describe("sanitizeEmailHtml", () => {
  it("entfernt Skripte, Event-Handler, Formulare, Frames und Style-Blöcke", () => {
    const { html } = sanitizeEmailHtml(`
      <p onclick="steal()">Hallo<script>alert("x")</script></p>
      <img src="x" onerror="alert(1)">
      <svg onload="alert(1)"><circle r="1"/></svg>
      <form action="https://evil.example.com"><input name="pw"></form>
      <iframe src="https://evil.example.com/frame"></iframe>
      <style>p { color: red }</style>
      <div style="color:#c00; background-image:url(https://evil.example.com/x.png); font-weight:bold">Rot</div>`);
    expect(html).not.toMatch(/script|onclick|onerror|onload|<svg|<form|<input|<iframe|<style|url\(|<img|mp-drop/i);
    expect(html).toContain("<p>Hallo</p>");
    expect(html).toContain('<div style="color:#c00;font-weight:bold">Rot</div>');
    expect(html.match(/<\/?[a-z-]+/gi)?.filter((tag) => !/^<\/?(p|div)$/i.test(tag))).toEqual([]);
  });

  it("ersetzt Remote-Bilder durch Platzhalter, entfernt Tracking-Pixel und zählt beides", () => {
    const result = sanitizeEmailHtml(`
      <img src="https://cdn.example.com/logo.png" alt="Logo" width="120">
      <img src="https://t.example.com/o/abc.gif" width="1" height="1" alt="">
      <img src="https://news.example.com/track/open?id=7">
      <img src="//cdn.example.com/protocol-relative.png">
      <img src="cid:image001@01D9">
      <img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline">
      <table background="https://evil.example.com/bg.png"><tr><td>Zelle</td></tr></table>`);
    expect(result.remoteContentBlocked).toBe(5);
    expect(result.html).toContain('<span class="mp-remote-image" title="Externes Bild blockiert">[Bild: Logo]</span>');
    expect(result.html.match(/mp-remote-image/g)).toHaveLength(2);
    expect(result.html).not.toMatch(/t\.example\.net|track\/open|cdn\.example\.net|evil\.example\.net/);
    expect(result.html).toContain('<span class="mp-inline-image" title="Eingebettetes Bild">[Bild]</span>');
    expect(result.html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline" />');
  });

  it("lässt nur http/https/mailto-Links zu, jeweils mit rel=noopener noreferrer", () => {
    const { html } = sanitizeEmailHtml(`
      <a href="javascript:alert(1)">böse</a>
      <a href="jav&#x61;script:alert(1)">auch böse</a>
      <a href="data:text/html;base64,PHNjcmlwdD4=">data</a>
      <a href="https://example.org/termin" target="_blank" onclick="x()">Termin</a>
      <a href="mailto:max@example.org">Mail</a>`);
    expect(html).toContain("<a>böse</a>");
    expect(html).toContain("<a>auch böse</a>");
    expect(html).toContain("<a>data</a>");
    expect(html).toContain('<a href="https://example.org/termin" rel="noopener noreferrer">Termin</a>');
    expect(html).toContain('<a href="mailto:max@example.org" rel="noopener noreferrer">Mail</a>');
  });

  it("zählt URLs in Style-Blöcken und Inline-Styles", () => {
    const result = sanitizeEmailHtml(
      `<style>@import url("https://evil.example.com/a.css"); body { background: url(https://evil.example.com/b.png) }</style><p style="background:url('http://evil.example.com/c.png')">x</p>`,
    );
    expect(result.remoteContentBlocked).toBe(3);
    expect(result.html).toBe("<p>x</p>");
  });
});

describe("processMime", () => {
  it("liest Kopfzeilen, Adressen und bevorzugt text/plain", async () => {
    const raw = [
      "From: Max Muster <Max@Example.org>",
      "To: Anna Beispiel <anna@example.com>, team@example.com",
      "Cc: =?UTF-8?Q?J=C3=BCrg_Gr=C3=BCn?= <juerg@example.com>",
      "Subject: =?UTF-8?Q?Angebot_f=C3=BCr_Projekt?=",
      "Date: Thu, 22 Oct 2026 10:15:00 +0200",
      "Message-ID: <abc-123@example.org>",
      "In-Reply-To: <prev-1@example.com>",
      "References: <root-0@example.com> <prev-1@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hallo Anna, bitte bis Freitag.",
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Hallo <b>Anna</b>, bitte bis Freitag.</p><img src="https://t.example.com/p.gif" width="1" height="1">',
      "--alt--",
      "",
    ].join("\r\n");
    const result = await processMime(raw, { maxMessageBytes: 100_000 });
    expect(result).toMatchObject({
      rfcMessageId: "<abc-123@example.org>",
      inReplyTo: "<prev-1@example.com>",
      references: ["<root-0@example.com>", "<prev-1@example.com>"],
      from: { name: "Max Muster", address: "max@example.org" },
      to: [
        { name: "Anna Beispiel", address: "anna@example.com" },
        { name: null, address: "team@example.com" },
      ],
      cc: [{ name: "Jürg Grün", address: "juerg@example.com" }],
      subject: "Angebot für Projekt",
      bodyText: "Hallo Anna, bitte bis Freitag.",
      remoteContentBlocked: 1,
      snippet: "Hallo Anna, bitte bis Freitag.",
      attachments: [],
      truncated: false,
    });
    expect(result.sentAt?.toISOString()).toBe("2026-10-22T08:15:00.000Z");
    expect(result.bodyHtmlSanitized).toBe("<p>Hallo <b>Anna</b>, bitte bis Freitag.</p>");
    expect(result.sizeBytes).toBe(Buffer.byteLength(raw));
  });

  it("erzeugt lesbaren Text aus HTML, wenn kein text/plain existiert – ohne Skript- oder Bildinhalt", async () => {
    const html = `<html><head><title>Newsletter</title><style>p{}</style></head><body><h1>Rechnung 42</h1><p>Bitte bis <strong>30.10.</strong> zahlen.</p><script>evil()</script><img src="https://cdn.example.com/x.png" alt="Logo"><p><a href="https://example.org/pay">Jetzt zahlen</a></p></body></html>`;
    const result = await processMime(mime({}, html, "text/html; charset=utf-8"));
    expect(result.bodyText).toBe("Rechnung 42\n\nBitte bis 30.10. zahlen.\n\nJetzt zahlen [https://example.org/pay]");
    expect(result.bodyText).not.toMatch(/Newsletter|evil|Logo/);
    expect(result.remoteContentBlocked).toBe(1);
  });

  it("speichert von Anhängen nur Metadaten (Name, Typ, Größe, inline)", async () => {
    const pdf = Buffer.alloc(3000, 7).toString("base64").replace(/(.{76})/g, "$1\r\n");
    const png = Buffer.alloc(120, 1).toString("base64");
    const raw = [
      "From: max@example.org",
      "To: anna@example.com",
      "Subject: Unterlagen",
      "Message-ID: <att-1@example.org>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="mix"',
      "",
      "--mix",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      "--rel",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Siehe Anhang <img src="cid:logo@example.org"></p>',
      "--rel",
      "Content-Type: image/png",
      "Content-ID: <logo@example.org>",
      "Content-Disposition: inline",
      "Content-Transfer-Encoding: base64",
      "",
      png,
      "--rel--",
      "--mix",
      'Content-Type: application/pdf; name="angebot.pdf"',
      'Content-Disposition: attachment; filename="angebot.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdf,
      "--mix--",
      "",
    ].join("\r\n");
    const result = await processMime(raw);
    expect(result.attachments).toEqual([
      { filename: null, contentType: "image/png", size: 120, inline: true },
      { filename: "angebot.pdf", contentType: "application/pdf", size: 3000, inline: false },
    ]);
    expect(JSON.stringify(result)).not.toContain(pdf.slice(0, 40));
    expect(result.bodyText).toBe("Siehe Anhang");
  });

  it("berechnet stabile Fingerprints: contentHash über normalisierten Text, headersFingerprint über From/Date/Subject/Message-ID", async () => {
    const a = await processMime(mime({}, "Bitte  bis Freitag\r\n\r\n\r\nzahlen."));
    const b = await processMime(mime({ To: "Jemand <other@example.com>" }, "Bitte bis Freitag\n\nzahlen.  "));
    const c = await processMime(mime({ Subject: "Anderes Thema" }, "Bitte bis Freitag zahlen."));
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toBe(computeContentHash("Bitte bis Freitag zahlen."));
    expect(a.headersFingerprint).toBe(b.headersFingerprint);
    expect(c.headersFingerprint).not.toBe(a.headersFingerprint);
    expect(c.contentHash).toBe(a.contentHash);

    // An unparseable Date must not turn into "now" (mailparser default) and change the fingerprint.
    const first = await processMime(mime({ Date: "kein Datum", "Message-ID": "" }, "x"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await processMime(mime({ Date: "kein Datum", "Message-ID": "" }, "x"));
    expect(first.sentAt).toBeNull();
    expect(first.rfcMessageId).toBeNull();
    expect(first.headersFingerprint).toBe(second.headersFingerprint);
  });

  it("beachtet maxMessageBytes: kürzt, setzt truncated und meldet die volle Größe", async () => {
    const long = `${"Erster Absatz mit Inhalt. ".repeat(20)}\r\n\r\nSPÄTER: ${"x".repeat(5000)}`;
    const raw = mime({}, long);
    const result = await processMime(raw, { maxMessageBytes: 600 });
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(Buffer.byteLength(raw));
    expect(result.bodyText.startsWith("Erster Absatz")).toBe(true);
    expect(result.bodyText).not.toContain("SPÄTER");
    const partial = await processMime(raw.slice(0, 500), { maxMessageBytes: 600, sizeBytes: 99_999, truncated: true });
    expect(partial).toMatchObject({ truncated: true, sizeBytes: 99_999 });
    expect((await processMime(raw, { maxMessageBytes: 1_000_000 })).truncated).toBe(false);
  });

  it("normalisiert Message-IDs", () => {
    expect(normalizeMessageId(" <A1@example.org> ")).toBe("A1@example.org");
    expect(normalizeMessageId("A1@example.org")).toBe("A1@example.org");
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
  });
});

describe("reduceForAnalysis", () => {
  it("de: Apple-Mail-Zitat, Signatur mit „-- “ und Grußblock", () => {
    const text = [
      "Hallo Max,",
      "danke, ich schicke das Angebot bis Freitag.",
      "",
      "Viele Grüße",
      "Anna",
      "-- ",
      "Anna Beispiel | Beispiel AG | Tel. +41 00 000 00 00",
      "",
      "Am 21.10.2026 um 09:12 schrieb Max Muster <max@example.org>:",
      "> Hallo Anna,",
      "> kannst du bis Freitag das Angebot schicken?",
      ">",
      "> Danke",
      "> Max",
      ">",
      "> Am 20.10.2026 um 08:00 schrieb Anna Beispiel <anna@example.com>:",
      ">> Hier der Entwurf.",
    ].join("\n");
    expect(reduceForAnalysis(text, { maxChars: 2000 })).toEqual({
      text: "Hallo Max,\ndanke, ich schicke das Angebot bis Freitag.",
      quotedContext: "Am 21.10.2026 um 09:12 schrieb Max Muster <max@example.org>:\nHallo Anna,\nkannst du bis Freitag das Angebot schicken?",
      signatureRemoved: true,
      truncated: false,
    });
  });

  it("de: umbrochene Gmail-Zuschreibung und Outlook-Kopfblock („Von:/Gesendet:/An:/Betreff:“)", () => {
    const gmail = "Passt.\n\nAm Mi., 21. Okt. 2026 um 09:12 Uhr schrieb Max Muster <\nmax@example.org>:\n> Termin am Montag?";
    expect(reduceForAnalysis(gmail, { maxChars: 500 })).toMatchObject({
      text: "Passt.",
      quotedContext: "Am Mi., 21. Okt. 2026 um 09:12 Uhr schrieb Max Muster <\nmax@example.org>:\nTermin am Montag?",
    });
    const outlook = [
      "Erledigt, siehe Anhang.",
      "",
      "Mit freundlichen Grüßen",
      "Anna Beispiel",
      "Beispiel AG",
      "",
      "Von: Max Muster <max@example.org>",
      "Gesendet: Mittwoch, 21. Oktober 2026 09:12",
      "An: Anna Beispiel <anna@example.com>",
      "Betreff: Rechnung",
      "",
      "Hallo Anna,",
      "bitte die Rechnung 42 bis Ende Monat prüfen.",
      "",
      "Viele Grüße",
      "Max",
      "",
      "Von: Anna Beispiel <anna@example.com>",
      "Gesendet: Dienstag, 20. Oktober 2026 08:00",
      "An: Max Muster <max@example.org>",
      "Betreff: Rechnung",
      "",
      "Ältere Nachricht",
    ].join("\n");
    const reduced = reduceForAnalysis(outlook, { maxChars: 2000 });
    expect(reduced.text).toBe("Erledigt, siehe Anhang.");
    expect(reduced.signatureRemoved).toBe(true);
    expect(reduced.quotedContext).toBe(
      "Von: Max Muster <max@example.org>\nGesendet: Mittwoch, 21. Oktober 2026 09:12\nAn: Anna Beispiel <anna@example.com>\nBetreff: Rechnung\n\nHallo Anna,\nbitte die Rechnung 42 bis Ende Monat prüfen.",
    );
  });

  it("en: „On … wrote:“, englischer Outlook-Kopf und mobile Signatur", () => {
    const reply = "Sounds good, I will send it tomorrow.\n\nBest regards,\nJane\n\nSent from my iPhone\n\nOn Thu, Oct 22, 2026 at 10:15 AM Max Muster <max@example.org> wrote:\n> Could you send the report by Friday?\n> Thanks\n> Max";
    expect(reduceForAnalysis(reply, { maxChars: 500 })).toEqual({
      text: "Sounds good, I will send it tomorrow.",
      quotedContext: "On Thu, Oct 22, 2026 at 10:15 AM Max Muster <max@example.org> wrote:\nCould you send the report by Friday?",
      signatureRemoved: true,
      truncated: false,
    });
    const outlook = "Done.\n\n________________________________\nFrom: Max Muster <max@example.org>\nSent: Thursday, October 22, 2026 10:15 AM\nTo: Jane Doe <jane@example.com>\nSubject: Report\n\nPlease review the report.";
    expect(reduceForAnalysis(outlook, { maxChars: 500 })).toMatchObject({
      text: "Done.",
      quotedContext: "From: Max Muster <max@example.org>\nSent: Thursday, October 22, 2026 10:15 AM\nTo: Jane Doe <jane@example.com>\nSubject: Report\n\nPlease review the report.",
    });
  });

  it("fr: „Le … a écrit :“ und „Cordialement“", () => {
    const reply = "Merci, je regarde lundi.\n\nCordialement,\nJeanne\n\nLe jeu. 22 oct. 2026 à 10:15, Max Muster <max@example.org> a écrit :\n> Peux-tu valider le devis avant vendredi ?";
    expect(reduceForAnalysis(reply, { maxChars: 500 })).toEqual({
      text: "Merci, je regarde lundi.",
      quotedContext: "Le jeu. 22 oct. 2026 à 10:15, Max Muster <max@example.org> a écrit :\nPeux-tu valider le devis avant vendredi ?",
      signatureRemoved: true,
      truncated: false,
    });
  });

  it("behält Inline-Antworten (Zitat-Ebene 1) und entfernt wiederholte Zitate (Ebene ≥ 2)", () => {
    const inline = "> Kannst du Freitag?\nJa, Freitag passt.\n>> Alte Frage von vor einer Woche\n> Und das Budget?\nBudget ist freigegeben.";
    expect(reduceForAnalysis(inline, { maxChars: 500 })).toMatchObject({
      text: "> Kannst du Freitag?\nJa, Freitag passt.\n> Und das Budget?\nBudget ist freigegeben.",
      quotedContext: null,
    });
  });

  it("behält PS-Zeilen nach dem Gruß und eine Antwort, die nur aus „Danke!“ besteht", () => {
    expect(reduceForAnalysis("Anbei die Liste.\n\nLiebe Grüße\nAnna\n\nPS: Bitte noch die Rechnung schicken.", { maxChars: 500 })).toMatchObject({
      text: "Anbei die Liste.\n\nPS: Bitte noch die Rechnung schicken.",
      signatureRemoved: true,
    });
    expect(reduceForAnalysis("Danke!\n\nAm 21.10.2026 um 09:12 schrieb Max <max@example.org>:\n> Erledigt.", { maxChars: 500 })).toMatchObject({
      text: "Danke!",
      quotedContext: expect.stringContaining("Erledigt."),
      signatureRemoved: false,
    });
  });

  it("nutzt bei reiner Weiterleitung die weitergeleitete Nachricht als Text", () => {
    const forward = "---------- Forwarded message ---------\nFrom: Kunde <kunde@example.org>\nDate: Thu, 22 Oct 2026\nSubject: Auftrag\nTo: Max <max@example.org>\n\nBitte bis 30.10. liefern.";
    expect(reduceForAnalysis(forward, { maxChars: 500 })).toMatchObject({
      text: "From: Kunde <kunde@example.org>\nDate: Thu, 22 Oct 2026\nSubject: Auftrag\nTo: Max <max@example.org>\n\nBitte bis 30.10. liefern.",
      quotedContext: null,
    });
  });

  it("kürzt auf maxChars an einer Satz- oder Wortgrenze und begrenzt den Zitatausschnitt", () => {
    const own = "Erster Satz ist wichtig. ".repeat(10);
    const quoted = `On Thu, Oct 22, 2026 at 10:15 AM Max <max@example.org> wrote:\n> ${"Zitat ".repeat(200)}`;
    const reduced = reduceForAnalysis(`${own}\n\n${quoted}`, { maxChars: 100, maxQuotedChars: 80 });
    expect(reduced.truncated).toBe(true);
    expect(reduced.text.length).toBeLessThanOrEqual(100);
    expect(reduced.text.endsWith(".")).toBe(true);
    expect(reduced.quotedContext?.length).toBeLessThanOrEqual(82);
    expect(reduced.quotedContext?.endsWith("…")).toBe(true);
  });

  it("verwechselt normale Sätze nicht mit Zitatköpfen", () => {
    const text = "Am Montag hat der Kunde angerufen:\nEr möchte das Angebot bis Freitag.";
    expect(reduceForAnalysis(text, { maxChars: 500 })).toMatchObject({ text, quotedContext: null, signatureRemoved: false });
    // Sentence starting with "On"/"Am" plus a digit is not glued to the next line's "wrote:".
    expect(reduceForAnalysis("On Monday we shipped 3 units.\nHere is what the customer wrote:\n> The units arrived damaged.", { maxChars: 500 })).toMatchObject({
      text: "On Monday we shipped 3 units.",
      quotedContext: "Here is what the customer wrote:\nThe units arrived damaged.",
    });
    const noDate = "Am Montag schrieb er mir um 10 Uhr:\nEr braucht das Angebot bis Freitag.";
    expect(reduceForAnalysis(noDate, { maxChars: 500 }).text).toBe(noDate);
    // Typed "Von:/Bis:/Betreff:" lines are no Outlook header block (date, recipient and subject are required).
    const typed = "Urlaubsantrag bitte prüfen:\nVon: Montag\nBis: Freitag\nBetreff: Sommerferien";
    expect(reduceForAnalysis(typed, { maxChars: 500 }).text).toBe(typed);
  });

  it("schneidet nach einleitendem Dank oder Gruß nicht den eigentlichen Auftrag ab", () => {
    expect(reduceForAnalysis("Hallo Max,\n\nvielen Dank!\n\nBitte schick mir noch die Folien bis Freitag.\n\nAnna", { maxChars: 500 }).text).toBe(
      "Hallo Max,\n\nvielen Dank!\n\nBitte schick mir noch die Folien bis Freitag.\n\nAnna",
    );
    expect(reduceForAnalysis("Grüße aus dem Urlaub!\n\nKannst du bitte die Rechnung bezahlen?\n\nAnna", { maxChars: 500 }).text).toContain(
      "Kannst du bitte die Rechnung bezahlen?",
    );
    expect(reduceForAnalysis("Anbei die Liste.\n\nViele Grüße\nAnna\n\nNachtrag: Bitte noch die Rechnung schicken.", { maxChars: 500 })).toMatchObject({
      text: "Anbei die Liste.\n\nNachtrag: Bitte noch die Rechnung schicken.",
      signatureRemoved: true,
    });
    expect(reduceForAnalysis("Thanks!\nSee you at 3pm in the meeting room", { maxChars: 500 }).text).toBe("Thanks!\nSee you at 3pm in the meeting room");
    // Real signature blocks are still removed.
    expect(reduceForAnalysis("Bitte bis Freitag.\n\nBeste Grüße\nDr. Anna Beispiel\nBeispiel AG | Musterstrasse 1\nTel. +41 00 000 00 00\nanna@example.com", { maxChars: 500 })).toMatchObject({
      text: "Bitte bis Freitag.",
      signatureRemoved: true,
    });
  });

  it("„-- “ trennt immer, ein bloßes „--“ nur vor einem Signaturblock", () => {
    expect(reduceForAnalysis("Bitte prüfen.\n-- \nAnna\nDiese E-Mail ist vertraulich und nur für den Empfänger bestimmt.", { maxChars: 500 }).text).toBe("Bitte prüfen.");
    const divider = "Punkt 1: Angebot\n--\nPunkt 2: Bitte bis Freitag die Liste prüfen und zurückschicken.";
    expect(reduceForAnalysis(divider, { maxChars: 500 }).text).toBe(divider);
    expect(reduceForAnalysis("Bitte prüfen.\n--\nAnna Beispiel\nTel. +41 00 000 00 00", { maxChars: 500 }).text).toBe("Bitte prüfen.");
  });

  it("Inline- und Unten-Antworten behalten den eigenen Text und das beantwortete Zitat", () => {
    const bottom = "Am 21.10.2026 um 09:12 schrieb Max Muster <max@example.org>:\n> Kannst du bis Freitag das Angebot schicken?\n\nJa, kommt morgen.\n\nGruß\nAnna";
    expect(reduceForAnalysis(bottom, { maxChars: 500 })).toEqual({
      text: "Am 21.10.2026 um 09:12 schrieb Max Muster <max@example.org>:\n> Kannst du bis Freitag das Angebot schicken?\n\nJa, kommt morgen.",
      quotedContext: null,
      signatureRemoved: true,
      truncated: false,
    });
    const inline =
      "On Thu, Oct 22, 2026 at 10:15 AM Max <max@example.org> wrote:\n> Can you send the file?\nYes, attached.\n> And the invoice?\nI will send it tomorrow.\n>\n> Max\n>> older quote";
    const reduced = reduceForAnalysis(inline, { maxChars: 500 });
    expect(reduced.text).toBe("On Thu, Oct 22, 2026 at 10:15 AM Max <max@example.org> wrote:\n> Can you send the file?\nYes, attached.\n> And the invoice?\nI will send it tomorrow.");
    expect(reduced.quotedContext).toBe("Max");
    // A top-post whose only text after the quote is a signature block stays a top-post.
    const footer = "Erledigt.\n\nAm 21.10.2026 um 09:12 schrieb Max <max@example.org>:\n> Bitte erledigen.\n\nAnna Beispiel | Beispiel AG";
    expect(reduceForAnalysis(footer, { maxChars: 500 })).toMatchObject({ text: "Erledigt.", quotedContext: expect.stringContaining("Bitte erledigen.") });
  });

  it("bleibt linear bei bösartigen Eingaben (ungeschlossene <style>, lange Leerzeichenfolgen)", () => {
    const styles = `<p>x</p>${"<style>a{}".repeat(40_000)}`;
    let started = Date.now();
    expect(processBody({ html: styles }).bodyText).toBe("x");
    expect(Date.now() - started).toBeLessThan(3000);
    const spaces = `a${" ".repeat(1_000_000)}b\n`;
    started = Date.now();
    expect(normalizeText(spaces)).toBe(spaces.trim());
    expect(reduceForAnalysis(`${"Am 1. ".repeat(20)}${"x ".repeat(5000)}\n`.repeat(200), { maxChars: 1000 }).truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
