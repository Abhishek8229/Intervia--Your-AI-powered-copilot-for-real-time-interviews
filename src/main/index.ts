import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  globalShortcut,
  Menu,
  Tray,
  screen,
} from "electron";
import * as path from "path";
import { config } from "./config";
import { logger } from "./logger";
import { AudioManager, classifyAudioProbe, pickSystemSource } from "./audio/AudioManager";
import { AudioDeviceManager, LOOPBACK_NOTE, shortDeviceId } from "./audio/AudioDeviceManager";
import { TranscriptionManager } from "./transcription/TranscriptionManager";
import {
  SpeakerAttributor,
  InterviewContext,
  QuestionDetector,
} from "./conversation";
import {
  setWindowDisplayAffinity,
  isCaptureExclusionSupported,
} from "./native/captureExclusion";
import {
  ScreenCaptureManager,
  ScreenContextManager,
  createOCRProvider,
  createVisionProvider,
  GeminiVisionAdapter,
  TesseractOCRProvider,
  dipToPhysicalRegion,
  validatePhysicalRegion,
} from "./screen";
import {
  createLLMProvider,
  ModelRouter,
  AnswerEngine,
  diagnoseProviders,
  buildDiagnosticsExport,
  providerModeLabel,
  ProviderConfigState,
  ProviderKeys,
  sanitizeProviderConfig,
  sanitizeProviderKeys,
  loadProviderConfig,
  saveProviderConfig,
  loadProviderKeys,
  saveProviderKeys,
  keysPresent,
  applyKeysToEnv,
  effectiveGeminiModel,
  effectiveOpenRouterModel,
  FreeFallbackRouter,
  buildFreeTiers,
  GeminiFreeProvider,
  OpenRouterFreeProvider,
  LocalAIProvider,
  tierDisplayLabel,
} from "./reasoning";
import { WhisperServerProvider, GroqWhisperProvider } from "./transcription/providers";
import {
  CandidateProfile,
  Persona,
  CandidateMode,
  JobDescription,
  JsonFileStorage,
  ProfileStore,
  PersonaStore,
  JDStore,
  AppSelectionState,
  loadSelection,
  saveSelection,
  extractResumeText,
  extractProfileDeterministic,
  extractProfileWithLLM,
  applyProfilePatch,
  pruneManagedUserFacts,
  validateProfile,
  validatePersona,
  validateJD,
  parseJobDescriptionText,
  emptyProfile,
  emptyPersona,
  emptyJD,
} from "./candidates";
import {
  SessionManager,
  SessionStore,
  SessionQuestionRecord,
} from "./session";
import * as fs from "fs";
import * as os from "os";
import {
  AppStatus,
  AppStatusListener,
  AnswerEvent,
  AnswerListener,
  ContextEntry,
  ContextListener,
  QuestionDetectedEvent,
  QuestionListener,
  TranscriptEvent,
  TranscriptListener,
} from "../common/types";
import { ScreenContextEvent, ScreenRegion } from "../common/screen-types";

class InterviaApp {
  private overlayWindow: BrowserWindow | null = null;
  private selectionWindow: BrowserWindow | null = null;
  private settingsWindow: BrowserWindow | null = null;
  /** Diagnostics windows are tracked so Quit can close them (they are auxiliary). */
  private diagnosticsWindows = new Set<BrowserWindow>();
  /** System tray (secondary Quit path). Null when the platform refuses one. */
  private tray: Tray | null = null;
  /** Idempotence guard: repeated Quit attempts are safe, cleanup runs once. */
  private quitting = false;
  /** True while the Setup levels-only monitor owns the capture window. */
  private monitorActive = false;
  /** Display the region selector was opened on (DIP bounds + scaleFactor for DPI mapping). */
  private selectorDisplay: { id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number } | null = null;
  /** Last manual-region outcome for the diagnostics UI (metadata only, no pixels). */
  private lastRegionReport: Record<string, unknown> = { available: false, note: "no region captured yet (Ctrl+Shift+S)" };  private audioManager = new AudioManager();
  private deviceManager: AudioDeviceManager = new AudioDeviceManager({
    load: () => ({}),
    save: () => undefined,
  });
  private speakerAttributor = new SpeakerAttributor();
  private transcriptionManager: TranscriptionManager;
  private context = new InterviewContext();
  private questionDetector = new QuestionDetector();
  private screenCapture = new ScreenCaptureManager({
    monitorIntervalMs: config.screen.monitorIntervalMs,
    downscaleWidth: config.screen.downscaleWidth,
    hashThresholdBits: config.screen.changeThresholdBits,
  });
  private screenManager: ScreenContextManager;
  private answerEngine: AnswerEngine;
  private candidateProfile = "";
  private jobDescription = "";
  // Candidate-intelligence layer (initialized after app.ready — needs userData).
  private dataStorage: JsonFileStorage | null = null;
  private profileStore: ProfileStore | null = null;
  private personaStore: PersonaStore | null = null;
  private jdStore: JDStore | null = null;
  private selection: AppSelectionState = {};
  /** Effective provider configuration (saved file wins, else env snapshot). */
  private providerConfig: ProviderConfigState = sanitizeProviderConfig(null);
  private sessionManager = new SessionManager();
  private sessionStore: SessionStore | null = null;
  private capturing = false;
  /** Bounded recent-error ring for the redacted diagnostics export. */
  private recentErrors: Array<{ at: number; source: string; message: string }> = [];
  private status: AppStatus = {
    transcription: "idle",
    microphone: null,
    system: null,
    providerName: "unknown",
    screen: {
      monitoring: false,
      ocr: "ready",
      vision: "ready",
      visionMode: config.vision.mode,
    },
  };

  private statusListeners = new Set<AppStatusListener>();
  private transcriptListeners = new Set<TranscriptListener>();
  private contextListeners = new Set<ContextListener>();
  private questionListeners = new Set<QuestionListener>();
  private answerListeners = new Set<AnswerListener>();
  private screenListeners = new Set<(e: ScreenContextEvent) => void>();

  constructor() {
    this.transcriptionManager = new TranscriptionManager(undefined, {
      attributeSpeaker: (src) => this.speakerAttributor.attribute(src),
    });
    // Screen OCR: configured provider, with graceful fallback to mock when the
    // local binary is unavailable (never crashes the app).
    const ocr = createOCRProvider(config.ocr.provider, { timeoutMs: config.ocr.timeoutMs });
    const vision = createVisionProvider(config.vision.provider);
    this.screenManager = new ScreenContextManager(
      this.screenCapture,
      ocr,
      vision,
      this.context,
      this.questionDetector,
      {
        visionMode: config.vision.mode,
        dedupeWindowMs: config.screen.dedupeWindowMs,
        minEventGapMs: config.screen.minEventGapMs,
        fusionMaxAgeMs: config.screen.fusionMaxAgeMs,
        maxScreenChars: config.reasoning.maxScreenChars,
      }
    );
    const fast = this.buildFreeRouter("fast");
    const strong = this.buildFreeRouter("strong");
    this.answerEngine = new AnswerEngine(new ModelRouter(fast, strong));

    this.transcriptionManager.on("transcript", (e) => this.onTranscript(e));
    this.transcriptionManager.setErrorHandler((source, message) => this.noteError(source, message));
    this.context.on("add", (e) => this.broadcastContext(e));
    this.context.on("update", (e) => this.broadcastContext(e));
    this.questionDetector.on("question", (q) => this.onQuestion(q));
    this.screenManager.on("screen-context", (e: ScreenContextEvent) => this.onScreenContext(e));
    this.screenManager.on("screen-question", (q: QuestionDetectedEvent) => this.onQuestion(q));
    this.screenManager.on("screen-failure", (f: { stage: string; message: string }) => {
      try {
        this.noteError(`screen:${String(f?.stage || "unknown")}`, String(f?.message || "screen failure"));
      } catch {
        // ignore
      }
    });
    this.screenManager.on("status", (s) => {
      this.status.screen = {
        monitoring: s.monitoring,
        ocr: s.ocr,
        vision: s.vision,
        visionMode: config.vision.mode,
        lastText: s.lastText,
        lastEventAt: s.lastEventAt,
      };
      this.broadcastStatus();
    });
    this.answerEngine.on("fast-answer", (a: AnswerEvent) => this.onAnswer(a));
    this.answerEngine.on("strong-answer", (a: AnswerEvent) => this.onAnswer(a));
    this.answerEngine.on("stale-answer", () => {
      // Stale generations are dropped; no UI update.
    });
    this.answerEngine.on("answer-error", (e: { questionId: string; question: string; message: string; timestamp: number }) => {
      this.noteError("answer", e.message);
      this.recordSessionAnswer(e.questionId, "strong", null, "unavailable", e.message);
      for (const l of this.answerListeners) {
        try {
          (l as unknown as (x: unknown) => void)({ ...e, kind: "error", text: e.message, model: "none" });
        } catch {
          // ignore
        }
      }
      this.syncCandidateStatus();
    });
    this.sessionManager.on("question", () => this.persistActiveSession());
    this.sessionManager.on("answer", () => this.persistActiveSession());
    this.sessionManager.on("ended", (s) => {
      try {
        this.sessionStore?.save(s);
      } catch {
        // ignore
      }
      this.syncCandidateStatus();
    });
    this.sessionManager.on("active", () => this.syncCandidateStatus());
    this.candidateProfile = loadTextFile(config.candidate.profileFile, 4000);
    this.jobDescription = loadTextFile(config.candidate.jobDescriptionFile, 4000);
    this.audioManager.setErrorHandler((source, message) => this.noteError("audio:" + source, message));
    this.audioManager.setDeviceListHandler((devices, fromDeviceChange) => {
      try {
        if (fromDeviceChange) {
          const res = this.deviceManager.handleDeviceChange(devices);
          if (res.micInvalidated) this.noteError("audio:microphone", "selected microphone disappeared (DEVICE UNAVAILABLE) — return to Default Device");
          if (res.outputInvalidated) this.noteError("audio:system", "selected output device disappeared (DEVICE UNAVAILABLE) — return to Default Device");
        } else {
          this.deviceManager.updateDeviceList(devices);
        }
      } catch (e) {
        logger.warn("device list handling failed", String(e));
      }
    });
    this.updateAnswerLabel();
  }

  /**
   * Real-machine convenience: when the OCR provider is still the default
   * mock but a Tesseract binary is installed, use it automatically (logged).
   * Runs once at startup; never blocks boot.
   */
  private async maybeEnableLocalOcr(): Promise<void> {
    try {
      if ((config.ocr.provider || "tesseract").toLowerCase() !== "mock") return;
      const tess = new TesseractOCRProvider({ timeoutMs: config.ocr.timeoutMs });
      if (await tess.isAvailable()) {
        this.screenManager.setOcrProvider(tess);
        logger.info("Local OCR auto-enabled (tesseract found on PATH)");
      }
    } catch (e) {
      logger.warn("Local OCR auto-enable check failed", String(e));
    }
  }

  /**
   * Screen-vision convenience: when the vision backend is still the offline
   * mock but a Gemini key is configured (same key as the answer stack),
   * install the Gemini Vision adapter so gated visual understanding works.
   * Uploads remain gated by vision mode (remote only); local mode stays
   * fully offline. Runs once at startup; never blocks boot.
   */
  private async maybeEnableGeminiVision(): Promise<void> {
    try {
      const current = this.screenManager.getVisionName();
      if (!/mock/i.test(current || "")) return;
      const hasKey = !!(process.env.INTERVIA_GEMINI_API_KEY || config.vision.apiKey);
      if (!hasKey) return;
      const adapter = new GeminiVisionAdapter({ model: effectiveGeminiModel(this.providerConfig) || undefined });
      let available = false;
      try {
        available = await adapter.isAvailable();
      } catch {
        available = false;
      }
      if (available) {
        this.screenManager.setVisionProvider(adapter);
        logger.info("Gemini Vision auto-enabled (reuses Gemini Free configuration)");
      }
    } catch (e) {
      logger.warn("Gemini Vision auto-enable check failed", String(e));
    }
  }

  private noteError(source: string, message: string): void {
    try {
      this.recentErrors.push({ at: Date.now(), source, message: String(message || "").slice(0, 500) });
      while (this.recentErrors.length > 50) this.recentErrors.shift();
    } catch {
      // ignore
    }
  }

