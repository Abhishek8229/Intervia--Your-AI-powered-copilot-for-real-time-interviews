/**
 * Local JSON persistence for profiles, personas, JDs, and app selection
 * state (Phases 6, 8, 12). Atomic writes (tmp + rename). No raw audio or
 * screenshots are ever stored — only structured text/metadata.
 */

import * as fs from "fs";
import * as path from "path";
import { CandidateProfile, validateProfile } from "./CandidateProfile";
import { Persona, validatePersona } from "./Persona";
import { JobDescription, validateJD } from "./JobDescription";
import { logger } from "../logger";

export class JsonFileStorage {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  read<T>(name: string, fallback: T): T {
    try {
      if (!fs.existsSync(this.file(name))) return fallback;
      return JSON.parse(fs.readFileSync(this.file(name), "utf8")) as T;
    } catch (e) {
      logger.warn(`Storage read failed (${name})`, String(e));
      return fallback;
    }
  }

  write(name: string, value: unknown): void {
    const tmp = this.file(name + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, this.file(name));
  }

  remove(name: string): void {
    try {
      fs.unlinkSync(this.file(name));
    } catch {
      // ignore
    }
  }

  list(prefix: string, suffix: string): string[] {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.startsWith(prefix) && f.endsWith(suffix));
    } catch {
      return [];
    }
  }
}

function sanitizeId(id: string): string {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120) || "item";
}

export interface AppSelectionState {
  activeProfileId?: string;
  activePersonaId?: string;
  activeJDId?: string;
  candidateMode?: "real" | "mock";
  /** Persisted audio device selections ("default" = Windows/default device). */
  selectedMicrophoneId?: string;
  selectedOutputDeviceId?: string;
  /** Spoken answer length preference (Setup UI). */
  answerLength?: "short" | "medium" | "detailed";
}

export class ProfileStore {
  private storage: JsonFileStorage;
  private cache = new Map<string, CandidateProfile>();

  constructor(storage: JsonFileStorage) {
    this.storage = storage;
    this.reload();
  }

  reload(): void {
    this.cache.clear();
    for (const f of this.storage.list("profile-", ".json")) {
      const raw = this.storage.read<unknown>(f, null);
      if (!raw) continue;
      const { profile, errors } = validateProfile(raw);
      if (errors.length > 0 && !profile.name) continue;
      this.cache.set(profile.id, profile);
    }
  }

  list(): CandidateProfile[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): CandidateProfile | null {
    return this.cache.get(id) || null;
  }

  save(profile: CandidateProfile): CandidateProfile {
    const { profile: clean, errors } = validateProfile(profile);
    if (errors.includes("name is required")) throw new Error("profile name is required");
    clean.updatedAt = Date.now();
    this.cache.set(clean.id, clean);
    this.storage.write(`profile-${sanitizeId(clean.id)}.json`, clean);
    return clean;
  }

  delete(id: string): boolean {
    const existed = this.cache.delete(id);
    this.storage.remove(`profile-${sanitizeId(id)}.json`);
    return existed;
  }
}

export class PersonaStore {
  private storage: JsonFileStorage;
  private cache = new Map<string, Persona>();

  constructor(storage: JsonFileStorage) {
    this.storage = storage;
    this.reload();
  }

  reload(): void {
    this.cache.clear();
    for (const f of this.storage.list("persona-", ".json")) {
      const raw = this.storage.read<unknown>(f, null);
      if (!raw) continue;
      const { persona } = validatePersona(raw);
      this.cache.set(persona.id, persona);
    }
  }

  list(): Persona[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Persona | null {
    return this.cache.get(id) || null;
  }

  save(persona: Persona): Persona {
    const { persona: clean, errors } = validatePersona(persona);
    if (errors.includes("name is required")) throw new Error("persona name is required");
    clean.updatedAt = Date.now();
    this.cache.set(clean.id, clean);
    this.storage.write(`persona-${sanitizeId(clean.id)}.json`, clean);
    return clean;
  }

  delete(id: string): boolean {
    const existed = this.cache.delete(id);
    this.storage.remove(`persona-${sanitizeId(id)}.json`);
    return existed;
  }
}

export class JDStore {
  private storage: JsonFileStorage;
  private cache = new Map<string, JobDescription>();

  constructor(storage: JsonFileStorage) {
    this.storage = storage;
    this.reload();
  }

  reload(): void {
    this.cache.clear();
    for (const f of this.storage.list("jd-", ".json")) {
      const raw = this.storage.read<unknown>(f, null);
      if (!raw) continue;
      const { jd } = validateJD(raw);
      this.cache.set(jd.id, jd);
    }
  }

  list(): JobDescription[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): JobDescription | null {
    return this.cache.get(id) || null;
  }

  save(jd: JobDescription): JobDescription {
    const { jd: clean, errors } = validateJD(jd);
    if (errors.includes("title is required")) throw new Error("job title is required");
    clean.updatedAt = Date.now();
    this.cache.set(clean.id, clean);
    this.storage.write(`jd-${sanitizeId(clean.id)}.json`, clean);
    return clean;
  }

  delete(id: string): boolean {
    const existed = this.cache.delete(id);
    this.storage.remove(`jd-${sanitizeId(id)}.json`);
    return existed;
  }
}

const STATE_FILE = "app-selection.json";

export function loadSelection(storage: JsonFileStorage): AppSelectionState {
  return storage.read<AppSelectionState>(STATE_FILE, {});
}

export function saveSelection(storage: JsonFileStorage, state: AppSelectionState): void {
  storage.write(STATE_FILE, state);
}
