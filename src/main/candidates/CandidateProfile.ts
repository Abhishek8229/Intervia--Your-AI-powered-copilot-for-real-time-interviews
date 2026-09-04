/**
 * CandidateProfile model (Phase 1) + verified-fact system (Phase 2).
 *
 * Every candidate-specific claim is traceable to source material via
 * VerifiedFact { id, text, category, source, confidence, evidence }.
 * Sources: resume | manual | persona | user-entered | imported.
 * Unknown fields are null/empty — never inferred.
 */

export type FactSource = "resume" | "manual" | "persona" | "user-entered" | "imported";

export type FactCategory =
  | "identity"
  | "experience"
  | "project"
  | "skill"
  | "education"
  | "achievement"
  | "responsibility"
  | "certification"
  | "general";

export interface VerifiedFact {
  id: string;
  text: string;
  category: FactCategory;
  source: FactSource;
  /** 0..1 */
  confidence: number;
  /** Short quote or pointer to the source material. */
  evidence?: string;
}

export interface ExperienceEntry {
  company: string;
  title: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  current?: boolean;
  summary?: string;
  responsibilities: string[];
  technologies: string[];
  achievements: string[];
  /** Where this entry came from (resume/manual/...). */
  source: FactSource;
}

export interface ProjectEntry {
  name: string;
  description?: string;
  role?: string;
  technologies: string[];
  responsibilities: string[];
  challenges: string[];
  outcomes: string[];
  metrics: string[];
  source: FactSource;
}

export interface EducationEntry {
  institution: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  grade?: string;
  source: FactSource;
}

export interface ContactInfo {
  email?: string;
  phone?: string;
  location?: string;
  links: string[];
}

export interface ProfileSourceMetadata {
  origin: FactSource | "empty";
  fileName?: string;
  fileKind?: "pdf" | "docx" | "txt" | "manual" | "imported";
  importedAt?: number;
  notes?: string;
}

export interface CandidateProfile {
  id: string;
  name: string;
  headline?: string;
  yearsExperience?: number;
  location?: string;
  contact: ContactInfo;
  summary?: string;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  skills: string[];
  technologies: string[];
  projects: ProjectEntry[];
  achievements: string[];
  responsibilities: string[];
  certifications: string[];
  languages: string[];
  verifiedFacts: VerifiedFact[];
  sourceMetadata: ProfileSourceMetadata;
  createdAt: number;
  updatedAt: number;
}