  private getCandidateMode(): CandidateMode {
    return this.selection.candidateMode === "mock" ? "mock" : "real";
  }

  private getActivePersona(): Persona | null {
    try {
      if (this.selection.activePersonaId) return this.personaStore?.get(this.selection.activePersonaId) || null;
    } catch {
      // ignore
    }
    return null;
  }

  private getActiveProfile(): CandidateProfile | null {
    try {
      const mode = this.getCandidateMode();
      const persona = this.getActivePersona();
      if (mode === "mock" && persona?.knowledgeProfileId) {
        const linked = this.profileStore?.get(persona.knowledgeProfileId);
        if (linked) return linked;
      }
      if (this.selection.activeProfileId) {
        const p = this.profileStore?.get(this.selection.activeProfileId);
        if (p) return p;
      }
      const all = this.profileStore?.list() || [];
      return all.length > 0 ? all[0] : null;
    } catch {
      return null;
    }
  }

  private getActiveJD(): JobDescription | null {
    try {
      if (this.selection.activeJDId) {
        const j = this.jdStore?.get(this.selection.activeJDId);
        if (j) return j;
      }
      const all = this.jdStore?.list() || [];
      return all.length > 0 ? all[0] : null;
    } catch {
      return null;
    }
  }

  private persistSelection(): void {
    try {
      if (this.dataStorage) saveSelection(this.dataStorage, this.selection);
    } catch {
      // ignore
    }
  }

  private persistActiveSession(): void {
    try {
      const s = this.sessionManager.getActiveSession();
      if (s) this.sessionStore?.save(s);
    } catch {
      // ignore
    }
  }

  private recordSessionAnswer(
    questionId: string,
    role: "fast" | "strong",
    a: AnswerEvent | null,
    status: "ok" | "error" | "unavailable",
    textOverride?: string
  ): void {
    const s = this.sessionManager.getActiveSession();
    if (!s) return;
    // Provider metadata comes from the ACTUAL tier that generated the answer
    // (event.model like "gemini-free:gemini-2.5-flash"), never from stale config.
    const modelText = a?.model || (role === "fast" ? effectiveGeminiModel(this.providerConfig) : effectiveGeminiModel(this.providerConfig));
    const tierPart = String(modelText || "").split(":")[0] || "";
    const providerText = tierPart.includes("gemini") || tierPart.includes("openrouter") || tierPart.includes("local")
      ? tierPart
      : (a?.model || (role === "fast" ? "free-fallback" : "free-fallback"));
    this.sessionManager.recordAnswer(s.id, {
      id: a ? `sa-${a.id}` : `sa-${role}-${Date.now().toString(36)}`,
      questionId,
      role,
      text: a?.text || textOverride || "",
      provider: providerText,
      model: modelText,
      latencyMs: a?.latencyMs ?? 0,
      timestamp: a?.timestamp || Date.now(),
      status,
      stale: a?.stale,
    });
  }

  private syncCandidateStatus(): void {
    try {
      const profile = this.getActiveProfile();
      const persona = this.getActivePersona();
      const jd = this.getActiveJD();
      const active = this.sessionManager.getActiveSession();
      this.status.profileName = profile?.name;
      const mode = this.getCandidateMode();
      this.status.personaLabel = persona ? `${persona.name} (${mode})` : mode === "mock" ? "Mock" : "Real";
      this.status.jobTitle = jd ? (jd.company ? `${jd.title} @ ${jd.company}` : jd.title) : undefined;
      this.status.sessionStatus = active ? (active.status === "running" ? "running" : active.status === "paused" ? "paused" : "ended") : "none";
      this.status.sessionQuestionCount = active ? active.questions.length : 0;
    } catch {
      // never break status on candidate bookkeeping
    }
    this.broadcastStatus();
  }

  /** Data layer: local stores + session restore. Runs after app.ready. */
  private initDataLayer(): void {
    let base = "";
    try {
      base = path.join(app.getPath("userData"), "intervia");
    } catch {
      base = path.join(os.tmpdir(), "intervia-data");
    }
    try {
      this.dataStorage = new JsonFileStorage(base);
      this.profileStore = new ProfileStore(this.dataStorage);
      this.personaStore = new PersonaStore(this.dataStorage);
      this.jdStore = new JDStore(this.dataStorage);
      this.sessionStore = new SessionStore(this.dataStorage);
      this.selection = loadSelection(this.dataStorage);
      // Audio device selections persist in the same local selection state
      // (selectedMicrophoneId / selectedOutputDeviceId, "default" = Windows default).
      this.deviceManager = new AudioDeviceManager({
        load: () => ({
          selectedMicrophoneId: this.selection.selectedMicrophoneId,
          selectedOutputDeviceId: this.selection.selectedOutputDeviceId,
        }),
        save: (sel) => {
          this.selection.selectedMicrophoneId = sel.selectedMicrophoneId;
          this.selection.selectedOutputDeviceId = sel.selectedOutputDeviceId;
          this.persistSelection();
        },
      });
      logger.info("Audio devices", {
        mic: shortDeviceId(this.deviceManager.getSelectedMicId()),
        output: shortDeviceId(this.deviceManager.getSelectedOutputId()),
      });
      // Restore persisted sessions for history viewing (none becomes active).
      try {
        const restored = this.sessionStore.loadAll();
        for (const s of restored.slice(0, 50)) this.sessionManager.attach(s);
      } catch (e) {
        logger.warn("Session restore failed", String(e));
      }
      logger.info("Data layer ready", {
        profiles: this.profileStore.list().length,
        personas: this.personaStore.list().length,
        jds: this.jdStore.list().length,
      });
      // Provider configuration: saved file wins, otherwise snapshot the env
      // so the Setup UI always edits the EFFECTIVE configuration. Stored
      // keys fill process.env gaps (explicit environment always wins).
      try {
        applyKeysToEnv(loadProviderKeys(this.dataStorage));
      } catch {
        // ignore
      }
      this.providerConfig = this.effectiveProviderConfig();
      this.applyProviderConfig({ quiet: true });
      // Saved STT choice applies at boot (transcription not started yet).
      try {
        const wantStt = this.providerConfig.sttProvider;
        const haveStt = this.transcriptionManager.getProviderName();
        const swap = wantStt === "groq" && haveStt !== "groq"
          ? new GroqWhisperProvider()
          : wantStt === "whisper-server" && haveStt !== "whisper-server"
            ? new WhisperServerProvider()
            : null;
        if (swap) {
          void this.transcriptionManager.setProvider(swap).catch((e) => logger.warn("STT provider boot apply failed", String(e)));
        }
      } catch (e) {
        logger.warn("STT provider boot apply failed", String(e));
      }
      try {
        this.screenManager.setVisionMode(this.providerConfig.visionMode);
      } catch (e) {
        logger.warn("Vision mode boot apply failed", String(e));
      }
      this.updateAnswerLabel();
    } catch (e) {
      logger.warn("Data layer init failed; candidate features disabled", String(e));
      this.dataStorage = null;
    }
    this.syncCandidateStatus();
  }

  /** Snapshot env-derived config (used when no saved file exists yet). */
  private envProviderConfig(): ProviderConfigState {
    return sanitizeProviderConfig({
      fastProvider: config.llm.fastProvider,
      fastModel: config.llm.fastModel,
      strongProvider: config.llm.strongProvider,
      strongModel: config.llm.strongModel,
      sttProvider: config.provider,
      visionMode: config.vision.mode,
      geminiModel: config.geminiFree.model,
      openRouterModel: config.openrouter.model,
      localEnabled: config.localAi.enabled,
    });
  }

  private effectiveProviderConfig(): ProviderConfigState {
    try {
      if (this.dataStorage) {
        const saved = loadProviderConfig(this.dataStorage);
        // A saved file (even all-defaults) is an explicit user choice.
        void saved;
        const files = this.dataStorage.list("provider-config", ".json");
        if (files.length > 0) return saved;
      }
    } catch {
      // fall through to env snapshot
    }
    return this.envProviderConfig();
  }

  private buildFreeRouter(label: "fast" | "strong"): FreeFallbackRouter {
    const c = this.providerConfig || sanitizeProviderConfig(null);
    const timeoutMs = Number(process.env.INTERVIA_FREE_TIER_TIMEOUT_MS || 25000);
    const gemini = new GeminiFreeProvider({ model: effectiveGeminiModel(c) || undefined, timeoutMs });
    const openRouter = new OpenRouterFreeProvider({ model: effectiveOpenRouterModel(c) || undefined, timeoutMs });
    const local = new LocalAIProvider();
    const tiers: Array<{ tier: "gemini-free" | "openrouter-free" | "local"; provider: GeminiFreeProvider | OpenRouterFreeProvider | LocalAIProvider }> = [
      { tier: "gemini-free", provider: gemini },
      { tier: "openrouter-free", provider: openRouter },
    ];
    // Local AI is the final guaranteed fallback (honors the enable switch;
    // when disabled the router reports cloud-only and errors honestly).
    try {
      if (c.localEnabled !== false) tiers.push({ tier: "local", provider: local });
    } catch {
      tiers.push({ tier: "local", provider: local });
    }
    return new FreeFallbackRouter({ tiers, label: `free-fallback-${label}` });
  }

  private buildLlmPair(): { fast: FreeFallbackRouter; strong: FreeFallbackRouter } {
    return {
      fast: this.buildFreeRouter("fast"),
      strong: this.buildFreeRouter("strong"),
    };
  }

  /**
   * Rebuild live providers from providerConfig (Setup save). Never throws;
   * STT swaps while capturing are deferred with a warning in the result.
   */
  private async applyProviderConfig(opts?: { quiet?: boolean }): Promise<{ sttDeferred: boolean }> {
    let sttDeferred = false;
    try {
      const { fast, strong } = this.buildLlmPair();
      this.answerEngine.setProviders(fast, strong);
    } catch (e) {
      logger.warn("LLM provider rebuild failed", String(e));
    }
    try {
      const wantStt = this.providerConfig.sttProvider;
      const haveStt = this.transcriptionManager.getProviderName();
      const wantName = wantStt === "groq" ? "groq" : "whisper-server";
      if (wantName !== haveStt) {
        if (this.capturing || this.audioManager.isRunning()) {
          sttDeferred = true;
        } else {
          const ok = await this.transcriptionManager.setProvider(
            wantName === "groq" ? new GroqWhisperProvider() : new WhisperServerProvider()
          );
          if (!ok) sttDeferred = true;
        }
      }
    } catch (e) {
      logger.warn("STT provider apply failed", String(e));
    }
    try {
      this.screenManager.setVisionMode(this.providerConfig.visionMode);
    } catch (e) {
      logger.warn("Vision mode apply failed", String(e));
    }
    // A newly saved Gemini key also lights up gated Gemini Vision (same key
    // system; uploads still require remote vision mode).
    try {
      void this.maybeEnableGeminiVision();
    } catch {
      // ignore
    }
    this.updateAnswerLabel();
    if (!opts?.quiet) this.broadcastStatus();
    return { sttDeferred };
  }

  /** Overlay answer line: compact 3-tier status (never secrets). */
  private updateAnswerLabel(): void {
    try {
      const names = this.answerEngine.providerNames();
      const active = names.strong || names.fast || "";
      const tier = String(active).split(":")[0].toLowerCase();
      const ready = this.freeTierReadiness();
      const order = "Gemini Free → OpenRouter Free → Local AI";
      if (tier.includes("gemini")) this.status.answerProviderName = "Gemini Free";
      else if (tier.includes("openrouter")) this.status.answerProviderName = "OpenRouter Free (fallback)";
      else if (tier.includes("local")) this.status.answerProviderName = "Local AI (fallback)";
      else this.status.answerProviderName = order;
      void ready;
    } catch {
      // label is cosmetic; never break boot on it
    }
  }

  /** Presence-only 3-tier readiness (safe for UI/status). */
  private freeTierReadiness(): { gemini: boolean; openrouter: boolean; local: boolean } {
    try {
      let keys: ProviderKeys = {};
      if (this.dataStorage) keys = loadProviderKeys(this.dataStorage);
      const p = keysPresent(keys);
      const local = this.providerConfig ? this.providerConfig.localEnabled !== false : true;
      return { gemini: !!p.gemini, openrouter: !!p.openrouter, local };
    } catch {
      return { gemini: false, openrouter: false, local: true };
    }
  }

