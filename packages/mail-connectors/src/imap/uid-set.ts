/** Upper bound for a decoded set; protects against corrupted or hostile cursors. */
const MAX_UIDS = 500_000;
const MAX_UID = 4_294_967_295;

/** Set of IMAP UIDs, serialized as a compact sequence set ("1:5,7,9:12"). */
export class UidSet {
  private readonly uids = new Set<number>();

  static parse(text: string): UidSet | null {
    const set = new UidSet();
    if (text.trim() === "") return set;
    for (const part of text.split(",")) {
      const match = /^(\d+)(?::(\d+))?$/.exec(part.trim());
      if (!match) return null;
      const start = Number(match[1]);
      const end = match[2] === undefined ? start : Number(match[2]);
      if (start < 1 || end < start || end > MAX_UID || set.size + (end - start + 1) > MAX_UIDS) return null;
      for (let uid = start; uid <= end; uid++) set.uids.add(uid);
    }
    return set;
  }

  static from(values: Iterable<number>): UidSet {
    const set = new UidSet();
    for (const value of values) set.add(value);
    return set;
  }

  get size(): number {
    return this.uids.size;
  }

  has(uid: number): boolean {
    return this.uids.has(uid);
  }

  add(uid: number): void {
    if (Number.isInteger(uid) && uid >= 1 && uid <= MAX_UID) this.uids.add(uid);
  }

  delete(uid: number): void {
    this.uids.delete(uid);
  }

  sorted(): number[] {
    return [...this.uids].sort((a, b) => a - b);
  }

  toString(): string {
    return toSequenceSet(this.sorted());
  }

  /** Sequence-set strings of at most `maxLength` characters each, for SEARCH/FETCH commands. */
  chunks(maxLength = 2000): string[] {
    return chunkSequenceSet(this.sorted(), maxLength);
  }
}

function ranges(sorted: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const uid of sorted) {
    const last = out[out.length - 1];
    if (last && uid === last[1] + 1) last[1] = uid;
    else if (!last || uid > last[1]) out.push([uid, uid]);
  }
  return out;
}

function formatRange([start, end]: [number, number]): string {
  return start === end ? String(start) : `${start}:${end}`;
}

export function toSequenceSet(sorted: number[]): string {
  return ranges(sorted).map(formatRange).join(",");
}

export function chunkSequenceSet(sorted: number[], maxLength = 2000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const range of ranges(sorted)) {
    const part = formatRange(range);
    if (current && current.length + part.length + 1 > maxLength) {
      chunks.push(current);
      current = part;
    } else {
      current = current ? `${current},${part}` : part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
