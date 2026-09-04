/**
 * Resume -> CandidateProfile structuring (Phases 4-5).
 *
 * Pipeline: raw text -> normalized text -> structured extraction -> profile.
 * - Deterministic parsing is the default (offline, no hallucination).
 * - LLM-assisted extraction is optional and strictly validated: unknown
 *   fields stay empty, invented content is impossible by construction because
 *   every value passes through validateProfile() and facts carry evidence.
 * - If no real LLM is configured, deterministic parsing is used automatically.
 */

import {
  CandidateProfile,
  EducationEntry,
  ExperienceEntry,
  FactSource,
  ProjectEntry,
  VerifiedFact,
  addVerifiedFact,
  emptyProfile,
  nextProfileId,
  validateProfile,
} from "./CandidateProfile";
import { LLMProvider } from "../reasoning/LLMProvider";
import { extractJsonObject } from "../screen/vision";
import { logger } from "../logger";

export interface ExtractionResult {
  profile: CandidateProfile;
  method: "deterministic" | "llm" | "llm-fallback-deterministic";
  warnings: string[];
}

const SECTION_ALIASES: Record<string, string[]> = {
  summary: ["summary", "objective", "profile", "about me", "professional summary"],
  experience: ["experience", "employment", "work history", "professional experience", "work experience"],
  projects: ["projects", "personal projects", "selected projects", "key projects"],
  education: ["education", "academic", "qualifications"],
  skills: ["skills", "technical skills", "technologies", "tech stack", "tools", "competencies", "expertise"],
  certifications: ["certifications", "certification", "licenses", "courses"],
  languages: ["languages", "spoken languages"],
  achievements: ["achievements", "accomplishments", "awards", "honors"],
};

function isHeaderLine(line: string): string | null {
  const t = line.trim().replace(/[:\-–—]+$/, "").trim();
  if (!t || t.length > 60) return null;
  const lower = t.toLowerCase();
  for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.some((a) => lower === a || lower.startsWith(a + " ") === false && lower === a)) return key;
  }
  // ALL CAPS short line is likely a header.
  if (/^[A-Z][A-Z\s&/+,.'()-]{2,50}$/.test(t) && t.split(" ").length <= 5) {
    const l = t.toLowerCase();
    for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
      if (aliases.some((a) => l.includes(a))) return key;
    }
  }
  return null;
}

function splitSections(text: string): { header: Map<string, string[]>; preamble: string[] } {
  const header = new Map<string, string[]>();
  const preamble: string[] = [];
  let current: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const h = isHeaderLine(line);
    if (h) {
      current = h;
      if (!header.has(h)) header.set(h, []);
      continue;
    }
    if (current) header.get(current)!.push(line);
    else if (line) preamble.push(line);
  }
  return { header, preamble };
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const LINK_RE = /(https?:\/\/[^\s)]+|www\.[^\s)]+|[a-z0-9-]+\.(com|io|dev|github\.com|linkedin\.com)[^\s)]*)/i;
const YEARS_RE = /(\d{1,2})\s*\+?\s*years?(?:\s+of)?\s+experience/i;
const DATE_RANGE_RE = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4})\s*(?:-|–|—|to)\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}|present|current|now)/i;
const DEGREE_RE = /\b(bachelor|master|b\.?\s?s\.?|m\.?\s?s\.?|b\.?\s?tech|m\.?\s?tech|ph\.?\s?d|doctorate|associate|diploma|mba|b\.?\s?e\.?)\b/i;
const ROLE_WORDS = /\b(engineer|developer|scientist|analyst|architect|designer|manager|consultant|intern|lead|specialist|administrator|devops|sre|qa|researcher)\b/i;

function splitBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (!l) {
      if (cur.length > 0) {
        blocks.push(cur);
        cur = [];
      }
    } else {
      cur.push(l);
    }
  }
  if (cur.length > 0) blocks.push(cur);
  // If no blank lines at all, treat bullet groups / the whole section as one block.
  return blocks;
}

