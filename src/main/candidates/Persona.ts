/**
 * Persona / mock-candidate model (Phase 9) + grounding safety (Phase 10).
 *
 * A persona carries speaking style + an optional link to a knowledge profile.
 * candidateMode ("real" | "mock") decides what counts as authoritative:
 * - real: resume/manual facts are authoritative; persona supplies STYLE ONLY.
 * - mock: persona-linked profile facts are valid fictional knowledge, and
 *   must be labeled as such so they never leak into real-mode answers.
 */

import { nextProfileId } from "./CandidateProfile";

export type CandidateMode = "real" | "mock";

export interface Persona {
  id: string;
  name: string;
  role?: string;
  experience?: string;
  speakingStyle?: string;
  /** short | medium | detailed — preferred answer length, optional. */
  answerLength?: "short" | "medium" | "detailed";
  personalityNotes?: string;
  /** CandidateProfile id used as this persona's knowledge base. */
  knowledgeProfileId?: string;
  customInstructions?: string;
  createdAt: number;
  updatedAt: number;
}

export function emptyPersona(name = "Untitled Persona"): Persona {
  const now = Date.now();
  return { id: nextProfileId("persona"), name, createdAt: now, updatedAt: now };
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function validatePersona(input: unknown): { persona: Persona; errors: string[] } {
  const errors: string[] = [];
  const base = emptyPersona();
  if (!input || typeof input !== "object") return { persona: base, errors: ["persona must be an object"] };
  const o = input as Record<string, unknown>;
  const p: Persona = { ...base };
  if (nonEmpty(o["id"])) p.id = String(o["id"]);
  if (!nonEmpty(o["name"])) errors.push("name is required");
  else p.name = String(o["name"]).trim().slice(0, 200);
  if (nonEmpty(o["role"])) p.role = String(o["role"]).trim().slice(0, 300);
  if (nonEmpty(o["experience"])) p.experience = String(o["experience"]).trim().slice(0, 300);
  if (nonEmpty(o["speakingStyle"])) p.speakingStyle = String(o["speakingStyle"]).trim().slice(0, 1000);
  const al = o["answerLength"];
  if (al === "short" || al === "medium" || al === "detailed") p.answerLength = al;
  else if (al !== undefined) errors.push("answerLength must be short|medium|detailed");
  if (nonEmpty(o["personalityNotes"])) p.personalityNotes = String(o["personalityNotes"]).trim().slice(0, 2000);
  if (nonEmpty(o["knowledgeProfileId"])) p.knowledgeProfileId = String(o["knowledgeProfileId"]).trim().slice(0, 200);
  if (nonEmpty(o["customInstructions"])) p.customInstructions = String(o["customInstructions"]).trim().slice(0, 2000);
  if (typeof o["createdAt"] === "number") p.createdAt = o["createdAt"] as number;
  p.updatedAt = typeof o["updatedAt"] === "number" ? (o["updatedAt"] as number) : Date.now();
  return { persona: p, errors };
}

/**
 * Persona safety gate (Phase 10). Returns the claims the persona makes that
 * are NOT backed by the given knowledge profile (employer names found in
 * persona text but absent from the profile). In real mode these must be
 * ignored by the prompt layer; in mock mode they are allowed as fiction.
 */
export function findUngroundedPersonaClaims(
  persona: Persona,
  knowledgeTextBlobs: string[]
): string[] {
  const personaText = [persona.role, persona.experience, persona.personalityNotes, persona.customInstructions]
    .filter(nonEmpty)
    .join("\n") as string;
  if (!personaText) return [];
  const knowledge = knowledgeTextBlobs.join("\n").toLowerCase();
  // Employer-like capitalized phrases in persona text.
  const candidates = new Set<string>();
  const re = /\b(?:at|for|with)\s+([A-Z][A-Za-z0-9&.\- ]{2,40})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(personaText)) !== null) {
    const name = m[1].trim().replace(/\s+(as|for|in|on|the)\b.*$/i, "").trim();
    if (name.length >= 3 && !/^(a|the|my|our|this|that)\b/i.test(name)) candidates.add(name);
  }
  return [...candidates].filter((c) => !knowledge.includes(c.toLowerCase()));
}
