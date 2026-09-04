/**
 * Deterministic candidate/JD relevance selection (Phase 13).
 * No vector DB, no embeddings: token-overlap scoring + question-type boosts.
 * The reasoning engine receives a compact, question-specific subset — never
 * the whole profile.
 */

import { CandidateProfile, VerifiedFact } from "./CandidateProfile";
import { JobDescription } from "./JobDescription";
import { QuestionType } from "../../common/types";

export interface RelevantContext {
  facts: VerifiedFact[];
  experience: Array<{ company: string; title: string; points: string[] }>;
  projects: Array<{ name: string; points: string[] }>;
  jdPoints: string[];
  summary?: string;
  headline?: string;
  useRecentContext: boolean;
  reasons: string[];
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "at", "by", "for", "with",
  "about", "into", "through", "during", "to", "from", "in", "on", "is", "are", "was",
  "were", "be", "been", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "can", "you", "your", "me", "my", "we", "our", "us", "it", "its",
  "this", "that", "these", "those", "what", "which", "who", "how", "why", "when",
  "where", "there", "here", "tell", "describe", "explain", "walk", "give", "share",
  "kind", "sort", "something", "anything", "much", "many", "very", "really", "just",
  "like", "well", "also",
]);

export function contentTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of (s || "").toLowerCase().replace(/[^a-z0-9+#. ]/g, " ").split(/\s+/)) {
    const t = w.trim();
    if (t.length >= 2 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Small synonym map so "databases" matches PostgreSQL, etc. (deterministic). */
const SYNONYMS: Record<string, string[]> = {
  database: ["databases", "sql", "postgres", "postgresql", "mysql", "mongodb", "mongo", "redis", "sqlite", "db"],
  databases: ["database", "sql", "postgres", "postgresql", "mysql", "mongodb", "mongo", "redis", "sqlite", "db"],
  sql: ["postgres", "postgresql", "mysql", "sqlite", "database"],
  cache: ["caching", "redis", "memcached"],
  caching: ["cache", "redis", "memcached"],
  queue: ["kafka", "rabbitmq", "sqs", "broker", "messaging"],
  backend: ["node", "nodejs", "api", "server", "python", "java", "go"],
  frontend: ["react", "vue", "angular", "css", "html", "typescript", "javascript"],
  cloud: ["aws", "azure", "gcp"],
  container: ["containers", "docker", "kubernetes", "k8s"],
  cicd: ["ci", "cd", "jenkins", "github actions", "pipeline"],
  testing: ["jest", "pytest", "cypress", "unit", "integration"],
  payment: ["payments", "billing", "stripe", "checkout"],
  payments: ["payment", "billing", "stripe", "checkout"],
  latency: ["performance", "p99", "optimization", "tuning"],
  scale: ["scaling", "scalability", "distributed", "sharding", "replica"],
};

export function expandTokens(q: Set<string>): Set<string> {
  const out = new Set(q);
  for (const t of q) {
    const syns = SYNONYMS[t];
    if (syns) for (const s of syns) out.add(s);
  }
  return out;
}

export interface RelevanceOptions {
  maxFacts?: number;
  maxExperience?: number;
  maxProjects?: number;
  maxJdPoints?: number;
}

export function selectRelevantContext(
  question: string,
  type: QuestionType,
  profile: CandidateProfile | null,
  jd: JobDescription | null,
  opts?: RelevanceOptions
): RelevantContext {
  const maxFacts = opts?.maxFacts ?? 8;
  const maxExp = opts?.maxExperience ?? 3;
  const maxProj = opts?.maxProjects ?? 2;
  const maxJd = opts?.maxJdPoints ?? 6;
  const reasons: string[] = [];
  const out: RelevantContext = {
    facts: [],
    experience: [],
    projects: [],
    jdPoints: [],
    useRecentContext: type === "follow_up",
    reasons,
  };
  if (!profile && !jd) {
    reasons.push("no-profile-no-jd");
    return out;
  }
  const q = expandTokens(contentTokens(question));

  if (profile) {
    if (profile.headline) out.headline = profile.headline;
    // Verified facts ranked by overlap + type affinity. The floor (>1.0)
    // keeps zero-overlap, affinity-free facts out of the prompt.
    const scored = profile.verifiedFacts.map((f) => {
      let score = overlap(q, contentTokens(f.text)) * 2 + f.confidence * 0.5;
      if ((type === "technical" || type === "coding") && f.category === "skill") score += 2;
      if (type === "behavioral" && (f.category === "project" || f.category === "experience" || f.category === "achievement")) score += 2;
      if ((type === "resume" || type === "follow_up") && (f.category === "experience" || f.category === "project")) score += 1.5;
      if (type === "system_design" && (f.category === "experience" || f.category === "project")) score += 1;
      return { f, score };
    });
    scored.sort((a, b) => b.score - a.score);
    out.facts = scored.filter((s) => s.score > 1.0).slice(0, maxFacts).map((s) => s.f);
    reasons.push(`facts:${out.facts.length}/${profile.verifiedFacts.length}`);

    // Experience: overlap across title/company/tech/responsibilities + recency.
    const expScored = profile.experience.map((e, idx) => {
      const blob = [e.title, e.company, (e.technologies || []).join(" "), (e.responsibilities || []).join(" "), e.summary || ""].join(" ");
      let score = overlap(q, contentTokens(blob)) * 2;
      if (idx === 0) score += 0.75; // most recent first
      else if (idx === 1) score += 0.4;
      if (type === "behavioral" || type === "resume") score += 0.5;
      return { e, score };
    });
    expScored.sort((a, b) => b.score - a.score);
    out.experience = expScored
      .filter((s) => s.score > 0.3)
      .slice(0, maxExp)
      .map((s) => ({
        company: s.e.company,
        title: s.e.title,
        points: [...(s.e.responsibilities || []).slice(0, 3), ...(s.e.achievements || []).slice(0, 2)].slice(0, 4),
      }));
    reasons.push(`experience:${out.experience.length}/${profile.experience.length}`);

    // Projects: overlap + challenge/design affinity.
    const projScored = (profile.projects || []).map((p) => {
      const blob = [p.name, p.description || "", (p.technologies || []).join(" "), (p.challenges || []).join(" "), (p.outcomes || []).join(" ")].join(" ");
      let score = overlap(q, contentTokens(blob)) * 2;
      if (type === "behavioral" && ((p.challenges || []).length > 0 || /challeng|difficult|hard/i.test(question))) score += 1.5;
      if ((type === "coding" || type === "technical") && (p.technologies || []).length > 0) score += 0.5;
      return { p, score };
    });
    projScored.sort((a, b) => b.score - a.score);
    out.projects = projScored
      .filter((s) => s.score > 0.3)
      .slice(0, maxProj)
      .map((s) => ({
        name: s.p.name,
        points: [
          ...(s.p.description ? [s.p.description.slice(0, 300)] : []),
          ...(s.p.challenges || []).slice(0, 2),
          ...(s.p.outcomes || []).slice(0, 2),
        ].slice(0, 4),
      }));
    reasons.push(`projects:${out.projects.length}/${(profile.projects || []).length}`);

    if (type === "resume" && profile.summary) out.summary = profile.summary.slice(0, 600);
  }

  if (jd) {
    const jdItems: string[] = [
      ...jd.requiredSkills.map((s) => `required: ${s}`),
      ...jd.preferredSkills.map((s) => `preferred: ${s}`),
      ...jd.responsibilities.slice(0, 5).map((s) => `duty: ${s}`),
    ];
    const scored = jdItems.map((item) => ({ item, score: overlap(q, contentTokens(item)) }));
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.filter((s) => s.score > 0).slice(0, maxJd).map((s) => s.item);
    // Always include at least the role headline for grounding.
    out.jdPoints = picked.length > 0 ? picked : [`role: ${jd.title}${jd.company ? ` at ${jd.company}` : ""}`];
    reasons.push(`jd:${out.jdPoints.length}`);
  }
  return out;
}

/** Render the selected subset as labeled prompt lines (verified vs general). */
export function formatRelevantFacts(rel: RelevantContext): string {
  const lines: string[] = [];
  if (rel.headline) lines.push(`Headline: ${rel.headline}`);
  if (rel.summary) lines.push(`Summary: ${rel.summary}`);
  for (const f of rel.facts) {
    lines.push(`- [verified:${f.source}] ${f.text}`);
  }
  for (const e of rel.experience) {
    const pts = e.points.length > 0 ? ` — ${e.points.join("; ").slice(0, 400)}` : "";
    lines.push(`- [experience] ${e.title} at ${e.company}${pts}`);
  }
  for (const p of rel.projects) {
    const pts = p.points.length > 0 ? ` — ${p.points.join("; ").slice(0, 400)}` : "";
    lines.push(`- [project] ${p.name}${pts}`);
  }
  return lines.join("\n");
}
