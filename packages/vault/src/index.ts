import { randomBytes } from "node:crypto";

import { Entry } from "@napi-rs/keyring";

import { MAX_SECRET_LENGTH, SecretName, SECRET_TOO_LONG } from "@mrog/shared";

/** Where secret values live. Values never leave this layer except to the code that uses them. */
export interface SecretBackend {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/** Remembers which names exist, since OS keychains can't list one app's entries portably. */
export interface NameIndex {
  load(): string[];
  save(names: string[]): void;
}

/** Thrown by `Vault.set` for a value the keychain can't be trusted to hold. */
export class SecretTooLongError extends Error {
  readonly code = "secret_too_long";
  constructor() {
    super(SECRET_TOO_LONG);
  }
}

/**
 * How much of a long value goes in one keychain entry; well under `MAX_SECRET_LENGTH`. A value that runs longer (a
 * connected app's sign-in with big tokens) is kept as several entries: the value's own name holds a short note
 * `freebird-parts:<id>:<count>`, and the pieces sit under `<name>#<id>.<n>`. A name with `#` can't be a SecretName, so a
 * piece is never mistaken for a secret of its own, and it stays out of the name index.
 */
const PIECE_LENGTH = 1000;
const NOTE = /^freebird-parts:([0-9a-f]{6}):(\d{1,3})$/;

const pieceName = (name: string, id: string, n: number) => `${name}#${id}.${n}`;

function readNote(value: string | null): { id: string; count: number } | null {
  const found = value === null ? null : NOTE.exec(value);
  return found ? { id: found[1]!, count: Number(found[2]) } : null;
}

/** Cuts text into pieces that fit an entry, never between the two halves of a character. */
function cut(value: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + PIECE_LENGTH, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(value.slice(at, end));
    at = end;
  }
  return pieces;
}

/** The OS keychain: Windows Credential Manager, macOS Keychain, or the Linux Secret Service. */
export class KeyringBackend implements SecretBackend {
  constructor(private readonly service: string) {}

  get(name: string): string | null {
    return new Entry(this.service, name).getPassword() ?? null;
  }

  set(name: string, value: string): void {
    new Entry(this.service, name).setPassword(value);
  }

  delete(name: string): void {
    new Entry(this.service, name).deletePassword();
  }
}

/**
 * Moves the named secrets from one backend to another (after the app's keychain name changed). A secret already in
 * `to` is left as it is; one that can't be read or written stays where it was. Returns how many moved.
 */
export function moveSecrets(names: string[], from: SecretBackend, to: SecretBackend): number {
  let moved = 0;
  for (const name of names) {
    try {
      if (to.get(name) !== null) continue;
      const value = from.get(name);
      if (value === null) continue;
      // A long value's pieces go first, so the note is never moved ahead of what it points to.
      const note = readNote(value);
      const pieces = note ? Array.from({ length: note.count }, (_, n) => pieceName(name, note.id, n)) : [];
      const texts = pieces.map((piece) => from.get(piece));
      if (texts.some((text) => text === null)) continue;
      pieces.forEach((piece, n) => to.set(piece, texts[n]!));
      to.set(name, value);
      from.delete(name);
      for (const piece of pieces) from.delete(piece);
      moved += 1;
    } catch {
      // Left under the old name; the user can save it again.
    }
  }
  return moved;
}

/** For tests and for running without a keychain; nothing is persisted. */
export class MemoryBackend implements SecretBackend {
  private readonly values = new Map<string, string>();
  get(name: string) {
    return this.values.get(name) ?? null;
  }
  set(name: string, value: string) {
    this.values.set(name, value);
  }
  delete(name: string) {
    this.values.delete(name);
  }
}

export class Vault {
  constructor(
    private readonly backend: SecretBackend,
    private readonly index: NameIndex,
  ) {}

  names(): string[] {
    return this.index.load().toSorted();
  }

  has(name: string): boolean {
    return this.index.load().includes(name);
  }

  /** The whole value, with a long one's pieces put back together. */
  get(name: string): string | null {
    if (!this.has(name)) return null;
    const value = this.backend.get(SecretName.parse(name));
    const note = readNote(value);
    if (!note) return value;
    const pieces = Array.from({ length: note.count }, (_, n) =>
      this.backend.get(pieceName(name, note.id, n)),
    );
    // A piece gone: hand back what is there rather than a value with a hole in it.
    return pieces.some((piece) => piece === null) ? value : pieces.join("");
  }

  /** Throws `SecretTooLongError` for a value over `MAX_SECRET_LENGTH`; `setLong` keeps those. */
  set(name: string, value: string): void {
    if (value.length > MAX_SECRET_LENGTH) throw new SecretTooLongError();
    const old = this.noteOf(name);
    this.backend.set(SecretName.parse(name), value);
    this.dropPieces(name, old);
    if (!this.has(name)) this.index.save([...this.index.load(), name]);
  }

  /** Like `set`, for a value of any length: past `MAX_SECRET_LENGTH` it is kept as several entries. */
  setLong(name: string, value: string): void {
    if (value.length <= MAX_SECRET_LENGTH) return this.set(name, value);
    SecretName.parse(name);
    const old = this.noteOf(name);
    const id = randomBytes(3).toString("hex");
    const pieces = cut(value);
    let written = 0;
    try {
      for (const piece of pieces) {
        this.backend.set(pieceName(name, id, written), piece);
        written += 1;
      }
      this.backend.set(name, `freebird-parts:${id}:${pieces.length}`);
    } catch (error) {
      // The old value is still whole; take back what was added.
      this.dropPieces(name, { id, count: written });
      throw error;
    }
    this.dropPieces(name, old);
    if (!this.has(name)) this.index.save([...this.index.load(), name]);
  }

  /** Returns false when no secret had this name. */
  delete(name: string): boolean {
    if (!this.has(name)) return false;
    this.dropPieces(name, this.noteOf(name));
    this.backend.delete(SecretName.parse(name));
    this.index.save(this.index.load().filter((existing) => existing !== name));
    return true;
  }

  /** Which pieces a long value is in, if it is one. */
  private noteOf(name: string): { id: string; count: number } | null {
    try {
      return readNote(this.backend.get(SecretName.parse(name)));
    } catch {
      return null;
    }
  }

  /** Deletes a long value's pieces; one already gone is not an error. */
  private dropPieces(name: string, note: { id: string; count: number } | null) {
    for (let n = 0; note && n < note.count; n++) {
      try {
        this.backend.delete(pieceName(name, note.id, n));
      } catch {
        // already gone
      }
    }
  }
}
