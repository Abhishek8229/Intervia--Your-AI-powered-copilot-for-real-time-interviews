/**
 * JobDescription model (Phase 11) + paste/edit/select input (Phase 12).
 * Missing JD information stays empty — never invented.
 */

import { nextProfileId } from "./CandidateProfile";

export interface JobDescription {
  id: string;
  title: string;
  company?: string;
  location?: string;
  summary?: string;
  responsibilities: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  technologies: string[];
  experienceRequirements: string[];
  qualifications: string[];
  rawText: string;
  createdAt: number;
  updatedAt: number;
}

export function emptyJD(title = "Untitled Role"): JobDescription {
  const now = Date.now();
  return {
    id: nextProfileId("jd"),
    title,
    responsibilities: [],
    requiredSkills: [],
    preferredSkills: [],
    technologies: [],
    experienceRequirements: [],
    qualifications: [],
    rawText: "",
    createdAt: now,
    updatedAt: now,
  };
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function strList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(nonEmpty).map((s) => String(s).trim().slice(0, 500)).filter(Boolean).slice(0, cap);
}

export function validateJD(input: unknown): { jd: JobDescription; errors: string[] } {
  const errors: string[] = [];
  const base = emptyJD();
  if (!input || typeof input !== "object") return { jd: base, errors: ["job description must be an object"] };
  const o = input as Record<string, unknown>;
  const j: JobDescription = { ...base };
  if (nonEmpty(o["id"])) j.id = String(o["id"]);
  if (!nonEmpty(o["title"])) errors.push("title is required");
  else j.title = String(o["title"]).trim().slice(0, 300);
  if (nonEmpty(o["company"])) j.company = String(o["company"]).trim().slice(0, 300);
  if (nonEmpty(o["location"])) j.location = String(o["location"]).trim().slice(0, 300);
  if (nonEmpty(o["summary"])) j.summary = String(o["summary"]).trim().slice(0, 4000);
  j.responsibilities = strList(o["responsibilities"], 100);
  j.requiredSkills = strList(o["requiredSkills"], 200);
  j.preferredSkills = strList(o["preferredSkills"], 200);
  j.technologies = strList(o["technologies"], 200);
  j.experienceRequirements = strList(o["experienceRequirements"], 100);
  j.qualifications = strList(o["qualifications"], 100);
  if (nonEmpty(o["rawText"])) j.rawText = String(o["rawText"]).slice(0, 20000);
  if (typeof o["createdAt"] === "number") j.createdAt = o["createdAt"] as number;
  j.updatedAt = typeof o["updatedAt"] === "number" ? (o["updatedAt"] as number) : Date.now();
  return { jd: j, errors };
}

/**
 * Deterministic structuring of pasted JD text. Section-aware; anything not
 * found stays empty. First non-empty line becomes the title when plausible.
 */
export function parseJobDescriptionText(rawText: string): JobDescription {
  const jd = emptyJD();
  const text = (rawText || "").replace(/\r\n?/g, "\n").trim().slice(0, 20000);
  jd.rawText = text;
  if (!text) return jd;
  const lines = text.split("\n").map((l) => l.trim());
  const content = lines.filter(Boolean);
  if (content.length > 0 && content[0].length <= 140) {
    jd.title = content[0].replace(/^(\W*\s*(job title|position|role)\s*:\s*)/i, "").trim().slice(0, 300) || "Untitled Role";
  }
  const companyLine = content.slice(0, 6).find((l) => /^(company|organization|employer)\s*:/i.test(l));
  if (companyLine) jd.company = companyLine.split(":").slice(1).join(":").trim().slice(0, 300);
  const locLine = content.slice(0, 8).find((l) => /^location\s*:/i.test(l));
  if (locLine) jd.location = locLine.split(":").slice(1).join(":").trim().slice(0, 300);

  let section: "none" | "resp" | "req" | "pref" | "qual" = "none";
  const buckets: Record<string, string[]> = { resp: [], req: [], pref: [], qual: [] };
  const summaryBits: string[] = [];
  for (const l of lines) {
    const lower = l.toLowerCase().replace(/[:\-–—]+$/, "").trim();
    if (/^(responsibilities|what you.ll do|your role|duties)(\s|$)/.test(lower)) { section = "resp"; continue; }
    if (/^(requirements|required skills|must have|required)(\s|$)/.test(lower)) { section = "req"; continue; }
    if (/^(preferred|nice to have|bonus|desired|preferred skills)(\s|$)/.test(lower)) { section = "pref"; continue; }
    if (/^(qualifications|experience|education)(\s|$)/.test(lower)) { section = "qual"; continue; }
    if (!l) continue;
    if (section === "none") {
      if (summaryBits.join(" ").length < 800 && l.length > 20) summaryBits.push(l);
      continue;
    }
    const item = l.replace(/^([•·\-–—*]|\d+[.)])\s+/, "").trim();
    if (item) buckets[section].push(item.slice(0, 500));
  }
  jd.responsibilities = buckets.resp.slice(0, 100);
  jd.requiredSkills = splitSkillish(buckets.req).slice(0, 200);
  jd.preferredSkills = splitSkillish(buckets.pref).slice(0, 200);
  jd.qualifications = buckets.qual.slice(0, 100);
  jd.experienceRequirements = buckets.qual.filter((q) => /year|experience/i.test(q)).slice(0, 100);
  jd.technologies = uniqueTech([...jd.requiredSkills, ...jd.preferredSkills]).slice(0, 200);
  if (summaryBits.length > 0) jd.summary = summaryBits.join(" ").slice(0, 4000);
  jd.updatedAt = Date.now();
  return jd;
}

function splitSkillish(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.length <= 80 && !/\s.{40,}/.test(item)) {
      out.push(...item.split(/[,;|/]+/).map((s) => s.trim()).filter((s) => s.length >= 1 && s.length <= 80));
    } else {
      out.push(item);
    }
  }
  return out;
}

function uniqueTech(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const k = s.toLowerCase();
    if (!seen.has(k) && /[.#/+]|\b(js|ts|sql|api|aws|css|html|node|react|python|java|go|rust|docker|k8s|kafka|redis|mongo|postgres|graphql|linux|git|azure|gcp|terraform|figma|jira)\b/i.test(s)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

export function jdSummary(j: JobDescription): string {
  const bits = [j.title];
  if (j.company) bits.push(j.company);
  if (j.requiredSkills.length > 0) bits.push(j.requiredSkills.slice(0, 5).join(", "));
  return bits.join(" · ");
}