let __counter = 0;
export function nextProfileId(prefix = "prof"): string {
  __counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${__counter.toString(36)}`;
}

export function emptyProfile(name = "Untitled Candidate"): CandidateProfile {
  const now = Date.now();
  return {
    id: nextProfileId(),
    name,
    contact: { links: [] },
    education: [],
    experience: [],
    skills: [],
    technologies: [],
    projects: [],
    achievements: [],
    responsibilities: [],
    certifications: [],
    languages: [],
    verifiedFacts: [],
    sourceMetadata: { origin: "empty" },
    createdAt: now,
    updatedAt: now,
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isNonEmptyString).map((s) => String(s));
}

/**
 * Validate + normalize unknown input into a CandidateProfile-shaped object.
 * Returns { profile, errors }. Never throws on malformed input; unknown
 * fields are dropped, missing fields become empty (no hallucination).
 */
export function validateProfile(input: unknown): { profile: CandidateProfile; errors: string[] } {
  const errors: string[] = [];
  const base = emptyProfile();
  if (!input || typeof input !== "object") {
    return { profile: base, errors: ["profile must be an object"] };
  }
  const o = input as Record<string, unknown>;
  const p: CandidateProfile = { ...base, contact: { links: [] }, sourceMetadata: { origin: "empty" } };
  if (isNonEmptyString(o["id"])) p.id = String(o["id"]);
  if (!isNonEmptyString(o["name"])) {
    errors.push("name is required");
  } else {
    p.name = String(o["name"]).trim().slice(0, 200);
  }
  if (isNonEmptyString(o["headline"])) p.headline = String(o["headline"]).trim().slice(0, 300);
  if (typeof o["yearsExperience"] === "number" && Number.isFinite(o["yearsExperience"])) {
    p.yearsExperience = Math.max(0, Math.min(80, o["yearsExperience"] as number));
  } else if (o["yearsExperience"] !== undefined && o["yearsExperience"] !== null) {
    errors.push("yearsExperience must be a number");
  }
  if (isNonEmptyString(o["location"])) p.location = String(o["location"]).trim().slice(0, 200);
  if (isNonEmptyString(o["summary"])) p.summary = String(o["summary"]).trim().slice(0, 4000);
  if (o["contact"] && typeof o["contact"] === "object") {
    const c = o["contact"] as Record<string, unknown>;
    if (isNonEmptyString(c["email"])) p.contact.email = String(c["email"]).trim().slice(0, 200);
    if (isNonEmptyString(c["phone"])) p.contact.phone = String(c["phone"]).trim().slice(0, 100);
    if (isNonEmptyString(c["location"])) p.contact.location = String(c["location"]).trim().slice(0, 200);
    p.contact.links = strArray(c["links"]).slice(0, 20);
  }
  p.education = normalizeEducation(o["education"], errors);
  p.experience = normalizeExperience(o["experience"], errors);
  p.projects = normalizeProjects(o["projects"], errors);
  p.skills = strArray(o["skills"]).slice(0, 200);
  p.technologies = strArray(o["technologies"]).slice(0, 200);
  p.achievements = strArray(o["achievements"]).slice(0, 100);
  p.responsibilities = strArray(o["responsibilities"]).slice(0, 100);
  p.certifications = strArray(o["certifications"]).slice(0, 100);
  p.languages = strArray(o["languages"]).slice(0, 50);
  p.verifiedFacts = normalizeFacts(o["verifiedFacts"], errors);
  if (o["sourceMetadata"] && typeof o["sourceMetadata"] === "object") {
    const s = o["sourceMetadata"] as Record<string, unknown>;
    const origin = s["origin"];
    if (origin === "resume" || origin === "manual" || origin === "persona" || origin === "user-entered" || origin === "imported" || origin === "empty") {
      p.sourceMetadata.origin = origin;
    }
    if (isNonEmptyString(s["fileName"])) p.sourceMetadata.fileName = String(s["fileName"]).slice(0, 300);
    const fk = s["fileKind"];
    if (fk === "pdf" || fk === "docx" || fk === "txt" || fk === "manual" || fk === "imported") p.sourceMetadata.fileKind = fk;
    if (typeof s["importedAt"] === "number") p.sourceMetadata.importedAt = s["importedAt"] as number;
  }
  if (typeof o["createdAt"] === "number") p.createdAt = o["createdAt"] as number;
  p.updatedAt = typeof o["updatedAt"] === "number" ? (o["updatedAt"] as number) : Date.now();
  return { profile: p, errors };
}

function asSource(v: unknown): FactSource {
  return v === "resume" || v === "manual" || v === "persona" || v === "user-entered" || v === "imported"
    ? v
    : "manual";
}

function normalizeEducation(v: unknown, errors: string[]): EducationEntry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("education must be an array");
    return [];
  }
  return v.slice(0, 50).map((e) => {
    const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    return {
      institution: isNonEmptyString(o["institution"]) ? String(o["institution"]).trim().slice(0, 300) : "",
      degree: isNonEmptyString(o["degree"]) ? String(o["degree"]).trim().slice(0, 300) : undefined,
      field: isNonEmptyString(o["field"]) ? String(o["field"]).trim().slice(0, 300) : undefined,
      startDate: isNonEmptyString(o["startDate"]) ? String(o["startDate"]).trim().slice(0, 50) : undefined,
      endDate: isNonEmptyString(o["endDate"]) ? String(o["endDate"]).trim().slice(0, 50) : undefined,
      grade: isNonEmptyString(o["grade"]) ? String(o["grade"]).trim().slice(0, 100) : undefined,
      source: asSource(o["source"]),
    };
  }).filter((e) => e.institution.length > 0);
}

function normalizeExperience(v: unknown, errors: string[]): ExperienceEntry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("experience must be an array");
    return [];
  }
  return v.slice(0, 50).map((e) => {
    const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    return {
      company: isNonEmptyString(o["company"]) ? String(o["company"]).trim().slice(0, 300) : "",
      title: isNonEmptyString(o["title"]) ? String(o["title"]).trim().slice(0, 300) : "",
      location: isNonEmptyString(o["location"]) ? String(o["location"]).trim().slice(0, 200) : undefined,
      startDate: isNonEmptyString(o["startDate"]) ? String(o["startDate"]).trim().slice(0, 50) : undefined,
      endDate: isNonEmptyString(o["endDate"]) ? String(o["endDate"]).trim().slice(0, 50) : undefined,
      current: o["current"] === true,
      summary: isNonEmptyString(o["summary"]) ? String(o["summary"]).trim().slice(0, 2000) : undefined,
      responsibilities: strArray(o["responsibilities"]).slice(0, 100),
      technologies: strArray(o["technologies"]).slice(0, 100),
      achievements: strArray(o["achievements"]).slice(0, 100),
      source: asSource(o["source"]),
    };
  }).filter((e) => e.company.length > 0 || e.title.length > 0);
}

function normalizeProjects(v: unknown, errors: string[]): ProjectEntry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("projects must be an array");
    return [];
  }
  return v.slice(0, 50).map((e) => {
    const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    return {
      name: isNonEmptyString(o["name"]) ? String(o["name"]).trim().slice(0, 300) : "",
      description: isNonEmptyString(o["description"]) ? String(o["description"]).trim().slice(0, 2000) : undefined,
      role: isNonEmptyString(o["role"]) ? String(o["role"]).trim().slice(0, 300) : undefined,
      technologies: strArray(o["technologies"]).slice(0, 100),
      responsibilities: strArray(o["responsibilities"]).slice(0, 100),
      challenges: strArray(o["challenges"]).slice(0, 100),
      outcomes: strArray(o["outcomes"]).slice(0, 100),
      metrics: strArray(o["metrics"]).slice(0, 100),
      source: asSource(o["source"]),
    };
  }).filter((e) => e.name.length > 0);
}

const FACT_CATEGORIES: FactCategory[] = ["identity", "experience", "project", "skill", "education", "achievement", "responsibility", "certification", "general"];

function normalizeFacts(v: unknown, errors: string[]): VerifiedFact[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push("verifiedFacts must be an array");
    return [];
  }
  return v.slice(0, 500).map((f) => {
    const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const category: FactCategory = FACT_CATEGORIES.includes(o["category"] as FactCategory)
      ? (o["category"] as FactCategory)
      : "general";
    let confidence = 0.5;
    if (typeof o["confidence"] === "number" && Number.isFinite(o["confidence"] as number)) {
      confidence = Math.max(0, Math.min(1, o["confidence"] as number));
    }
    return {
      id: isNonEmptyString(o["id"]) ? String(o["id"]) : nextProfileId("fact"),
      text: isNonEmptyString(o["text"]) ? String(o["text"]).trim().slice(0, 1000) : "",
      category,
      source: asSource(o["source"]),
      confidence,
      evidence: isNonEmptyString(o["evidence"]) ? String(o["evidence"]).trim().slice(0, 1000) : undefined,
    };
  }).filter((f) => f.text.length > 0);
}

/**
 * Remove previously generated user-entered facts in editor-managed
 * categories (called before re-deriving them from edited fields, so
 * repeated saves cannot pile duplicates). Resume-sourced facts are never
 * touched. Returns the number removed.
 */
export function pruneManagedUserFacts(profile: CandidateProfile): number {
  const managed = new Set(["skill", "achievement", "responsibility", "certification", "general", "identity", "experience", "project"]);
  const before = (profile.verifiedFacts || []).length;
  profile.verifiedFacts = (profile.verifiedFacts || []).filter(
    (f) => !(f.source === "user-entered" && managed.has(String(f.category || "")))
  );
  return before - profile.verifiedFacts.length;
}

/** Append a verified fact; returns the new fact. */
export function addVerifiedFact(
  profile: CandidateProfile,
  fact: { text: string; category?: FactCategory; source: FactSource; confidence?: number; evidence?: string }
): VerifiedFact {
  const f: VerifiedFact = {
    id: nextProfileId("fact"),
    text: fact.text.trim().slice(0, 1000),
    category: fact.category || "general",
    source: fact.source,
    confidence: typeof fact.confidence === "number" ? Math.max(0, Math.min(1, fact.confidence)) : 0.7,
    evidence: fact.evidence?.trim().slice(0, 1000),
  };
  profile.verifiedFacts.push(f);
  profile.updatedAt = Date.now();
  return f;
}

/** Compact human-readable summary for UI lists. */
export function profileSummary(p: CandidateProfile): string {
  const bits: string[] = [p.name];
  if (p.headline) bits.push(p.headline);
  if (typeof p.yearsExperience === "number") bits.push(`${p.yearsExperience} yrs`);
  if (p.experience.length > 0) bits.push(`${p.experience.length} roles`);
  if (p.skills.length > 0) bits.push(p.skills.slice(0, 5).join(", "));
  return bits.join(" · ");
}