function splitSkillTokens(s: string): string[] {
  return s
    .split(/[•·|;,\/]+/)
    .map((t) => t.trim().replace(/^[-–—*]\s*/, "").trim())
    .filter((t) => t.length >= 1 && t.length <= 60 && !/^(and|with|using|including)$/i.test(t));
}

function evidenceOf(line: string): string {
  return line.trim().slice(0, 160);
}

/** Deterministic extraction. Never invents: absent sections stay empty. */
export function extractProfileDeterministic(
  normalizedText: string,
  source: { fileName?: string; fileKind?: "pdf" | "docx" | "txt" }
): ExtractionResult {
  const warnings: string[] = [];
  const profile = emptyProfile("Untitled Candidate");
  const { header, preamble } = splitSections(normalizedText || "");
  const factSource: FactSource = "resume";

  // Identity from preamble (name = first plausible line).
  const content = preamble.filter(Boolean);
  if (content.length > 0) {
    const first = content[0];
    if (first.split(" ").length <= 6 && !EMAIL_RE.test(first) && !/\d{4,}/.test(first) && first.length <= 80) {
      profile.name = first;
      profile.verifiedFacts.push(mkFact(`Candidate name: ${first}`, "identity", factSource, 0.7, evidenceOf(first)));
    } else {
      warnings.push("name not confidently detected; left as placeholder");
    }
    const blob = content.slice(0, 8).join("\n");
    const email = blob.match(EMAIL_RE)?.[0];
    if (email) profile.contact.email = email;
    const phone = blob.match(PHONE_RE)?.[0];
    if (phone && phone.replace(/\D/g, "").length >= 7) profile.contact.phone = phone.trim();
    const links = new Set<string>();
    for (const l of content.slice(0, 10)) {
      const m = l.match(LINK_RE)?.[0];
      if (m) links.add(m.trim());
    }
    profile.contact.links = [...links].slice(0, 20);
    if (content.length > 1 && content[1].length <= 120 && ROLE_WORDS.test(content[1])) {
      profile.headline = content[1];
    }
  } else {
    warnings.push("empty resume text; profile left blank");
  }

  const years = normalizedText.match(YEARS_RE)?.[1];
  if (years) profile.yearsExperience = Math.min(80, parseInt(years, 10));

  const summaryLines = header.get("summary") || [];
  if (summaryLines.length > 0) {
    profile.summary = summaryLines.filter(Boolean).join(" ").slice(0, 4000);
  }

  // Skills.
  const skillLines = header.get("skills") || [];
  const skills: string[] = [];
  for (const l of skillLines) {
    if (!l) continue;
    if (l.length > 200) continue; // prose, not a skill list
    skills.push(...splitSkillTokens(l.replace(/^[A-Za-z ]+:\s*/, "")));
  }
  // "Label: a, b, c" lines.
  for (const l of skillLines) {
    const m = l.match(/^([A-Za-z +/#.-]{2,40}):\s*(.+)$/);
    if (m && m[2].length <= 200) skills.push(...splitSkillTokens(m[2]));
  }
  profile.skills = unique(skills).slice(0, 200);
  profile.technologies = unique(skills.filter((s) => /[.#/+]|\b(js|ts|sql|api|aws|css|html|node|react|py|java|go|rust|c\+\+|docker|k8s|kafka|redis|mongo|postgres|graphql|linux|git|azure|gcp|terraform|spark|airflow|pandas|torch|tf)\b/i.test(s))).slice(0, 200);
  for (const s of profile.skills.slice(0, 40)) {
    profile.verifiedFacts.push(mkFact(`Skill: ${s}`, "skill", factSource, 0.65, `skills section: ${s}`));
  }

  // Experience.
  const expLines = header.get("experience") || [];
  for (const block of splitBlocks(expLines)) {
    const entry = parseExperienceBlock(block);
    if (entry) {
      profile.experience.push(entry);
      profile.verifiedFacts.push(
        mkFact(`${entry.title || "Role"} at ${entry.company || "unknown company"}`, "experience", factSource, 0.7, evidenceOf(block[0]))
      );
    }
  }

  // Projects.
  const projLines = header.get("projects") || [];
  for (const block of splitBlocks(projLines)) {
    const entry = parseProjectBlock(block);
    if (entry) {
      profile.projects.push(entry);
      profile.verifiedFacts.push(mkFact(`Project: ${entry.name}`, "project", factSource, 0.7, evidenceOf(block[0])));
    }
  }

  // Education.
  const eduLines = header.get("education") || [];
  for (const block of splitBlocks(eduLines)) {
    const entry = parseEducationBlock(block);
    if (entry) {
      profile.education.push(entry);
      profile.verifiedFacts.push(mkFact(`Education: ${entry.institution}`, "education", factSource, 0.7, evidenceOf(block[0])));
    }
  }

  const certLines = header.get("certifications") || [];
  profile.certifications = unique(certLines.filter((l) => l && l.length <= 160)).slice(0, 100);
  const langLines = header.get("languages") || [];
  profile.languages = unique(langLines.flatMap((l) => splitSkillTokens(l))).slice(0, 50);
  const achLines = header.get("achievements") || [];
  profile.achievements = unique(achLines.filter((l) => l && l.length <= 300)).slice(0, 100);

  profile.sourceMetadata = {
    origin: "resume",
    fileName: source.fileName,
    fileKind: source.fileKind,
    importedAt: Date.now(),
  };
  profile.updatedAt = Date.now();
  return { profile, method: "deterministic", warnings };
}

function parseExperienceBlock(block: string[]): ExperienceEntry | null {
  if (block.length === 0) return null;
  const head = block[0];
  let company = "";
  let title = "";
  // "Title at Company" / "Title, Company" / "Title - Company" / "Title | Company".
  const atMatch = head.match(/^(.{2,80}?)\s+(?:at|@|—|–|-|\||,)\s+(.{2,80})$/);
  if (atMatch && ROLE_WORDS.test(atMatch[1])) {
    title = atMatch[1].trim();
    company = atMatch[2].trim().replace(/\s*\(.*\)\s*$/, "").trim();
  } else if (block.length > 1 && ROLE_WORDS.test(head) && head.length <= 90) {
    title = head;
    company = block[1].replace(/\s*\(.*\)\s*$/, "").trim().slice(0, 120);
  } else if (head.length <= 120) {
    // Ambiguous single line: keep as company, no title (no invention).
    company = head;
  }
  if (!company && !title) return null;
  const blob = block.join("\n");
  const dates = blob.match(DATE_RANGE_RE);
  const bullets = block.slice(1).filter((l) => /^([•·\-–—*]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([•·\-–—*]|\d+[.)])\s+/, "").trim());
  const achievements = bullets.filter((b) => /\d|%|\$|increased|decreased|reduced|improved|launched|led|built|shipped|grew|saved/i.test(b));
  return {
    company,
    title,
    startDate: dates?.[1]?.trim(),
    endDate: dates?.[2]?.trim(),
    current: dates ? /present|current|now/i.test(dates[2]) : undefined,
    responsibilities: bullets.slice(0, 100),
    technologies: [],
    achievements: achievements.slice(0, 100),
    source: "resume",
  };
}

function parseProjectBlock(block: string[]): ProjectEntry | null {
  if (block.length === 0) return null;
  const name = block[0].replace(/^([•·\-–—*]|\d+[.)])\s+/, "").trim().slice(0, 300);
  if (!name || name.length > 200) return null;
  const rest = block.slice(1);
  const bullets = rest.filter((l) => /^([•·\-–—*]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([•·\-–—*]|\d+[.)])\s+/, "").trim());
  const prose = rest.filter((l) => !/^([•·\-–—*]|\d+[.)])\s+/.test(l)).join(" ");
  return {
    name,
    description: prose ? prose.slice(0, 2000) : undefined,
    technologies: [],
    responsibilities: bullets.slice(0, 100),
    challenges: [],
    outcomes: bullets.filter((b) => /\d|%|result|outcome|achieved/i.test(b)).slice(0, 100),
    metrics: bullets.filter((b) => /\d/.test(b)).slice(0, 100),
    source: "resume",
  };
}

function parseEducationBlock(block: string[]): EducationEntry | null {
  if (block.length === 0) return null;
  const blob = block.join(" | ");
  const degree = blob.match(DEGREE_RE)?.[0];
  const instLine = block.find((l) => /university|college|institute|school|academy/i.test(l)) || block[0];
  const institution = instLine.replace(/^([•·\-–—*]|\d+[.)])\s+/, "").trim().slice(0, 300);
  if (!institution) return null;
  const dates = blob.match(DATE_RANGE_RE);
  return {
    institution,
    degree: degree?.trim(),
    field: undefined,
    startDate: dates?.[1]?.trim(),
    endDate: dates?.[2]?.trim(),
    source: "resume",
  };
}

function unique(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (!seen.has(k) && s.trim()) {
      seen.add(k);
      out.push(s.trim());
    }
  }
  return out;
}

