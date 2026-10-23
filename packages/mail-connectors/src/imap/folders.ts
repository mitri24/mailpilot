import type { FolderRole } from "@mailpilot/contracts";

/** Maps SPECIAL-USE attributes (RFC 6154) – or imapflow's name-based guess – to a folder role. */
export function imapFolderRole(specialUse: string | undefined, path: string): FolderRole {
  if (path.toUpperCase() === "INBOX") return "inbox";
  switch (specialUse?.toLowerCase()) {
    case "\\inbox":
      return "inbox";
    case "\\sent":
      return "sent";
    case "\\trash":
      return "trash";
    case "\\junk":
      return "spam";
    case "\\archive":
      return "archive";
    case "\\drafts":
      return "drafts";
    default:
      return "other";
  }
}
