import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * The Jev sidecar — a System One layer watching the composer while the System
 * Two agent (GLM) does the deliberate work.
 *
 * One speculative fan-out request per debounce tick asks every question the UI
 * might need at once; code applies thresholds and decides what (if anything)
 * to show. Jev returns calibrated probabilities, so the thresholds are real
 * policy, not prompt vibes. Fail-closed: any error → no assertion, agent unaffected.
 */

export interface SidecarAssertion {
  complete: number; // probability the draft expresses a finished, actionable idea
  multiIdea: number; // probability the draft contains more than one separate request
  kind: string; // directive | question | comment | fragment
  route: string; // queue | steer — meaningful while a run is in flight
  missingFiles: number; // probability the draft references files that don't exist
  line: string; // formatted single status line ("" when nothing worth showing)
}

const MIN_CHARS = 10;
const MIN_INTERVAL_MS = 2000;
const COMPLETE_THRESHOLD = 0.75;
const MULTI_THRESHOLD = 0.6;
const MISSING_THRESHOLD = 0.7;

export class Sidecar {
  private client: TypeSafeClient;
  private lastRun = 0;
  private lastDraft = "";
  private inflight = false;

  constructor(apiKey: string) {
    this.client = new TypeSafeClient({ apiKey });
  }

  /** Cheap gate evaluated in code before any network call. */
  shouldRun(draft: string, now: number): boolean {
    const trimmed = draft.trim();
    if (trimmed.length < MIN_CHARS) return false;
    if (draft === this.lastDraft) return false;
    if (this.inflight) return false;
    if (now - this.lastRun < MIN_INTERVAL_MS) return false;
    return true;
  }

  /** One speculative fan-out request: every question the UI might need, in parallel. */
  async assert(draft: string, running: boolean): Promise<SidecarAssertion | null> {
    this.lastRun = Date.now();
    this.lastDraft = draft;
    this.inflight = true;
    try {
      const { answers } = await this.client.systemOne({
        state: {
          draft,
          situation: running
            ? "The user is typing while the assistant is already working on an earlier request. The draft would be submitted mid-run."
            : "The user is composing a new request. The assistant is idle.",
        },
        questions: {
          finished: noul(
            "Does the draft express at least one complete, actionable idea — a request or question with enough substance to work on? Fragments, trailing conjunctions, or mid-thought text do not count.",
          ),
          multiIdea: noul(
            "Does the draft contain more than one separate request or idea that would be better split into multiple messages?",
          ),
          kind: choice("What best describes the draft?", {
            directive: null, // a task for the agent to do
            question: null, // a question the user wants answered
            comment: null, // context or opinion, not directly actionable
            fragment: null, // unfinished thought
          }),
          route: choice(
            "If the user submitted this right now while the assistant is mid-run, what should happen?",
            {
              queue: null, // wait until the current work finishes
              steer: null, // interrupt/deliver now — it changes what the agent should do
            },
          ),
          missingFiles: noul(
            "Does the draft reference files or paths by name that sound like they may not exist in the workspace?",
          ),
        },
      });

      const assertion: SidecarAssertion = {
        complete: answers.finished.noul,
        multiIdea: answers.multiIdea.noul,
        kind: answers.kind.choice,
        route: answers.route.choice,
        missingFiles: answers.missingFiles.noul,
        line: "",
      };

      // policy in code: thresholds + composition, never in a prompt
      const parts: string[] = [];
      if (assertion.complete >= COMPLETE_THRESHOLD) parts.push(`ready (${assertion.kind})`);
      else if (assertion.complete < 0.4) parts.push(`drafting… (${assertion.kind})`);
      if (assertion.multiIdea >= MULTI_THRESHOLD) parts.push("multi-idea — consider splitting");
      if (assertion.missingFiles >= MISSING_THRESHOLD) parts.push("references possibly-missing files");
      if (running && assertion.route === "steer" && assertion.complete >= COMPLETE_THRESHOLD) {
        parts.push("shift+enter to steer");
      }
      assertion.line = parts.length > 0 ? `◇ ${parts.join(" · ")}` : "";
      return assertion;
    } catch {
      return null; // fail closed: Jev down → no assertions, agent unaffected
    } finally {
      this.inflight = false;
    }
  }
}

/** Read the sidecar API key: JEV_TOKEN first, then TYPESAFE_API_KEY. */
export function sidecarApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env["JEV_TOKEN"] ?? env["TYPESAFE_API_KEY"] ?? undefined;
}