function mkFact(text: string, category: VerifiedFact["category"], source: FactSource, confidence: number, evidence: string): VerifiedFact {
  return { id: nextProfileId("fact"), text: text.slice(0, 1000), category, source, confidence, evidence: evidence.slice(0, 1000) };
}

// ---------------------------------------------------------------------------
// LLM-assisted extraction (Phase 5): strict JSON, validated, safe fallback.
// ---------------------------------------------------------------------------

const LLM_EXTRACT_INSTRUCTIONS = [
  "Extract a candidate profile from the resume text below.",
  "RULES: copy wording from the resume; never invent employers, titles, years, technologies, metrics, or achievements;",
  "leave any unknown field empty (empty string, empty array, or null);",
  "attach a short evidence quote from the resume for key facts when possible.",
  'Reply with a single JSON object and nothing else, shaped like:',
  '{"name":"","headline":"","yearsExperience":null,"location":"","summary":"","skills":[],"technologies":[],"experience":[{"company":"","title":"","location":"","startDate":"","endDate":"","current":false,"summary":"","responsibilities":[],"technologies":[],"achievements":[]}],"projects":[{"name":"","description":"","role":"","technologies":[],"responsibilities":[],"challenges":[],"outcomes":[],"metrics":[]}],"education":[{"institution":"","degree":"","field":"","startDate":"","endDate":"}],"achievements":[],"certifications":[],"languages":[]}',
].join(" ");

