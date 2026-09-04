import { AudioSource, SpeakerRole } from "../../common/types";

const DEFAULT_MAP: Record<AudioSource, SpeakerRole> = {
  microphone: "candidate",
  system: "interviewer",
};

export class SpeakerAttributor {
  private map: Record<AudioSource, SpeakerRole>;

  constructor(custom?: Partial<Record<AudioSource, SpeakerRole>>) {
    this.map = { ...DEFAULT_MAP, ...(custom || {}) };
  }

  attribute(source: AudioSource): SpeakerRole {
    return this.map[source] || "unknown";
  }

  setRole(source: AudioSource, role: SpeakerRole): void {
    this.map[source] = role;
  }
}