  async start(): Promise<void> {
    try {
      app.setAppUserModelId("com.intervia.app");
    } catch {}

    await app.whenReady();
    logger.info("Intervia main process ready");

    this.initDataLayer();
    this.createOverlayWindow();
    this.registerIpc();
    this.registerHotkey();
    this.setupTray();
    void this.maybeEnableLocalOcr();
    void this.maybeEnableGeminiVision();

    try {
      await this.transcriptionManager.init();
      this.status.providerName = this.transcriptionManager.getProviderName();
      this.status.transcription = "ready";
    } catch (e) {
      this.noteError("transcription", String(e));
      logger.warn("transcription init failed", e);
      this.status.transcription = "error";
      this.status.errorMessage = String(e);
    }
    this.broadcastStatus();

    app.on("window-all-closed", () => {
      // Stay alive as overlay utility (do not quit on Windows when last window closes).
    });
    app.on("before-quit", () => {
      this.stopCapture();
      this.stopMonitor();
      this.screenManager.stopAutoMonitoring();
      this.screenManager.cancelPending();
      this.closeRegionSelector();
      this.closeSettingsWindow();
      this.closeDiagnosticsWindows();
      this.transcriptionManager.stop();
      this.context.stop();
      try {
        globalShortcut.unregisterAll();
      } catch {
        // ignore
      }
      try {
        this.tray?.destroy();
      } catch {
        // ignore
      }
      this.tray = null;
    });
  }

  private createOverlayWindow(): void {
    const display = screen.getPrimaryDisplay();
    const { width: dw, height: dh } = display.workAreaSize;
    const w = config.overlay.width;
    const h = config.overlay.height;
    const x = Math.floor((dw - w) / 2);
    const y = Math.max(0, dh - h - 20);

    this.overlayWindow = new BrowserWindow({
      width: w,
      height: h,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: true,
      skipTaskbar: true,
      hasShadow: false,
      show: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // Apply Windows native capture-exclusion (SetWindowDisplayAffinity + WDA_EXCLUDEFROMCAPTURE)
    // via koffi + user32.dll. Falls back to Electron's setContentProtection when supported.
    this.applyCaptureExclusion();

    this.overlayWindow.removeMenu();
    this.overlayWindow.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
    this.overlayWindow.on("ready-to-show", () => {
      this.broadcastStatus();
    });
    // Keep the capture layer aware of overlay bounds (belt-and-braces on top
    // of OS-level WDA_EXCLUDEFROMCAPTURE) so the overlay never becomes OCR input.
    const syncBounds = (): void => {
      try {
        if (!this.overlayWindow) return;
        const b = this.overlayWindow.getBounds();
        this.screenCapture.setExcludedRegions([{ x: b.x, y: b.y, width: b.width, height: b.height }]);
      } catch {
        // ignore
      }
    };
    syncBounds();
    this.overlayWindow.on("move", syncBounds);
    this.overlayWindow.on("resize", syncBounds);
    this.overlayWindow.on("closed", () => {
      this.overlayWindow = null;
    });
  }

  private applyCaptureExclusion(): void {
    this.applyExclusionToWindow(this.overlayWindow, "overlay");
  }

  /**
   * OS-level capture exclusion for any Intervia window. Applied to the
   * overlay, the region selector, AND the settings window: the settings
   * window can display session history (questions + answers), which must
   * never feed back into OCR/vision as screen context.
   */
  private applyExclusionToWindow(w: BrowserWindow | null, label: string): void {
    if (!w) return;
    // First try Electron's built-in (silent if unsupported).
    try {
      if (typeof (w as any).setContentProtection === "function") {
        (w as any).setContentProtection(true);
      }
    } catch (e) {
      logger.warn("setContentProtection threw", e);
    }
    // Then native Win32 path. On non-Windows / when koffi is unavailable this no-ops.
    try {
      if (!isCaptureExclusionSupported()) {
        logger.info("native capture-exclusion not available on this platform");
        return;
      }
      const hwnd = w.getNativeWindowHandle();
      // hwnd may be a Buffer; convert to its first 4 bytes as a Windows HWND pointer.
      let hwndValue: number = 0;
      if (typeof hwnd === "number") hwndValue = hwnd;
      else if (hwnd && typeof hwnd === "object" && "buffer" in hwnd) {
        // Electron returns a Buffer-like object whose first 4 bytes are the HWND on win32.
        const buf: any = hwnd;
        const ab: ArrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const dv = new DataView(ab);
        // On Windows x64 the HWND pointer is at offset 0 (lower 32 bits are enough for HWND).
        hwndValue = dv.getUint32(0, true);
      }
      if (hwndValue === 0) {
        logger.warn("native capture-exclusion: could not extract HWND");
        return;
      }
      const r = setWindowDisplayAffinity(hwndValue, "exclude");
      if (r.applied) {
        logger.info(`native capture-exclusion applied to ${label} (WDA_EXCLUDEFROMCAPTURE)`);
      } else {
        logger.warn(`native capture-exclusion not applied to ${label}: ` + r.reason);
      }
    } catch (e) {
      logger.warn("native capture-exclusion failed", e);
    }
  }

  private registerHotkey(): void {
    const ok = globalShortcut.register("CommandOrControl+Shift+I", () => {
      this.toggleOverlay();
    });
    if (!ok) {
      logger.warn("Failed to register Ctrl+Shift+I global hotkey");
    } else {
      logger.info("Global hotkey registered: Ctrl+Shift+I");
    }
    // Manual screen-region capture (configurable; defaults to Ctrl+Shift+S).
    try {
      const okScreen = globalShortcut.register(config.screen.hotkey, () => {
        this.openRegionSelector();
      });
      if (!okScreen) {
        logger.warn("Failed to register screen-region hotkey", config.screen.hotkey);
      } else {
        logger.info("Screen-region hotkey registered: " + config.screen.hotkey);
      }
    } catch (e) {
      logger.warn("Screen-region hotkey registration threw", String(e));
    }
    // Secondary Quit path: distinct from Ctrl+Shift+I (hide/show) and
    // Ctrl+Shift+S (region select) — no interference by design.
    try {
      const okQuit = globalShortcut.register("CommandOrControl+Shift+Q", () => {
        this.requestQuit("hotkey");
      });
      if (!okQuit) {
        logger.warn("Failed to register Ctrl+Shift+Q quit hotkey");
      } else {
        logger.info("Quit hotkey registered: Ctrl+Shift+Q");
      }
    } catch (e) {
      logger.warn("Quit hotkey registration threw", String(e));
    }
  }

  private toggleOverlay(): void {
    if (!this.overlayWindow) return;
    if (this.overlayWindow.isVisible()) {
      this.overlayWindow.hide();
    } else {
      this.overlayWindow.show();
      // Re-apply capture-exclusion in case HWND changed.
      this.applyCaptureExclusion();
    }
  }

  /**
   * Secondary Quit path: system tray with Show/Hide + Quit. Best-effort —
   * if the platform refuses a tray, the in-app Quit button and Ctrl+Shift+Q
   * still work. Never throws.
   */
  private setupTray(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createTrayNativeImage } = require("./trayIcon");
      const image = createTrayNativeImage() as Electron.NativeImage;
      const tray = new Tray(image);
      tray.setToolTip("Intervia (right-click for Quit)");
      const menu = Menu.buildFromTemplate([
        {
          label: "Show / Hide overlay",
          click: () => this.toggleOverlay(),
        },
        {
          label: "Open Setup",
          click: () => this.openSettingsWindow(),
        },
        { type: "separator" },
        {
          label: "Quit Intervia",
          click: () => this.requestQuit("tray"),
        },
      ]);
      tray.setContextMenu(menu);
      tray.on("click", () => this.toggleOverlay());
      this.tray = tray;
      logger.info("Tray ready (secondary Quit path)");
    } catch (e) {
      this.tray = null;
      logger.warn("Tray unavailable; Quit remains via overlay button + Ctrl+Shift+Q", String(e));
    }
  }

  /**
   * Production Quit: full cleanup through the normal Electron lifecycle,
   * then app.quit(). Idempotent — repeated attempts are safe. Never kills
   * the process forcibly.
   *
   * Sequence: mic/system capture stop -> screen monitoring stop -> pending
   * screen/vision/LLM cancel -> transcription stop -> global shortcuts off ->
   * selector/settings/diagnostics windows closed -> tray destroyed -> quit.
   */
  requestQuit(reason: string): void {
    if (this.quitting) {
      logger.info("Quit already in progress (ignored duplicate)", { reason });
      return;
    }
    this.quitting = true;
    logger.info("Intervia quitting", { reason });
    try {
      this.stopCapture();
    } catch (e) {
      logger.warn("Quit: stopCapture failed", String(e));
    }
    try {
      this.stopMonitor();
    } catch {
      // ignore (monitor may never have started)
    }
    try {
      this.screenManager.stopAutoMonitoring();
    } catch {
      // ignore
    }
    try {
      this.screenManager.cancelPending();
    } catch {
      // ignore
    }
    try {
      this.answerEngine.cancel();
    } catch {
      // ignore
    }
    try {
      this.transcriptionManager.stop();
    } catch (e) {
      logger.warn("Quit: transcription stop failed", String(e));
    }
    try {
      this.context.stop();
    } catch {
      // ignore
    }
    try {
      globalShortcut.unregisterAll();
    } catch {
      // ignore
    }
    this.closeRegionSelector();
    this.closeSettingsWindow();
    this.closeDiagnosticsWindows();
    try {
      this.tray?.destroy();
    } catch {
      // ignore
    }
    this.tray = null;
    app.quit();
  }

  private closeDiagnosticsWindows(): void {
    try {
      for (const w of [...this.diagnosticsWindows]) {
        try {
          if (!w.isDestroyed()) w.close();
        } catch {
          // ignore per-window failures
        }
      }
    } finally {
      this.diagnosticsWindows.clear();
    }
  }

