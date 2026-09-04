/**
 * ModelRouter: fast + strong model generation routing (Phase: reasoning).
 * Routes quick-draft tasks to the fast provider and refined-answer tasks to
 * the strong provider. Providers are injected so tests use mocks and the app
 * wires configured (Gemini / OpenAI-compatible) adapters.
 */

import { LLMProvider } from "./LLMProvider";

export type GenerationTask = "fast-answer" | "strong-answer";

export class ModelRouter {
  private fast: LLMProvider;
  private strong: LLMProvider;

  constructor(fast: LLMProvider, strong?: LLMProvider) {
    this.fast = fast;
    this.strong = strong || fast;
  }

  /** Runtime provider swap (Setup configuration). Next answer() uses the new pair. */
  setProviders(fast: LLMProvider, strong?: LLMProvider): void {
    if (fast) this.fast = fast;
    if (strong) this.strong = strong;
  }

  route(task: GenerationTask): LLMProvider {
    return task === "strong-answer" ? this.strong : this.fast;
  }

  getFastName(): string {
    return this.fast.name;
  }

  getStrongName(): string {
    return this.strong.name;
  }
}
