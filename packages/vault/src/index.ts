import { Entry } from "@napi-rs/keyring";

import { SecretName } from "@mrog/shared";

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
      to.set(name, value);
      from.delete(name);
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

  get(name: string): string | null {
    return this.has(name) ? this.backend.get(SecretName.parse(name)) : null;
  }

  set(name: string, value: string): void {
    this.backend.set(SecretName.parse(name), value);
    if (!this.has(name)) this.index.save([...this.index.load(), name]);
  }

  /** Returns false when no secret had this name. */
  delete(name: string): boolean {
    if (!this.has(name)) return false;
    this.backend.delete(SecretName.parse(name));
    this.index.save(this.index.load().filter((existing) => existing !== name));
    return true;
  }
}