  /**
   * Manual region selector (Phase 12/22): fullscreen transparent window where
   * the user drags a rectangle. Selection flows into the SAME question/answer
   * pipeline as everything else. Escape cancels with no side effects.
   */
  private openRegionSelector(): void {
    if (this.selectionWindow) {
      try {
        this.selectionWindow.focus();
      } catch {
        // ignore
      }
      return;
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x: dx, y: dy, width: dw, height: dh } = display.bounds;
    try {
      this.selectorDisplay = {
        id: Number(display.id),
        bounds: { x: dx, y: dy, width: dw, height: dh },
        scaleFactor: Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1,
      };
    } catch {
      this.selectorDisplay = null;
    }
    const win = new BrowserWindow({
      x: dx,
      y: dy,
      width: dw,
      height: dh,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: true,
      fullscreen: true,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.selectionWindow = win;
    win.removeMenu();
    win.loadFile(path.join(__dirname, "..", "renderer", "screen-select.html"));
    this.applyExclusionToWindow(win, "region-selector");
    win.on("closed", () => {
      if (this.selectionWindow === win) this.selectionWindow = null;
    });
    // Safety: never trap the user in the selector.
    setTimeout(() => {
      try {
        if (this.selectionWindow === win && !win.isDestroyed()) {
          win.close();
        }
      } catch {
        // ignore
      }
    }, 120000).unref?.();
  }

  private closeRegionSelector(): void {
    try {
      if (this.selectionWindow && !this.selectionWindow.isDestroyed()) {
        this.selectionWindow.close();
      }
    } catch {
      // ignore
    }
    this.selectionWindow = null;
  }

  /** Compact secondary window for profiles / JD / persona / history / providers. */
  private openSettingsWindow(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      try {
        this.settingsWindow.focus();
      } catch {
        // ignore
      }
      return;
    }
    const win = new BrowserWindow({
      width: 760,
      height: 600,
      frame: true,
      resizable: true,
      skipTaskbar: false,
      hasShadow: true,
      show: true,
      title: "Intervia Setup",
      backgroundColor: "#0f1117",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.settingsWindow = win;
    win.removeMenu();
    win.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
    this.applyExclusionToWindow(win, "settings");
    win.on("closed", () => {
      if (this.settingsWindow === win) this.settingsWindow = null;
      this.stopMonitor();
    });
    // Live meters need a live pipeline: start the levels-only monitor (it
    // yields automatically when interview capture or a probe owns the
    // capture window). Levels flow continuously, so the renderer's slightly
    // later subscription misses nothing that matters.
    this.startMonitor();
  }

  private closeSettingsWindow(): void {
    try {
      if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
        this.settingsWindow.close();
      }
    } catch {
      // ignore
    }
    this.settingsWindow = null;
    this.stopMonitor();
  }

  private registerIpc(): void {
    ipcMain.handle("intervia:status:get", () => this.status);
    ipcMain.on("intervia:status:subscribe", (evt) => {
      const wc = evt.sender;
      const send = (s: AppStatus) => wc.send("intervia:status:update", s);
      send(this.status);
      this.statusListeners.add(send);
      wc.on("destroyed", () => this.statusListeners.delete(send));
    });
    ipcMain.on("intervia:transcript:subscribe", (evt) => {
      const wc = evt.sender;
      const send = (t: TranscriptEvent) => wc.send("intervia:transcript:event", t);
      this.transcriptListeners.add(send);
      wc.on("destroyed", () => this.transcriptListeners.delete(send));
    });
    ipcMain.on("intervia:context:subscribe", (evt) => {
      const wc = evt.sender;
      const send = (e: ContextEntry) => wc.send("intervia:context:event", e);
      send({ id: "snapshot", speaker: "unknown", source: "microphone", text: "", timestamp: Date.now(), transcriptEventId: "__snapshot__" });
      // Send snapshot.
      for (const e of this.context.snapshot()) send(e);
      this.contextListeners.add(send);
      wc.on("destroyed", () => this.contextListeners.delete(send));
    });
    ipcMain.on("intervia:question:subscribe", (evt) => {
      const wc = evt.sender;
      const send = (q: QuestionDetectedEvent) => wc.send("intervia:question:event", q);
      this.questionListeners.add(send);
      wc.on("destroyed", () => this.questionListeners.delete(send));
    });
    ipcMain.on("intervia:answer:subscribe", (evt) => {
      const wc = evt.sender;
      const send = (a: AnswerEvent) => wc.send("intervia:answer:event", a);
      this.answerListeners.add(send);
      wc.on("destroyed", () => this.answerListeners.delete(send));
    });
    ipcMain.on("intervia:screen:subscribe", (evt) => {
      const wc = evt.sender;
      const send = (e: ScreenContextEvent) => wc.send("intervia:screen:event", e);
      this.screenListeners.add(send);
      wc.on("destroyed", () => this.screenListeners.delete(send));
    });
    ipcMain.handle("intervia:screen:start", () => {
      if (config.screen.enabled) this.screenManager.startAutoMonitoring();
      this.syncScreenStatus();
      return this.screenCapture.isMonitoring();
    });
    ipcMain.handle("intervia:screen:stop", () => {
      this.screenManager.stopAutoMonitoring();
      this.syncScreenStatus();
      return false;
    });
    ipcMain.handle("intervia:screen:capture-now", async () => {
      try {
        const e = await this.screenManager.captureNow();
        return e ? { id: e.id, text: (e.detectedQuestion || e.text || "").slice(0, 300) } : null;
      } catch (err) {
        logger.warn("Manual screen capture failed", String(err));
        return null;
      }
    });
    ipcMain.handle("intervia:screen:select-region", () => {
      this.openRegionSelector();
      return true;
    });
    ipcMain.on("intervia:screen:region-selected", (_evt, region: ScreenRegion) => {
      this.closeRegionSelector();
      void (async (): Promise<void> => {
        const at = Date.now();
        try {
          const dip = {
            x: Math.floor(Number(region?.x) || 0),
            y: Math.floor(Number(region?.y) || 0),
            width: Math.floor(Number(region?.width) || 0),
            height: Math.floor(Number(region?.height) || 0),
          };
          // Resolve the target display: prefer the one the selector lived on,
          // fall back to the display containing the selection center.
          let disp = this.selectorDisplay;
          if (!disp) {
            try {
              const d = screen.getDisplayNearestPoint({ x: dip.x + dip.width / 2, y: dip.y + dip.height / 2 });
              disp = {
                id: Number(d.id),
                bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
                scaleFactor: Number(d.scaleFactor) > 0 ? Number(d.scaleFactor) : 1,
              };
            } catch {
              disp = null;
            }
          }
          let physical: ScreenRegion | null = null;
          let dpiNote = "display metrics unavailable; proportional fallback";
          if (disp) {
            const mapping = dipToPhysicalRegion(dip, disp);
            const physSize = {
              width: Math.floor(disp.bounds.width * mapping.scaleFactor),
              height: Math.floor(disp.bounds.height * mapping.scaleFactor),
            };
            const check = validatePhysicalRegion(mapping.physical, physSize);
            physical = mapping.physical;
            dpiNote = check.ok
              ? `DIP ${dip.width}x${dip.height} @${mapping.scaleFactor}x -> physical ${physical.width}x${physical.height} (display ${mapping.displayId})`
              : `DPI mapping issue: ${check.reason} (display ${mapping.displayId}, scale ${mapping.scaleFactor})`;
            if (!check.ok) {
              this.noteError("screen:region", `manual region rejected: ${check.reason}`);
              this.lastRegionReport = {
                available: true, cancelled: false, displayId: mapping.displayId,
                scaleFactor: mapping.scaleFactor, dipBounds: dip, physicalBounds: physical,
                captured: null, pixelCount: 0, dpiResult: dpiNote, eventId: null,
                error: check.reason, at,
              };
              return;
            }
          }
          const ev = await this.screenManager.captureManualRegion(dip);
          const info = this.screenManager.lastFrameInfo;
          const captured = info ? { width: info.width, height: info.height, bytes: info.bytes } : null;
          const pixelCount = captured ? captured.width * captured.height : 0;
          this.lastRegionReport = {
            available: true,
            cancelled: false,
            displayId: disp?.id ?? null,
            scaleFactor: disp?.scaleFactor ?? null,
            dipBounds: dip,
            physicalBounds: physical,
            captured,
            pixelCount,
            dpiResult: dpiNote,
            eventId: ev?.id || null,
            textChars: (ev?.text || "").length,
            error: ev ? "" : "pipeline produced no event (empty OCR?)",
            at,
          };
          if (!ev) this.noteError("screen:region", "manual region capture produced no event");
        } catch (err) {
          const msg = String(err).slice(0, 300);
          logger.warn("Manual region capture failed", msg);
          this.noteError("screen:region", msg);
          this.lastRegionReport = { available: true, cancelled: false, error: msg, at };
        }
      })();
    });
    ipcMain.on("intervia:screen:select-cancelled", () => {
      this.closeRegionSelector();
      this.lastRegionReport = { available: true, cancelled: true, note: "selection cancelled (Escape/tiny drag) — no side effects", at: Date.now() };
    });
    ipcMain.handle("intervia:screen:snapshot", () => this.screenManager.getRecentEvents(10));
    // Manual question input flows through the SAME detection + answer pipeline.
    ipcMain.handle("intervia:question:submit", (_evt, text: unknown) => {
      const t = String(text || "").trim();
      if (!t) return null;
      const cls = this.questionDetector.classify(t);
      const now = Date.now();
      if (!this.questionDetector.shouldEmit(t, now)) return null;
      const q: QuestionDetectedEvent = {
        id: `manual-${now.toString(36)}`,
        question: t,
        speaker: "interviewer",
        source: "system",
        type: cls.isQuestion ? cls.type : "general",
        confidence: cls.isQuestion ? cls.confidence : 0.6,
        timestamp: now,
        transcriptEventId: `manual:${now}`,
        recentContext: this.context.recent(10),
        origin: "audio",
      };
      this.questionDetector.remember(t, q.id, now);
      this.onQuestion(q);
      return q;
    });
    ipcMain.handle("intervia:capture:toggle", () => {
      if (this.capturing) this.stopCapture(); else this.startCapture();
      return this.capturing;
    });
    ipcMain.handle("intervia:capture:start", () => { this.startCapture(); return this.capturing; });
    ipcMain.handle("intervia:capture:stop", () => { this.stopCapture(); return false; });
    ipcMain.handle("intervia:context:clear", () => { this.context.clear(); });
    ipcMain.handle("intervia:context:snapshot", () => this.context.snapshot());
    ipcMain.handle("intervia:question:reset-dedup", () => { this.questionDetector.resetDedup(); });
    ipcMain.on("intervia:answer:error-subscribe", (evt) => {
      const wc = evt.sender;
      const send = (e: unknown) => wc.send("intervia:answer:error", e);
      const handler = (err: { questionId: string; message: string }) => send(err);
      this.answerEngine.on("answer-error", handler);
      wc.on("destroyed", () => this.answerEngine.removeListener("answer-error", handler));
    });
    ipcMain.handle("intervia:settings:open", () => {
      this.openSettingsWindow();
      return true;
    });
    ipcMain.on("intervia:overlay:hide", () => {
      try {
        this.overlayWindow?.hide();
      } catch {
        // ignore
      }
    });
    // Production Quit: terminates the app (not a hide). Overlay button,
    // tray menu, and Ctrl+Shift+Q all converge here.
    ipcMain.handle("intervia:app:quit", () => {
      this.requestQuit("ipc");
      return true;
    });

    this.registerCandidateIpc();
    this.registerDiagnosticsIpc();
    this.registerAudioDeviceIpc();
    this.registerProviderConfigIpc();

    this.transcriptionManager.on("transcript", (e: TranscriptEvent) => {
      for (const l of this.transcriptListeners) l(e);
      if (e.source === "microphone") {
        this.status.microphone = { ...(this.status.microphone || { source: "microphone", active: true, sampleRate: config.audio.targetSampleRate, channels: 1, format: "PCM16" }), active: true };
      } else {
        this.status.system = { ...(this.status.system || { source: "system", active: true, sampleRate: config.audio.targetSampleRate, channels: 1, format: "PCM16" }), active: true };
      }
      this.status.transcription = "listening";
      this.broadcastStatus();
    });
  }

  /** Profiles, personas, JDs, sessions, diagnostics (compact IPC for the settings window). */
  private registerCandidateIpc(): void {
    const needStores = (): boolean => !!(this.profileStore && this.personaStore && this.jdStore && this.dataStorage);

    // --- profiles ---
    ipcMain.handle("intervia:profiles:list", () => (this.profileStore?.list() || []).map((p) => ({ id: p.id, name: p.name, headline: p.headline, updatedAt: p.updatedAt })));
    ipcMain.handle("intervia:profiles:get", (_e, id: unknown) => this.profileStore?.get(String(id)) || null);
    ipcMain.handle("intervia:profiles:save", (_e, profile: unknown) => {
      if (!this.profileStore) throw new Error("storage unavailable");
      const saved = this.profileStore.save(profile as CandidateProfile);
      this.syncCandidateStatus();
      return saved;
    });
    ipcMain.handle("intervia:profiles:create", (_e, name: unknown) => {
      if (!this.profileStore) throw new Error("storage unavailable");
      const p = emptyProfile(String(name || "Untitled Candidate").slice(0, 200));
      return this.profileStore.save(p);
    });
    ipcMain.handle("intervia:profiles:delete", (_e, id: unknown) => {
      const ok = this.profileStore?.delete(String(id)) || false;
      if (this.selection.activeProfileId === String(id)) {
        this.selection.activeProfileId = undefined;
        this.persistSelection();
      }
      this.syncCandidateStatus();
      return ok;
    });
    ipcMain.handle("intervia:profiles:set-active", (_e, id: unknown) => {
      this.selection.activeProfileId = String(id);
      this.persistSelection();
      this.syncCandidateStatus();
      return true;
    });
    ipcMain.handle("intervia:profiles:patch", (_e, id: unknown, patch: unknown) => {
      if (!this.profileStore) throw new Error("storage unavailable");
      const p = this.profileStore.get(String(id));
      if (!p) throw new Error("profile not found");
      const { addedFacts } = applyProfilePatch(p, (patch || {}) as Parameters<typeof applyProfilePatch>[1]);
      const saved = this.profileStore.save(p);
      this.syncCandidateStatus();
      return { profile: saved, addedFacts: addedFacts.length };
    });
    // Full editor save: prune previously generated user-entered facts, then
    // re-derive them from the edited fields. Resume-sourced facts (source =
    // "resume" + evidence) are never touched — provenance stays clean and
    // repeated saves cannot pile duplicates.
    ipcMain.handle("intervia:profiles:save-editor", (_e, id: unknown, patch: unknown) => {
      if (!this.profileStore) throw new Error("storage unavailable");
      const p = this.profileStore.get(String(id));
      if (!p) throw new Error("profile not found");
      pruneManagedUserFacts(p);
      const { addedFacts } = applyProfilePatch(p, (patch || {}) as Parameters<typeof applyProfilePatch>[1]);
      const saved = this.profileStore.save(p);
      this.syncCandidateStatus();
      return { profile: saved, addedFacts: addedFacts.length };
    });
    ipcMain.handle("intervia:profiles:import", async () => {
      if (!needStores()) throw new Error("storage unavailable");
      const res = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Resumes", extensions: ["pdf", "docx", "txt", "md"] }] });
      if (res.canceled || res.filePaths.length === 0) return null;
      const filePath = res.filePaths[0];
      const resume = await extractResumeText(filePath);
      // Prefer LLM-assisted extraction when any free cloud tier is keyed,
      // otherwise deterministic (app must still start/work offline).
      const readiness = this.freeTierReadiness();
      const cloudReady = !!(readiness.gemini || readiness.openrouter);
      let extracted;
      if (cloudReady) {
        try {
          const pair = this.buildLlmPair();
          extracted = await extractProfileWithLLM(resume.text, pair.strong, { fileName: resume.fileName, fileKind: resume.kind });
        } catch (e) {
          this.noteError("resume-import", String(e));
          logger.warn("LLM extraction failed, deterministic fallback", String(e));
          extracted = extractProfileDeterministic(resume.text, { fileName: resume.fileName, fileKind: resume.kind });
        }
      } else {
        extracted = extractProfileDeterministic(resume.text, { fileName: resume.fileName, fileKind: resume.kind });
      }
      if (extracted.profile.name === "Untitled Candidate") {
        extracted.profile.name = resume.fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 200) || "Imported Candidate";
      }
      const saved = this.profileStore!.save(extracted.profile);
      this.selection.activeProfileId = saved.id;
      this.persistSelection();
      this.syncCandidateStatus();
      return { profile: saved, method: extracted.method, warnings: extracted.warnings, pages: resume.pages };
    });

    // --- personas + mode ---
    ipcMain.handle("intervia:personas:list", () => this.personaStore?.list() || []);
    ipcMain.handle("intervia:personas:save", (_e, persona: unknown) => {
      if (!this.personaStore) throw new Error("storage unavailable");
      return this.personaStore.save(persona as Persona);
    });
    ipcMain.handle("intervia:personas:create", (_e, name: unknown) => {
      if (!this.personaStore) throw new Error("storage unavailable");
      return this.personaStore.save(emptyPersona(String(name || "Untitled Persona").slice(0, 200)));
    });
    ipcMain.handle("intervia:personas:delete", (_e, id: unknown) => {
      const ok = this.personaStore?.delete(String(id)) || false;
      if (this.selection.activePersonaId === String(id)) {
        this.selection.activePersonaId = undefined;
        this.persistSelection();
      }
      this.syncCandidateStatus();
      return ok;
    });
    ipcMain.handle("intervia:personas:set-active", (_e, id: unknown) => {
      this.selection.activePersonaId = id ? String(id) : undefined;
      this.persistSelection();
      this.syncCandidateStatus();
      return true;
    });
    ipcMain.handle("intervia:mode:set", (_e, mode: unknown) => {
      this.selection.candidateMode = mode === "mock" ? "mock" : "real";
      this.persistSelection();
      this.syncCandidateStatus();
      return this.selection.candidateMode;
    });
    ipcMain.handle("intervia:mode:get", () => this.getCandidateMode());

    // --- job descriptions ---
    ipcMain.handle("intervia:jds:list", () => (this.jdStore?.list() || []).map((j) => ({ id: j.id, title: j.title, company: j.company, updatedAt: j.updatedAt })));
    ipcMain.handle("intervia:jds:get", (_e, id: unknown) => this.jdStore?.get(String(id)) || null);
    ipcMain.handle("intervia:jds:save-text", (_e, title: unknown, rawText: unknown) => {
      if (!this.jdStore) throw new Error("storage unavailable");
      const parsed = parseJobDescriptionText(String(rawText || ""));
      if (title && String(title).trim()) parsed.title = String(title).trim().slice(0, 300);
      const saved = this.jdStore.save(parsed);
      if (!this.selection.activeJDId) {
        this.selection.activeJDId = saved.id;
        this.persistSelection();
      }
      this.syncCandidateStatus();
      return saved;
    });
    ipcMain.handle("intervia:jds:save", (_e, jd: unknown) => {
      if (!this.jdStore) throw new Error("storage unavailable");
      const saved = this.jdStore.save(jd as JobDescription);
      this.syncCandidateStatus();
      return saved;
    });
    ipcMain.handle("intervia:jds:create", (_e, title: unknown) => {
      if (!this.jdStore) throw new Error("storage unavailable");
      return this.jdStore.save(emptyJD(String(title || "Untitled Role").slice(0, 300)));
    });
    ipcMain.handle("intervia:jds:delete", (_e, id: unknown) => {
      const ok = this.jdStore?.delete(String(id)) || false;
      if (this.selection.activeJDId === String(id)) {
        this.selection.activeJDId = undefined;
        this.persistSelection();
      }
      this.syncCandidateStatus();
      return ok;
    });
    ipcMain.handle("intervia:jds:set-active", (_e, id: unknown) => {
      this.selection.activeJDId = id ? String(id) : undefined;
      this.persistSelection();
      this.syncCandidateStatus();
      return true;
    });

    // --- sessions / history ---
    ipcMain.handle("intervia:sessions:list", () => {
      if (this.sessionStore) return this.sessionStore.index();
      return this.sessionManager.listSessions().map((s) => ({ id: s.id, startTime: s.startTime, status: s.status, questionCount: s.questions.length, candidateMode: s.candidateMode }));
    });
    ipcMain.handle("intervia:sessions:get", (_e, id: unknown) => {
      return this.sessionManager.getSession(String(id)) || this.sessionStore?.load(String(id)) || null;
    });
    ipcMain.handle("intervia:sessions:active", () => this.sessionManager.getActiveSession());
    ipcMain.handle("intervia:sessions:clear", (_e, id: unknown) => {
      const ok = this.sessionManager.clearSession(String(id));
      this.sessionStore?.delete(String(id));
      this.syncCandidateStatus();
      return ok;
    });
    ipcMain.handle("intervia:sessions:clear-all", () => {
      for (const s of this.sessionManager.listSessions()) this.sessionManager.clearSession(s.id);
      this.sessionStore?.clearAll();
      this.syncCandidateStatus();
      return true;
    });

    // --- provider diagnostics (3-tier free stack; legacy adapters stay internal) ---
    ipcMain.handle("intervia:providers:diagnose", async (_e, probe: unknown) => {
      const pair = this.buildLlmPair();
      const fastTiers = pair.fast.tierStatus();
      const geminiModel = effectiveGeminiModel(this.providerConfig);
      const openRouterModel = effectiveOpenRouterModel(this.providerConfig);
      const byTier = new Map(fastTiers.map((t) => [t.tier, t]));
      const gemini = new GeminiFreeProvider({ model: geminiModel });
      const openRouter = new OpenRouterFreeProvider({ model: openRouterModel });
      const local = new LocalAIProvider();
      void byTier;
      return diagnoseProviders(
        [
          { provider: gemini, model: geminiModel, role: "gemini-free" },
          { provider: openRouter, model: openRouterModel, role: "openrouter-free" },
          { provider: local, model: "local-ai", role: "local" },
        ],
        { probe: probe === true, timeoutMs: 8000 }
      );
    });
  }

  /** Provider configuration: user-facing Setup UI (values only, never secrets out). */
  private registerProviderConfigIpc(): void {
    ipcMain.handle("intervia:providers:get-config", async () => {
      let keys: ProviderKeys = {};
      try {
        if (this.dataStorage) keys = loadProviderKeys(this.dataStorage);
      } catch {
        // ignore
      }
      const kp = keysPresent(keys);
      const readiness = this.freeTierReadiness();
      // Local-first screen backends (names + availability only, never pixels).
      let screen: Record<string, unknown> = { ocrLabel: "MOCK OCR", visionLabel: "Mock", visionMode: this.providerConfig.visionMode };
      try {
        const backends = await this.screenManager.describeBackends();
        const visionFriendly = /gemini/i.test(backends.visionName || "")
          ? "Gemini Free"
          : /openai|openrouter/i.test(backends.visionName || "")
            ? "Remote"
            : /mock/i.test(backends.visionName || "")
              ? "Mock"
              : String(backends.visionName || "Mock");
        screen = {
          ocrName: backends.ocrName,
          ocrAvailable: backends.ocrAvailable,
          ocrLabel: backends.ocrLabel,
          visionName: backends.visionName,
          visionAvailable: backends.visionAvailable,
          visionLabel: visionFriendly,
          visionMode: backends.visionMode,
        };
      } catch {
        // keep defaults
      }
      return {
        config: { ...this.providerConfig },
        keysPresent: kp,
        answerLength: this.selection.answerLength || config.reasoning.answerLength,
        answerProviders: this.status.answerProviderName || "",
        sttProviderName: this.transcriptionManager.getProviderName(),
        screen,
        // 3-tier summary for the simplified Setup UI (presence-only).
        freeTier: {
          geminiModel: effectiveGeminiModel(this.providerConfig),
          openRouterModel: effectiveOpenRouterModel(this.providerConfig),
          localEnabled: this.providerConfig.localEnabled !== false,
          geminiReady: readiness.gemini,
          openrouterReady: readiness.openrouter,
          localReady: readiness.local,
        },
      };
    });
    ipcMain.handle("intervia:providers:set-config", async (_evt, payload: unknown) => {
      const o = (payload || {}) as Record<string, unknown>;
      const warnings: string[] = [];
      try {
        // Merge: fields absent from the payload keep their current values
        // (e.g. an answer-length-only save must not reset providers).
        const base = this.providerConfig;
        const mergedRaw = {
          fastProvider: o.fastProvider !== undefined ? o.fastProvider : base.fastProvider,
          fastModel: o.fastModel !== undefined ? o.fastModel : base.fastModel,
          strongProvider: o.strongProvider !== undefined ? o.strongProvider : base.strongProvider,
          strongModel: o.strongModel !== undefined ? o.strongModel : base.strongModel,
          sttProvider: o.sttProvider !== undefined ? o.sttProvider : base.sttProvider,
          visionMode: o.visionMode !== undefined ? o.visionMode : base.visionMode,
          // 3-tier normal UI fields (plus advanced openRouterModel override).
          geminiModel: o.geminiModel !== undefined ? o.geminiModel : base.geminiModel,
          openRouterModel: o.openRouterModel !== undefined ? o.openRouterModel : base.openRouterModel,
          localEnabled: o.localEnabled !== undefined ? o.localEnabled : base.localEnabled,
        };
        if (this.dataStorage) {
          this.providerConfig = saveProviderConfig(this.dataStorage, sanitizeProviderConfig(mergedRaw));
          if (o.keys && typeof o.keys === "object") saveProviderKeys(this.dataStorage, sanitizeProviderKeys(o.keys));
        } else {
          this.providerConfig = sanitizeProviderConfig(mergedRaw);
          applyKeysToEnv(sanitizeProviderKeys(o.keys));
        }
        const len = String(o.answerLength || "").toLowerCase();
        if (len === "short" || len === "medium" || len === "detailed") {
          this.selection.answerLength = len as "short" | "medium" | "detailed";
          this.persistSelection();
        }
        const { sttDeferred } = await this.applyProviderConfig();
        if (sttDeferred) warnings.push("STT provider applies after you Stop capture (audio running).");
        logger.info("Provider config saved", { answerProviders: this.status.answerProviderName });
        const readiness = this.freeTierReadiness();
        return { ok: true, answerProviders: this.status.answerProviderName || "", warnings, freeTier: readiness };
      } catch (e) {
        logger.warn("Provider config save failed", String(e));
        return { ok: false, error: String(e).slice(0, 300), warnings };
      }
    });
  }

  /** Audio device selection: list/select/persist/refresh (Setup + Diagnostics UI). */
  private registerAudioDeviceIpc(): void {
    const snapshot = (): Record<string, unknown> => {
      const s = this.deviceManager.getState();
      return {
        ...s,
        micIdShort: shortDeviceId(s.selectedMicId),
        outputIdShort: shortDeviceId(s.selectedOutputId),
        loopbackNote: LOOPBACK_NOTE,
      };
    };
    ipcMain.handle("intervia:audio-devices:get", () => snapshot());
    ipcMain.on("intervia:audio-devices:report", (_evt, devices: unknown) => {
      try {
        const list = Array.isArray(devices) ? devices : [];
        const clean = list
          .filter((d) => d && typeof d === "object")
          .map((d: any) => ({
            id: String(d.id || "").slice(0, 512),
            label: String(d.label || "").slice(0, 120),
            kind: d.kind === "output" ? ("output" as const) : ("input" as const),
            isDefault: !!d.isDefault,
          }))
          .filter((d) => d.id.length > 0);
        if (clean.length > 0) this.deviceManager.updateDeviceList(clean);
      } catch (e) {
        logger.warn("settings device report ingest failed", String(e));
      }
    });
    ipcMain.handle("intervia:audio-devices:select-mic", (_evt, id: unknown) => {
      const res = this.deviceManager.selectInputDevice(id);
      if (!res.ok) this.noteError("audio:microphone", String(res.error || "microphone selection failed"));
      else logger.info("microphone selected", { id: shortDeviceId(this.deviceManager.getSelectedMicId()) });
      // The live monitor must follow the newly selected device immediately:
      // restart it so the meter represents the CURRENT microphone, never a
      // stale one. (Output reselection needs no restart — loopback captures
      // the system mix regardless; Play routes at click time.)
      if (res.ok && this.monitorActive) {
        try {
          this.stopMonitor();
        } catch {
          // ignore; resume attempt below still runs
        }
        this.maybeResumeMonitor();
      }
      return { ...res, micIdShort: shortDeviceId(res.state.selectedMicId), loopbackNote: LOOPBACK_NOTE };
    });
    ipcMain.handle("intervia:audio-devices:select-output", (_evt, id: unknown) => {
      const res = this.deviceManager.selectOutputDevice(id);
      if (!res.ok) this.noteError("audio:system", String(res.error || "output selection failed"));
      else logger.info("output selected", { id: shortDeviceId(this.deviceManager.getSelectedOutputId()) });
      return { ...res, outputIdShort: shortDeviceId(res.state.selectedOutputId), loopbackNote: LOOPBACK_NOTE };
    });
    ipcMain.handle("intervia:audio-devices:reset", (_evt, kind: unknown) => {
      const state = this.deviceManager.resetToDefault(kind === "output" ? "output" : "input");
      return { ...snapshot(), state };
    });
    ipcMain.handle("intervia:audio-devices:refresh", () => {
      const info = this.deviceManager.refreshDevices();
      return { ...snapshot(), ...info, needsRendererEnum: true };
    });
    // Setup "Play" output-test tone outcome (renderer reports what happened;
    // main records it for diagnostics). Validates + never throws.
    ipcMain.handle("intervia:audio-devices:output-test", (_evt, result: unknown) => {
      try {
        const r = (result || {}) as Record<string, unknown>;
        const report = this.deviceManager.recordOutputTest({
          deviceId: r.deviceId,
          routed: r.routed,
          ok: r.ok,
          error: r.error,
        });
        logger.info("output test tone", {
          device: report.deviceIdShort,
          routed: report.routed,
          ok: report.ok,
          error: report.error || undefined,
        });
        return { ok: true, report };
      } catch (e) {
        logger.warn("output-test report ingest failed", String(e));
        return { ok: false, error: String(e).slice(0, 300) };
      }
    });
  }

  private registerDiagnosticsIpc(): void {
    ipcMain.handle("intervia:diagnostics:open", () => {
      const win = new BrowserWindow({
        width: 800, height: 600,
        webPreferences: {
          preload: path.join(__dirname, "..", "preload", "overlay-preload.js"),
          contextIsolation: true, nodeIntegration: false,
        }
      });
      win.removeMenu();
      win.loadFile(path.join(__dirname, "..", "renderer", "diagnostics.html"));
      this.diagnosticsWindows.add(win);
      win.on("closed", () => {
        this.diagnosticsWindows.delete(win);
      });
      return true;
    });
    
    ipcMain.handle("intervia:diagnostics:run-system", async () => {
      const geminiModel = effectiveGeminiModel(this.providerConfig);
      const openRouterModel = effectiveOpenRouterModel(this.providerConfig);
      const providers = await diagnoseProviders(
        [
          { provider: new GeminiFreeProvider({ model: geminiModel }), model: geminiModel, role: "gemini-free" },
          { provider: new OpenRouterFreeProvider({ model: openRouterModel }), model: openRouterModel, role: "openrouter-free" },
          { provider: new LocalAIProvider(), model: "local-ai", role: "local" },
        ],
        { probe: true, timeoutMs: 5000 }
      );
      
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
        physicalSize: {
          width: Math.floor(d.bounds.width * d.scaleFactor),
          height: Math.floor(d.bounds.height * d.scaleFactor),
        },
      }));

      let tesseractInstalled = false;
      try {
        tesseractInstalled = await new TesseractOCRProvider({ timeoutMs: 5000 }).isAvailable();
      } catch {
        tesseractInstalled = false;
      }

      const ocrBackend = this.screenManager.getOcrName();
      const visionBackend = this.screenManager.getVisionName();
      const sttProvider = this.transcriptionManager.getProviderName();
      let sttConnected = false;
      try {
        sttConnected = this.transcriptionManager.isProviderReady();
      } catch {
        sttConnected = false;
      }
      const audioStates = this.classifyCachedAudio();

      return {
        system: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          electron: process.versions.electron,
          node: process.versions.node,
          appVersion: app.getVersion(),
        },
        providers,
        providerModes: {
          geminiFree: providerModeLabel("gemini-free", effectiveGeminiModel(this.providerConfig)),
          openrouterFree: providerModeLabel("openrouter-free", effectiveOpenRouterModel(this.providerConfig)),
          local: providerModeLabel("local-ai", "local-ai"),
        },
        displays,
        overlay: {
          captureExclusionSupported: isCaptureExclusionSupported()
        },
        transcription: {
          providerName: sttProvider,
          status: this.status.transcription,
          connected: sttConnected,
          note: sttConnected ? "STT backend reachable" : "STT: NOT CONNECTED (mock fallback in use — explicit, never silent)",
          error: this.status.errorMessage,
          detail: this.transcriptionStatusDetail(sttConnected),
        },
        audio: {
          capturing: this.capturing,
          levels: this.audioManager.getLevels(),
          states: audioStates,
          rendererStats: this.audioManager.getRendererStats(),
          devices: {
            ...this.deviceManager.getState(),
            micIdShort: shortDeviceId(this.deviceManager.getSelectedMicId()),
            outputIdShort: shortDeviceId(this.deviceManager.getSelectedOutputId()),
            loopbackNote: LOOPBACK_NOTE,
            outputTests: this.deviceManager.getOutputTests(),
          },
        },
        ocr: {
          backend: ocrBackend,
          kind: tesseractInstalled ? "REAL OCR (tesseract installed)" : (ocrBackend.toLowerCase().includes("mock") ? "MOCK OCR (tesseract not installed)" : ocrBackend),
          tesseractInstalled,
        },
        vision: {
          backend: visionBackend,
          kind: visionBackend.toLowerCase().includes("mock") ? "MOCK VISION" : visionBackend,
          mode: config.vision.mode,
        },
        screen: {
          monitoring: this.screenCapture.isMonitoring(),
        },
        errors: [...this.recentErrors].slice(-20),
      };
    });

    ipcMain.handle("intervia:diagnostics:test-mic", async () => {
      return this.probeAudioSource("microphone", { mic: true, system: false });
    });

    ipcMain.handle("intervia:diagnostics:test-sys-audio", async () => {
      return this.probeAudioSource("system", { mic: false, system: true });
    });

    ipcMain.handle("intervia:diagnostics:stop-audio", async () => {
      try {
        this.audioManager.stop();
      } catch {
        // ignore
      }
      this.transcriptionManager.stop();
      return "Audio stopped.";
    });

    ipcMain.handle("intervia:diagnostics:audio-levels", async () => {
      return this.audioManager.getLevels();
    });

    ipcMain.handle("intervia:diagnostics:export", async () => {
      const res = await dialog.showSaveDialog({
        title: "Export Intervia diagnostics (redacted)",
        defaultPath: `intervia-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (res.canceled || !res.filePath) return null;
      const doc = this.buildExportDocument();
      fs.writeFileSync(res.filePath, doc, "utf8");
      return { path: res.filePath, bytes: doc.length };
    });

    ipcMain.handle("intervia:diagnostics:test-pipeline", async () => {
      const startFast = Date.now();
      let fastTime = 0, strongTime = 0;
      const pair = this.buildLlmPair();
      const f = pair.fast;
      const s = pair.strong;
      
      const prompt = "What is the difference between an array and a linked list?";
      let fastRes = "Error";
      try {
        const res = await f.generate({ prompt, maxTokens: 20 });
        fastRes = res.text;
        fastTime = Date.now() - startFast;
      } catch (e) { fastRes = String(e); }

      const startStrong = Date.now();
      let strongRes = "Error";
      try {
        const res = await s.generate({ prompt, maxTokens: 20 });
        strongRes = res.text;
        strongTime = Date.now() - startStrong;
      } catch (e) { strongRes = String(e); }

      return {
        fast: { provider: f.name, latencyMs: fastTime, preview: fastRes },
        strong: { provider: s.name, latencyMs: strongTime, preview: strongRes },
        mode: f.name.includes("mock") ? "MOCK" : "REAL"
      };
    });

    ipcMain.handle("intervia:diagnostics:test-screen", async () => {
      try {
        return await this.screenManager.runDiagnosticTrace();
      } catch (err) {
        const msg = String(err).slice(0, 300);
        this.noteError("screen:trace", msg);
        return { pass: false, failureStage: "capture", capture: { ok: false, error: msg } };
      }
    });

    ipcMain.handle("intervia:diagnostics:screen-frame", async () => {
      return this.screenCapture.captureRawFrame();
    });

    ipcMain.handle("intervia:diagnostics:screen-sources", async () => {
      try {
        return {
          sources: await this.screenCapture.listSources(),
          displays: this.screenCapture.getDisplays(),
        };
      } catch (err) {
        return { sources: [], displays: [], error: String(err).slice(0, 300) };
      }
    });

    ipcMain.handle("intervia:diagnostics:region-report", async () => {
      return this.lastRegionReport;
    });

    ipcMain.handle("intervia:diagnostics:audio-sources", async () => {
      try {
        const all = await this.audioManager.listDesktopSources();
        const displays = all.filter((s) => s.kind === "display");
        const picked = pickSystemSource(displays.map((d) => ({ id: d.id, name: d.name })));
        return {
          displays,
          selected: picked,
          note: picked
            ? `Intervia will capture system audio from "${picked.name}" (deterministic pick, never random)`
            : "no display source available",
        };
      } catch (err) {
        return { displays: [], selected: null, error: String(err).slice(0, 300) };
      }
    });

    ipcMain.handle("intervia:diagnostics:test-sim", async () => {
      // Sandboxed end-to-end check: own detector/context/engine instances, so
      // the live interview context, session history, and overlay are untouched
      // (diagnostic queries must never be stored as interview history).
      const simDetector = new QuestionDetector();
      const simContext = new InterviewContext();
      const t0 = Date.now();
      const q = "Tell me about a challenging project.";
      const a = "I built a payments service using Node.js and PostgreSQL.";
      const q2 = "What was the biggest challenge?";
      simContext.ingestTranscript({ id: `sim-q-${t0}`, text: q, isFinal: true, source: "system", speaker: "interviewer", timestamp: t0, confidence: 1 });
      const qEv = simDetector.handle({ id: `sim-q-${t0}`, text: q, isFinal: true, source: "system", speaker: "interviewer", timestamp: t0, confidence: 1 }, simContext.recent(10));
      simContext.ingestTranscript({ id: `sim-a-${t0}`, text: a, isFinal: true, source: "microphone", speaker: "candidate", timestamp: t0 + 1000, confidence: 1 });
      const fuEv = simDetector.handle({ id: `sim-q2-${t0}`, text: q2, isFinal: true, source: "system", speaker: "interviewer", timestamp: t0 + 2000, confidence: 1 }, simContext.recent(10));
      const simPair = this.buildLlmPair();
      const engine = new AnswerEngine(new ModelRouter(simPair.fast, simPair.strong));
      const tGen = Date.now();
      const res = await engine.answer({
        questionId: fuEv?.id || `sim-fu-${t0}`,
        question: q2,
        questionType: "follow_up",
        recentContext: simContext.recent(10),
        screenEvents: [],
      });
      simContext.stop();
      return {
        sandboxed: true,
        questionDetected: !!qEv,
        followUpDetected: !!fuEv,
        followUpType: fuEv?.type,
        generationMs: Date.now() - tGen,
        fastChars: res.fast.length,
        strongChars: res.strong.length,
        fastMode: "free-fallback",
        strongMode: "free-fallback",
        note: "Sandboxed: live context/session/history untouched. Check overlay is unchanged.",
      };
    });
  }

  /**
   * Explicit STT backend status for diagnostics: CONFIGURED / CONNECTED /
   * DISCONNECTED / ERROR plus the human reason. Endpoint host only, never
   * any key material (providers exclude secrets from getStatus by contract).
   */
  private transcriptionStatusDetail(connected: boolean): Record<string, unknown> {
    try {
      const s = this.transcriptionManager.getProviderStatus();
      if (s) {
        return {
          state: s.state,
          kind: s.kind,
          endpoint: s.endpoint,
          model: s.model || undefined,
          configured: s.configured,
          connected: s.connected,
          reason: s.connected ? "" : s.lastError || "backend unreachable (see endpoint)",
          lastCheckAt: s.lastCheckAt,
        };
      }
    } catch {
      // fall through to the legacy fallback below
    }
    return {
      state: connected ? "CONNECTED" : "DISCONNECTED",
      connected,
      reason: connected ? "" : "backend unreachable",
      lastCheckAt: 0,
    };
  }

  /**
   * Classify the currently-cached renderer stats (for run-system snapshots).
   * States: READY (never started) / STREAM CREATED / FRAMES RECEIVING /
   * NO FRAMES / ERROR. "READY" is only reported when capture never ran;
   * anything started-but-silent is NO FRAMES or ERROR — never misleading.
   */
  private classifyCachedAudio(): Record<string, { state: string; receiving: boolean; chunks: number }> {
    const out: Record<string, { state: string; receiving: boolean; chunks: number }> = {};
    const cached = this.audioManager.getRendererStats();
    for (const source of ["microphone", "system"] as const) {
      const r = cached[source];
      if (!r) {
        out[source] = { state: "READY", receiving: false, chunks: 0 };
        continue;
      }
      const streamCreated = !!(r.streamActive || r.sampleRate > 0 || r.chunks > 0);
      const c = classifyAudioProbe({
        streamCreated,
        rendererChunks: r.chunks,
        mainChunks: 0,
        trackEnded: !!r.trackEnded,
        lastError: r.lastError || "",
      });
      out[source] = { state: c.state, receiving: c.receiving, chunks: r.chunks };
    }
    return out;
  }

  /**
   * Real device probe for one audio source: opens the capture window with
   * ONLY that source enabled, counts chunks + bytes + peak level for ~5s,
   * then closes it. Refuses while a real capture is running.
   *
   * Success = AUDIO FRAMES ACTUALLY RECEIVED by main (chunks > 0, bytes > 0).
   * A bare MediaStream / STREAM CREATED without frames is reported honestly
   * and counts as failure — stream creation alone is never success.
   */
  private async probeAudioSource(
    source: "microphone" | "system",
    opts: { mic: boolean; system: boolean }
  ): Promise<Record<string, unknown>> {
    // The Setup monitor (levels-only) yields to probes: pause it, probe the
    // real device, then resume it so the meters never go dark.
    const hadMonitor = this.monitorActive;
    if (hadMonitor) this.stopMonitor();
    if (this.audioManager.isRunning()) {
      const refused = { source, ok: false, state: "ERROR", reason: "Capture is running — stop it first, then test." };
      if (hadMonitor) this.maybeResumeMonitor();
      return refused;
    }
    this.audioManager.resetLevels();
    let chunks = 0;
    let bytes = 0;
    let peak = 0;
    let sumSq = 0;
    let sampleCount = 0;
    const errMark = this.recentErrors.length;
    const devState = this.deviceManager.getState();
    const probeOpts = {
      ...opts,
      micDeviceId: source === "microphone" ? this.deviceManager.getEffectiveMicDeviceId() : null,
      systemOutputLabel: source === "system" ? devState.outputLabel : undefined,
    };
    const selectedForProbe =
      source === "microphone"
        ? { id: devState.selectedMicId, idShort: shortDeviceId(devState.selectedMicId), label: devState.micLabel, status: devState.micStatus }
        : { id: devState.selectedOutputId, idShort: shortDeviceId(devState.selectedOutputId), label: devState.outputLabel, status: devState.outputStatus, loopbackNote: LOOPBACK_NOTE };
    this.audioManager.start(
      (src, pcm) => {
        if (src !== source) return;
        chunks += 1;
        bytes += pcm.byteLength;
        // Peak over a stride (cheap) but RMS over EVERY sample: rms must be
        // sum(x^2)/N with the true N, otherwise the reported level is wrong.
        let strideSum = 0;
        let strideN = 0;
        for (let i = 0; i < pcm.length; i++) {
          const v = pcm[i] / 32768;
          const sq = v * v;
          sumSq += sq;
          sampleCount += 1;
          if ((i & 7) === 0) {
            strideSum += sq;
            strideN += 1;
          }
        }
        const strideRms = Math.sqrt(strideSum / Math.max(1, strideN));
        if (strideRms > peak) peak = strideRms;
      },
      probeOpts
    );
    // ~5s window with periodic stats pulls so renderer state is fresh.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        this.audioManager.queryRendererStats();
      } catch {
        // ignore
      }
    }
    try {
      this.audioManager.queryRendererStats();
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      this.audioManager.stop();
    } catch {
      // ignore
    }
    const levels = this.audioManager.getLevels();
    const info = (levels as Record<string, { level: number; chunks: number; at: number }>)[source];
    const r = this.audioManager.getRendererStats()[source];
    const streamCreated = !!((r && (r.streamActive || r.sampleRate > 0 || r.chunks > 0)) || chunks > 0);
    const classification = classifyAudioProbe({
      streamCreated,
      rendererChunks: r?.chunks || 0,
      mainChunks: chunks,
      trackEnded: !!r?.trackEnded,
      lastError: r?.lastError || "",
    });
    const peakRounded = Math.round(peak * 1000) / 1000;
    const rmsAll = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;
    const rmsRounded = Math.round(rmsAll * 10000) / 10000;
    const rmsDb = rmsAll > 0 ? Math.max(-60, 20 * Math.log10(Math.max(0.001, Math.min(1, rmsAll)))) : -60;
    const ok = chunks > 0 && bytes > 0;
    const audible = peak > 0.005;
    // Signal classification: frames alone are NOT signal. Non-zero captured
    // amplitude is required before claiming anything was heard.
    const signal = !ok
      ? (classification.state === "STREAM CREATED" ? "NO FRAMES" : classification.state)
      : audible
        ? "SIGNAL DETECTED"
        : "SILENT SIGNAL";
    let sttConnected = false;
    try {
      sttConnected = this.transcriptionManager.isProviderReady();
    } catch {
      sttConnected = false;
    }
    const newErrors = this.recentErrors.slice(errMark).filter((e) => String(e.source).includes(source)).slice(-5);
    if (hadMonitor) this.maybeResumeMonitor();
    return {
      source,
      ok,
      state: ok ? "FRAMES RECEIVING" : classification.state,
      receiving: chunks > 0,
      streamCreated,
      selectedDevice: selectedForProbe,
      permission: r?.permission || "unknown",
      device: r?.deviceLabel || "(no device reported)",
      streamActive: !!r?.streamActive,
      track: {
        readyState: r?.trackReadyState || "none",
        muted: r?.trackMuted ?? null,
        enabled: r?.trackEnabled ?? null,
        ended: !!r?.trackEnded,
      },
      sampleRate: r?.sampleRate || 0,
      channels: r?.channelCount || 0,
      ctxState: r?.ctxState || "none",
      chunks,
      bytesReceived: bytes,
      peakLevel: peakRounded,
      rmsLevel: rmsRounded,
      rmsDb: Math.round(rmsDb * 10) / 10,
      audible,
      signal,
      rendererChunks: r?.chunks || 0,
      rendererBytes: r?.bytes || 0,
      rendererPeak: r?.peakRms || 0,
      rendererRms: r?.lastRms || 0,
      rendererDb: Number.isFinite(Number(r?.lastDb)) ? Number(r?.lastDb) : -60,
      rendererLevel: info?.level || 0,
      stt: {
        provider: this.transcriptionManager.getProviderName(),
        connected: sttConnected,
        note: sttConnected ? "frames will be transcribed" : "STT: NOT CONNECTED (frames received but no backend to transcribe them)",
      },
      errors: newErrors,
      note: ok
        ? (audible
          ? "Device delivered audible audio frames end to end."
          : "Frames arrived but near-silence: speak/play sound and re-run to see peakLevel move.")
        : (classification.state === "STREAM CREATED"
          ? "STREAM CREATED but NO FRAMES arrived — check AudioContext state, device mute, and recent errors."
          : "No audio arrived — check device, permissions, and recent errors."),
    };
  }

  private buildExportDocument(): string {
    const sessions = this.sessionManager.listSessions().slice(0, 20);
    let fastTotal = 0;
    let fastN = 0;
    let strongTotal = 0;
    let strongN = 0;
    let answerCount = 0;
    for (const s of sessions) {
      for (const a of s.answers || []) {
        answerCount += 1;
        if (a.role === "fast" && a.latencyMs > 0) { fastTotal += a.latencyMs; fastN += 1; }
        if (a.role === "strong" && a.latencyMs > 0) { strongTotal += a.latencyMs; strongN += 1; }
      }
    }
    const active = this.sessionManager.getActiveSession();
    const profile = this.getActiveProfile();
    const jd = this.getActiveJD();
    return buildDiagnosticsExport({
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      exportedAt: Date.now(),
      providers: [],
      transcription: { providerName: this.status.providerName, status: this.status.transcription },
      audio: this.audioManager.getLevels(),
      screen: {
        monitoring: this.screenCapture.isMonitoring(),
        ocr: this.screenManager.getOcrName(),
        tesseractInstalled: false, // resolved on demand via run-system; export stays offline
        vision: this.screenManager.getVisionName(),
        visionMode: config.vision.mode,
      },
      session: {
        status: active ? active.status : "none",
        questions: sessions.reduce((n, s) => n + (s.questions?.length || 0), 0),
        answers: answerCount,
        avgFastMs: fastN > 0 ? Math.round(fastTotal / fastN) : 0,
        avgStrongMs: strongN > 0 ? Math.round(strongTotal / strongN) : 0,
      },
      candidate: { profileName: profile?.name, mode: this.getCandidateMode(), jobTitle: jd?.title },
      errors: [...this.recentErrors].slice(-20),
      configNames: {
        sttProvider: config.provider,
        ocrProvider: config.ocr.provider,
        visionProvider: config.vision.provider,
        answerStack: "gemini-free/openrouter-free/local",
        geminiModel: effectiveGeminiModel(this.providerConfig),
        openRouterModel: effectiveOpenRouterModel(this.providerConfig),
      },
    });
  }

  private onTranscript(e: TranscriptEvent): void {
    // Feed the context buffer. Partial + final handling is inside InterviewContext.
    const entry = this.context.ingestTranscript(e);
    if (!entry) return;
    // Question detection only on finalized interviewer utterances.
    if (e.isFinal && entry.speaker === "interviewer") {
      this.questionDetector.handle(e, this.context.recent(10));
    }
  }

  /**
   * Single convergence point for ALL questions (audio, screen, fused,
   * manual). Everything flows into the same broadcast + AnswerEngine path.
   */
  private onQuestion(q: QuestionDetectedEvent): void {
    // A merged continuation replaces its fragment: the fragment's in-flight
    // generation is cancelled by the new answer() call below, and its
    // recorded answers are marked stale so history shows ONE live answer.
    try {
      if (q.supersedes) {
        const active = this.sessionManager.getActiveSession();
        if (active) this.sessionManager.markAnswersStale(active.id, q.supersedes);
      }
    } catch {
      // never let bookkeeping break the question path
    }
    try {
      const existing = this.context.snapshot().find((e) => e.transcriptEventId === q.transcriptEventId);
      if (!existing) {
        const entry: ContextEntry = {
          id: `ctx-q-${q.id}`,
          speaker: q.speaker,
          source: q.source,
          text: q.fusedContext || q.question,
          timestamp: q.timestamp,
          transcriptEventId: q.transcriptEventId,
          kind: "question",
          metadata: { questionId: q.id, type: q.type, origin: q.origin || "audio" },
        };
        this.ingestContextEntry(entry);
      }
    } catch {
      // never let bookkeeping break the question path
    }
    this.broadcastQuestion(q);
    // Record into the active interview session (Phase 27: ONE pipeline).
    try {
      const active = this.sessionManager.getActiveSession();
      if (active) {
        const rec: SessionQuestionRecord = {
          id: q.id,
          text: q.fusedContext || q.question,
          type: q.type,
          timestamp: q.timestamp,
          source: q.source,
          confidence: q.confidence,
          origin: q.origin || "audio",
        };
        this.sessionManager.recordQuestion(active.id, rec);
      }
    } catch {
      // ignore
    }
    this.syncCandidateStatus();
    if (config.reasoning.enabled) {
      const profile = this.getActiveProfile();
      const persona = this.getActivePersona();
      const jd = this.getActiveJD();
      void this.answerEngine
        .answer({
          questionId: q.id,
          question: q.fusedContext || q.question,
          questionType: q.type,
          recentContext: this.context.recent(config.reasoning.maxRecentEntries),
          screenEvents: this.screenManager.getRecentEvents(5),
          candidateProfile: this.candidateProfile || undefined,
          jobDescription: this.jobDescription || undefined,
          profile: profile || undefined,
          persona: persona || undefined,
          jobDesc: jd || undefined,
          candidateMode: this.getCandidateMode(),
          answerLength: this.selection.answerLength || persona?.answerLength || config.reasoning.answerLength,
          maxScreenChars: config.reasoning.maxScreenChars,
          maxRecentEntries: config.reasoning.maxRecentEntries,
        })
        .catch((err) => logger.warn("AnswerEngine failed", String(err)));
    }
  }

  private onScreenContext(e: ScreenContextEvent): void {
    for (const l of this.screenListeners) {
      try {
        l(e);
      } catch {
        // ignore broken listeners
      }
    }
  }

  private onAnswer(a: AnswerEvent): void {
    // Streaming partials render progressively in the overlay only — they
    // never enter context history or session records (finals only).
    if (a.partial) {
      this.broadcastAnswer(a);
      return;
    }
    // Compact overlay tier status follows the ACTUAL tier used.
    try {
      const tier = String(a.model || "").split(":")[0].toLowerCase();
      if (tier.includes("gemini")) this.status.answerProviderName = "Gemini Free";
      else if (tier.includes("openrouter")) this.status.answerProviderName = "OpenRouter Free (fallback)";
      else if (tier.includes("local")) this.status.answerProviderName = "Local AI (fallback)";
      this.broadcastStatus();
    } catch {
      // status hint never breaks answers
    }
    try {
      this.ingestContextEntry({
        id: `ctx-a-${a.id}`,
        speaker: "candidate",
        source: "microphone",
        text: a.text,
        timestamp: a.timestamp,
        transcriptEventId: `answer:${a.id}`,
        kind: "answer",
        metadata: { questionId: a.questionId, answerKind: a.kind, model: a.model },
      });
    } catch {
      // ignore
    }
    try {
      this.recordSessionAnswer(a.questionId, a.kind, a, "ok");
    } catch {
      // ignore
    }
    for (const l of this.answerListeners) l(a);
  }

  /** Append a pre-built typed entry while respecting the bounded buffer. */
  private ingestContextEntry(entry: ContextEntry): void {
    this.context.ingestTyped(entry);
  }

  private syncScreenStatus(): void {
    const s = this.screenManager.getStatus();
    this.status.screen = {
      monitoring: s.monitoring,
      ocr: s.ocr,
      vision: s.vision,
      visionMode: config.vision.mode,
      lastText: s.lastText,
      lastEventAt: s.lastEventAt,
    };
    this.broadcastStatus();
  }

  /**
   * Setup-window live monitor: runs the EXISTING hidden capture pipeline
   * with a dev-null chunk handler so the Setup meters (and diagnostics
   * levels) move while the user configures devices — without starting an
   * interview. No transcription feed (the handler drops every frame), no
   * session, no answers, no overlay status change. Yields to real capture
   * and diagnostic probes; follows the currently selected microphone.
   */
  private startMonitor(): boolean {
    try {
      if (this.capturing || this.monitorActive) return this.monitorActive;
      if (this.audioManager.isRunning()) return false;
      this.audioManager.resetLevels();
      this.audioManager.start(
        () => {
          // dev-null: levels/stats/IPC still flow; audio frames are dropped.
        },
        {
          mic: true,
          system: true,
          micDeviceId: this.deviceManager.getEffectiveMicDeviceId(),
          systemOutputLabel: this.deviceManager.getState().outputLabel,
        }
      );
      this.monitorActive = this.audioManager.isRunning();
      if (this.monitorActive) logger.info("Setup monitor started (levels-only, no transcription)");
      return this.monitorActive;
    } catch (e) {
      logger.warn("Setup monitor start failed", String(e));
      return false;
    }
  }

  private stopMonitor(): void {
    if (!this.monitorActive) return;
    this.monitorActive = false;
    try {
      // Only release the shared capture window when real capture doesn't own it.
      if (!this.capturing) this.audioManager.stop();
    } catch (e) {
      logger.warn("Setup monitor stop failed", String(e));
    }
  }

  /** Restart the monitor when Setup is open and nothing else owns capture. */
  private maybeResumeMonitor(): void {
    try {
      if (!this.capturing && this.settingsWindow && !this.settingsWindow.isDestroyed()) {
        this.startMonitor();
      }
    } catch {
      // monitor is best-effort; meters simply stay idle without it
    }
  }

  private startCapture(): void {
    if (this.capturing) return;
    this.stopMonitor();
    this.capturing = true;
    // A new interview starts from fresh conversational state: leftover
    // context, question dedup and screen dedup from a previous interview
    // must never suppress or bleed into the new one.
    try {
      this.context.clear();
    } catch {
      // ignore
    }
    try {
      this.questionDetector.resetDedup();
    } catch {
      // ignore
    }
    try {
      this.screenManager.resetHistory();
    } catch {
      // ignore
    }
    this.context.start();
    this.transcriptionManager.start();
    // Interview session lifecycle rides on capture (Phase 15/18).
    try {
      const persona = this.getActivePersona();
      const profile = this.getActiveProfile();
      const jd = this.getActiveJD();
      const session = this.sessionManager.createSession({
        candidateProfileId: profile?.id,
        personaId: persona?.id,
        candidateMode: this.getCandidateMode(),
        jobDescriptionId: jd?.id,
        settings: { answerLength: this.selection.answerLength || persona?.answerLength || config.reasoning.answerLength, visionMode: this.providerConfig.visionMode },
        models: {
          fastProvider: "free-fallback",
          fastModel: effectiveGeminiModel(this.providerConfig),
          strongProvider: "free-fallback",
          strongModel: effectiveGeminiModel(this.providerConfig),
        },
      });
      this.sessionManager.startSession(session.id);
      this.persistActiveSession();
    } catch (e) {
      logger.warn("Session start failed", String(e));
    }
    this.syncCandidateStatus();
    // Screen context rides along with capture (independent toggle available
    // via intervia:screen:start/stop). Monitoring is change-gated and cheap.
    if (config.screen.enabled) {
      try {
        this.screenManager.startAutoMonitoring();
      } catch (e) {
        logger.warn("Screen monitoring failed to start", String(e));
      }
    }
    this.syncScreenStatus();
    this.status.transcription = "processing";
    // Honest STT hint on the overlay provider line (endpoint only, never secrets).
    try {
      if (!this.transcriptionManager.isProviderReady()) {
        const ep = this.transcriptionManager.getProviderStatus()?.endpoint || config.whisper.endpoint;
        this.status.errorMessage =
          `STT offline (transcripts will be mock-labeled) — start whisper-server at ${ep} or set INTERVIA_STT_PROVIDER=groq + INTERVIA_GROQ_API_KEY`;
      } else if (this.status.errorMessage && this.status.errorMessage.startsWith("STT offline")) {
        this.status.errorMessage = undefined;
      }
    } catch {
      // never break capture start on a status hint
    }
    // Honest AI readiness hint (non-blocking: local/vision/audio still work).
    try {
      const r = this.freeTierReadiness();
      if (!r.gemini && !r.openrouter && !r.local && !this.status.errorMessage) {
        this.status.errorMessage = "No AI answer provider available — add a Gemini key in Setup or re-enable Local AI";
      }
    } catch {
      // never break capture start on a status hint
    }
    this.status.microphone = { source: "microphone", active: true, sampleRate: config.audio.targetSampleRate, channels: 1, format: "PCM16" };
    this.status.system = { source: "system", active: true, sampleRate: config.audio.targetSampleRate, channels: 1, format: "PCM16" };
    this.broadcastStatus();

    this.audioManager.start(
      (source, pcm, sr) => this.transcriptionManager.feed(source, pcm),
      {
        mic: true,
        system: true,
        micDeviceId: this.deviceManager.getEffectiveMicDeviceId(),
        systemOutputLabel: this.deviceManager.getState().outputLabel,
      }
    );
    logger.info("Capture started");
  }

  private stopCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.audioManager.stop();
    this.transcriptionManager.stop();
    this.screenManager.stopAutoMonitoring();
    this.screenManager.cancelPending();
    this.answerEngine.cancel();
    try {
      const active = this.sessionManager.getActiveSession();
      if (active) {
        this.sessionManager.endSession(active.id);
        this.sessionStore?.save(active);
      }
    } catch (e) {
      logger.warn("Session end failed", String(e));
    }
    this.syncCandidateStatus();
    if (this.status.microphone) this.status.microphone.active = false;
    if (this.status.system) this.status.system.active = false;
    this.status.transcription = "ready";
    this.broadcastStatus();
    logger.info("Capture stopped");
    // Setup meters go back to the levels-only monitor when it is open.
    this.maybeResumeMonitor();
  }

  private broadcastStatus(): void {
    for (const l of this.statusListeners) l(this.status);
  }

  private broadcastContext(entry: ContextEntry): void {
    for (const l of this.contextListeners) l(entry);
  }

  private broadcastQuestion(q: QuestionDetectedEvent): void {
    for (const l of this.questionListeners) l(q);
  }

  private broadcastAnswer(a: AnswerEvent): void {
    for (const l of this.answerListeners) l(a);
  }
}

function loadTextFile(filePath: string, maxChars: number): string {
  if (!filePath) return "";
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return (text || "").slice(0, maxChars);
  } catch {
    return "";
  }
}

new InterviaApp().start().catch((e) => {
  logger.error("fatal startup error", e);
  app.exit(1);
});