export async function extractProfileWithLLM(
  normalizedText: string,
  llm: LLMProvider,
  source: { fileName?: string; fileKind?: "pdf" | "docx" | "txt" },
  opts?: { timeoutMs?: number }
): Promise<ExtractionResult> {
  const available = await llm.isAvailable();
  if (!available) {
    const d = extractProfileDeterministic(normalizedText, source);
    return { ...d, method: "llm-fallback-deterministic", warnings: [...d.warnings, "LLM unavailable; used deterministic parsing"] };
  }
  try {
    const res = await llm.generate({
      prompt: `${LLM_EXTRACT_INSTRUCTIONS}\n\nRESUME TEXT:\n${normalizedText.slice(0, 12000)}`,
      system: "You are a precise resume parser. Output JSON only. Never hallucinate.",
      maxTokens: 2000,
    });
    const obj = extractJsonObject(res.text || "");
    if (!obj) throw new Error("LLM did not return JSON");
    const { profile, errors } = validateProfile({
      ...(obj as Record<string, unknown>),
      contact: extractContactFallback(normalizedText),
      sourceMetadata: { origin: "resume", fileName: source.fileName, fileKind: source.fileKind, importedAt: Date.now() },
    });
    if (!profile.name || profile.name === "Untitled Candidate") {
      // Deterministic identity rescue (name/email are regex-safe).
      const d = extractProfileDeterministic(normalizedText, source);
      if (d.profile.name !== "Untitled Candidate") profile.name = d.profile.name;
      if (d.profile.contact.email) profile.contact.email = d.profile.contact.email;
    }
    // Promote structured items into verified facts with evidence.
    for (const e of profile.experience.slice(0, 20)) {
      profile.verifiedFacts.push(mkFact(`${e.title} at ${e.company}`, "experience", "resume", 0.7, `${e.title} at ${e.company}`));
    }
    for (const p of profile.projects.slice(0, 20)) {
      profile.verifiedFacts.push(mkFact(`Project: ${p.name}`, "project", "resume", 0.7, p.name));
    }
    for (const s of profile.skills.slice(0, 40)) {
      profile.verifiedFacts.push(mkFact(`Skill: ${s}`, "skill", "resume", 0.65, s));
    }
    return { profile, method: "llm", warnings: errors };
  } catch (e) {
    logger.warn("LLM profile extraction failed, falling back to deterministic", String(e));
    const d = extractProfileDeterministic(normalizedText, source);
    return { ...d, method: "llm-fallback-deterministic", warnings: [...d.warnings, "LLM extraction failed; used deterministic parsing"] };
  }
}

function extractContactFallback(text: string): Record<string, unknown> {
  const head = text.split("\n").slice(0, 10).join("\n");
  const email = head.match(EMAIL_RE)?.[0];
  const phone = head.match(PHONE_RE)?.[0];
  return { email, phone, links: [] };
}

// ---------------------------------------------------------------------------
// Manual edits (Phase 7): structured patch + user-entered fact trail.
// ---------------------------------------------------------------------------

export interface ProfilePatch {
  name?: string;
  headline?: string;
  yearsExperience?: number;
  summary?: string;
  skills?: string[];
  technologies?: string[];
  achievements?: string[];
  responsibilities?: string[];
  certifications?: string[];
  languages?: string[];
  experience?: ExperienceEntry[];
  projects?: ProjectEntry[];
  education?: EducationEntry[];
}

export function applyProfilePatch(profile: CandidateProfile, patch: ProfilePatch): { addedFacts: VerifiedFact[] } {
  const added: VerifiedFact[] = [];
  const note = (text: string, category: VerifiedFact["category"]): void => {
    added.push(addVerifiedFact(profile, { text, category, source: "user-entered", confidence: 0.95, evidence: "manual edit" }));
  };
  if (typeof patch.name === "string" && patch.name.trim()) {
    profile.name = patch.name.trim().slice(0, 200);
    note(`Candidate name: ${profile.name}`, "identity");
  }
  if (typeof patch.headline === "string") profile.headline = patch.headline.trim().slice(0, 300) || undefined;
  if (typeof patch.yearsExperience === "number" && Number.isFinite(patch.yearsExperience)) {
    profile.yearsExperience = Math.max(0, Math.min(80, patch.yearsExperience));
    note(`Years of experience: ${profile.yearsExperience}`, "general");
  }
  if (typeof patch.summary === "string") profile.summary = patch.summary.trim().slice(0, 4000) || undefined;
  const setList = (key: "skills" | "technologies" | "achievements" | "responsibilities" | "certifications" | "languages", cat: VerifiedFact["category"]): void => {
    const v = patch[key];
    if (Array.isArray(v)) {
      profile[key] = unique(v.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean)).slice(0, 200);
      for (const item of profile[key].slice(0, 20)) note(`${key}: ${item}`, cat);
    }
  };
  setList("skills", "skill");
  setList("technologies", "skill");
  setList("achievements", "achievement");
  setList("responsibilities", "responsibility");
  setList("certifications", "certification");
  setList("languages", "general");
  if (Array.isArray(patch.experience)) {
    const { profile: tmp } = validateProfile({ name: profile.name, experience: patch.experience });
    profile.experience = tmp.experience.map((e) => ({ ...e, source: "user-entered" as FactSource }));
    for (const e of profile.experience.slice(0, 10)) note(`${e.title} at ${e.company}`, "experience");
  }
  if (Array.isArray(patch.projects)) {
    const { profile: tmp } = validateProfile({ name: profile.name, projects: patch.projects });
    profile.projects = tmp.projects.map((p) => ({ ...p, source: "user-entered" as FactSource }));
    for (const p of profile.projects.slice(0, 10)) note(`Project: ${p.name}`, "project");
  }
  if (Array.isArray(patch.education)) {
    const { profile: tmp } = validateProfile({ name: profile.name, education: patch.education });
    profile.education = tmp.education.map((e) => ({ ...e, source: "user-entered" as FactSource }));
  }
  profile.updatedAt = Date.now();
  return { addedFacts: added };
}
