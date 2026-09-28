/**
 * Capture contract (docs/capture.md#interface, docs/capture.md#admission-and-lifecycle).
 *
 * One session owns a live camera: it acquires the device on demand, schedules frames, admits only
 * affirmative single-card evidence with a usable identity, coordinates staging through UserCards
 * and publishes identified feedback. A consumer describes the binding — one account and one
 * pending import — and receives a session that publishes immutable snapshots; construction binds
 * that identity, so changing it ends the old session instead of rewriting its state.
 *
 * The component is independent of a screen and of recognition engine internals: a device
 * capability supplies frames and a preview, Recognition supplies preparation and readings, and
 * UserCards owns the staged records. No capture operation confirms ownership, and an unknown
 * staging outcome recovers through the same UserCards operation instead of a second observation.
 */

import type {
  Recognition,
  RecognitionCardPresence,
  RecognitionEngineName,
  RecognitionStatus,
} from '../../recognition/index.js';
import type {
  AttachImportCandidatesInput,
  CaptureStageResult,
  ImportEntryChangeResult,
  ImportSession,
  StageCaptureInput,
} from '../../usercards/index.js';

/** Live preview of one granted camera; a view presents it on its own display surface. */
export interface CapturePreview {
  readonly stream: MediaStream;
}

/**
 * One open camera of the deployment's device. The session samples the frame the camera presents,
 * reads the frame it hands to Recognition and closes the camera when the session releases it; a
 * closed camera stops delivering frames and is safe to close again.
 */
export interface CaptureCamera<Frame> {
  /** Live video of the granted camera, presented by the capture view. */
  readonly preview: CapturePreview;
  /**
   * Bounded brightness signature of the frame presented now, or null before one is available. The
   * session uses it only as a stability gate, never as evidence of identity.
   */
  sample(): readonly number[] | null;
  /**
   * Frame presented now, bounded to the Recognition image limit, or null before one is available.
   * The frame is transient input: the session never retains it as state or diagnostics.
   */
  read(): Frame | null;
  /** Stops this camera and releases its resources; safe to call more than once. */
  close(): void;
}

/**
 * Device capability the session receives (docs/capture.md#internal-design). The deployment
 * supplies the browser's camera access; the component keeps frame acquisition private behind this
 * contract, so a session runs against supplied frames without a browser camera. A deployment
 * without a camera omits the acquisition operation, and the session reports that it cannot
 * capture instead of failing unexpectedly.
 */
export interface CaptureDevice<Frame> {
  /**
   * Requests the deployment's camera. A refused permission or an unavailable camera rejects with
   * the deployment's failure, which the session reports without retrying by itself.
   */
  openCamera?(): Promise<CaptureCamera<Frame>>;
  /** Releases device resources the session holds, such as an open camera. */
  release(): void | Promise<void>;
}

/** One candidate of a reading as Capture reports it. */
export interface CaptureCandidate {
  readonly cardId: string;
  readonly printingId: string;
  /** Canonical display name Catalog reported for this candidate. */
  readonly name: string;
  /**
   * Evidence the reading carried for this printing: whole-title corroboration or the engine's own
   * ranking. The review presents them beside the printing and never treats a ranking as evidence.
   */
  readonly evidence: 'title-evidence' | 'engine-ranking';
}

/**
 * One reading of a capture attempt as the session publishes it: the ordered candidates with their
 * evidence, the editable suggestion, the frame geometry the reading reported and its uncertainty.
 * A suggested printing is never evidence of the observed edition
 * (docs/recognition.md#interface).
 */
export interface CaptureReading {
  readonly captureId: string;
  readonly attempt: number;
  /** Delivery sequence of this attempt; the initial reading is 1. */
  readonly revision: number;
  /** `possible` names usable candidate identities; `unknown` names none. */
  readonly status: RecognitionStatus;
  readonly candidates: readonly CaptureCandidate[];
  /** Printing the editable review starts from, or null when the reading names none. */
  readonly suggestedPrintingId: string | null;
  /** Frame geometry the reading reported, or null when it reported none. */
  readonly presence: RecognitionCardPresence | null;
  /** True while a later comparison of the same attempt may still deliver a reading. */
  readonly provisional: boolean;
  /** True when the reading's candidates name competing playable identities. */
  readonly uncertain: boolean;
}

/** Lifecycle state of one capture session. */
export const captureStatuses = [
  'idle',
  'unavailable',
  'starting',
  'preparing',
  'running',
  'stopped',
  'failed',
] as const;

export type CaptureStatusKind = (typeof captureStatuses)[number];

/** Device and workflow status of one session; the failure text the device reported is preserved. */
export interface CaptureStatus {
  readonly kind: CaptureStatusKind;
  /** Failure the device reported while starting, or null outside a failed start. */
  readonly failure: string | null;
}

/** Cues one event may earn; a presentation renders them once per event identity. */
export const captureCues = ['accepted', 'repeat', 'error'] as const;
export type CaptureCue = (typeof captureCues)[number];

/** Kinds of identified feedback the session publishes. */
export const captureEventKinds = [
  'accepted',
  'repeat',
  'unresolved',
  'guidance',
  'unavailable',
  'comparison',
] as const;

export type CaptureEventKind = (typeof captureEventKinds)[number];

interface CaptureEventBase {
  /** Monotonic identity of this event; a presentation presents each identity once. */
  readonly sequence: number;
  /** Capture the event belongs to, or null for a session-level event. */
  readonly captureId: string | null;
  /** Attempt identity inside the capture, or null for a session-level event. */
  readonly attempt: number | null;
  /**
   * Cue this event earns: the success cue of an admitted candidate, the repeat cue of a suppressed
   * observation or the error cue of a failed attempt. Null means the event earns no cue, either
   * because the attempt already reported that kind or because the event has no cue of its own.
   */
  readonly cue: CaptureCue | null;
}

/**
 * One observation was admitted into pending review. `reading` is the reading that staged it, or
 * null when a replay of a retained attempt returned its recorded decision. Only this event earns
 * the success cue, and it means the candidate is in review — never that the card is owned.
 */
export interface CaptureAcceptedEvent extends CaptureEventBase {
  readonly kind: 'accepted';
  readonly captureId: string;
  readonly attempt: number;
  /** Pending entry the observation was admitted as. */
  readonly entryId: string;
  /** Whether the provider returned a recorded decision instead of deciding now. */
  readonly replayed: boolean;
  readonly reading: CaptureReading | null;
}

/** One observation was suppressed as a repeat of the accepted identity sequence. */
export interface CaptureRepeatEvent extends CaptureEventBase {
  readonly kind: 'repeat';
  readonly captureId: string;
  readonly attempt: number;
  readonly replayed: boolean;
  readonly reading: CaptureReading | null;
}

/** One attempt decided without a usable identity or without established single-card geometry. */
export interface CaptureUnresolvedEvent extends CaptureEventBase {
  readonly kind: 'unresolved';
  readonly captureId: string;
  readonly attempt: number;
  /** What was missing: a usable identity, or geometry that establishes exactly one card. */
  readonly reason: 'identity' | 'geometry';
}

/** Geometry that does not admit a capture; the owner is told what to do and no cue is earned. */
export interface CaptureGuidanceEvent extends CaptureEventBase {
  readonly kind: 'guidance';
  readonly captureId: string;
  readonly attempt: number;
  readonly presence: Exclude<RecognitionCardPresence, 'single'>;
}

/**
 * One attempt or submission could not complete. `preparation` and `recognition` report inference
 * that could not run, `frame` reports a camera that delivered no frame, and `staging` reports a
 * submission UserCards rejected or left without an established outcome. A recoverable outcome
 * stays with the attempt's own UserCards operation and is recovered through `retry`.
 */
export interface CaptureUnavailableEvent extends CaptureEventBase {
  readonly kind: 'unavailable';
  readonly reason: 'frame' | 'preparation' | 'recognition' | 'staging';
  /** Message the provider or runtime reported, or null when the component composes the outcome. */
  readonly failure: string | null;
  /** Whether the attempt's outcome still needs recovery through UserCards. */
  readonly recoverable: boolean;
}

/**
 * One later reading of an attempt that already has an entry. A comparison adds alternatives or
 * explains its own uncertainty; it never retracts the accepted capture. `rejected` and
 * `unverified` report an attachment that could not be stored or whose response was lost.
 */
export interface CaptureComparisonEvent extends CaptureEventBase {
  readonly kind: 'comparison';
  readonly captureId: string;
  readonly attempt: number;
  readonly reading: CaptureReading;
  readonly outcome: 'attached' | 'unverified' | 'rejected' | 'unusable';
  /** Message of a rejected attachment, or null. */
  readonly failure: string | null;
}

/** Identified feedback of one capture session, oldest first in the snapshot. */
export type CaptureEvent =
  | CaptureAcceptedEvent
  | CaptureRepeatEvent
  | CaptureUnresolvedEvent
  | CaptureGuidanceEvent
  | CaptureUnavailableEvent
  | CaptureComparisonEvent;

/** One event before the session stamps its identity on it. */
export type CaptureEventDraft =
  | Omit<CaptureAcceptedEvent, 'sequence'>
  | Omit<CaptureRepeatEvent, 'sequence'>
  | Omit<CaptureUnresolvedEvent, 'sequence'>
  | Omit<CaptureGuidanceEvent, 'sequence'>
  | Omit<CaptureUnavailableEvent, 'sequence'>
  | Omit<CaptureComparisonEvent, 'sequence'>;

/** One attempt the session is running; its latest reading is the provisional evidence. */
export interface CaptureAttempt {
  readonly captureId: string;
  readonly attempt: number;
  /** Latest reading delivered for the attempt, or null while none arrived. */
  readonly reading: CaptureReading | null;
}

/** Immutable state one session publishes; observing returns it and every following update. */
export interface CaptureSnapshot {
  readonly status: CaptureStatus;
  /** Live preview of the open camera, or null while none is attached. */
  readonly preview: CapturePreview | null;
  /**
   * Attempt the session is running or still receiving later readings, or null when none is
   * active. Its latest reading is the provisional evidence the presentation may show.
   */
  readonly attempt: CaptureAttempt | null;
  /** Events delivered so far, oldest first and bounded; each identity is presented once. */
  readonly events: readonly CaptureEvent[];
  /**
   * True while an attempt's outcome or its later alternatives are not established. The owner
   * resolves it through `retry` instead of starting another attempt.
   */
  readonly recoverable: boolean;
  /** True while an attempt or a staging request is in flight. */
  readonly busy: boolean;
  /** True while the hands-free loop samples the camera. */
  readonly running: boolean;
}

/** What one capture observation became in UserCards, as Capture reads the provider's answer. */
export type CaptureOperationOutcome<Record> =
  | { readonly state: 'committed'; readonly record: Record }
  | { readonly state: 'rejected'; readonly message: string | null }
  | { readonly state: 'unknown' };

/**
 * One staging operation the session coordinates. The provider-owned handle decides whether the
 * change committed, was rejected or stays unknown; the session never infers that classification
 * from a raw failure and never reports an unknown write as a success.
 */
export interface CaptureStagingOperation<Record> {
  /** Identity the operation runs under: the capture or the admitted entry. */
  readonly operationId: string;
  /** Resolves with the provider's established outcome, or an unknown outcome. */
  observe(): Promise<CaptureOperationOutcome<Record>>;
}

/** One retained attempt as its handle presents it: the operation and the observation it began with. */
export interface CaptureRetainedOperation<Record> extends CaptureStagingOperation<Record> {
  /** The observation this attempt keeps; replaying it resumes the same operation. */
  readonly input: StageCaptureInput;
}

/** One unfinished capture staging attempt UserCards retains for its account. */
export interface CaptureRetainedObservation {
  readonly captureId: string;
  /** The observation the attempt was begun with; replaying it resumes the same attempt. */
  readonly input: StageCaptureInput;
}

/**
 * UserCards staging the session coordinates (docs/user-cards.md#import-and-capture-state). A
 * binding translates the account's private operation handle into this protocol; the session never
 * composes a second observation to guess whether one committed.
 */
export interface CaptureStaging {
  /** Stages one observation under its capture identity; a repeat returns its recorded decision. */
  stage(
    input: StageCaptureInput,
    signal?: AbortSignal,
  ): CaptureStagingOperation<CaptureStageResult>;
  /** Attaches late recognition alternatives beside an admitted entry's reviewed values. */
  attach(
    input: AttachImportCandidatesInput,
    signal?: AbortSignal,
  ): CaptureStagingOperation<ImportEntryChangeResult>;
  /** Unfinished capture staging attempts of this account, oldest first. */
  retained(): readonly CaptureRetainedObservation[];
  /** Reattaches to one retained attempt under its capture identity, or null. */
  resume(captureId: string): CaptureRetainedOperation<CaptureStageResult> | null;
}

/**
 * One change of the pending review a session reports to the page that presents it
 * (docs/application.md#construction-and-request-boundary). An observation was admitted as an
 * entry, late alternatives were attached to one, or an outcome stays unknown and must be read
 * instead of being inferred.
 */
export type CaptureReviewChange =
  | {
      readonly kind: 'staged';
      readonly session: ImportSession;
      /** Entry the observation was admitted as, or null when it was suppressed or unresolved. */
      readonly entryId: string | null;
    }
  | { readonly kind: 'attached'; readonly session: ImportSession; readonly entryId: string }
  | { readonly kind: 'unknown' };

/** Clock the session samples and paces itself with; tests supply a controlled one. */
export interface CaptureTimers {
  /** Current time in milliseconds. */
  now(): number;
  /** Schedules one sampling step and returns the handle that cancels it. */
  schedule(task: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface CaptureOptions<Frame> {
  /**
   * Verified account the session stages for. No state of one account reaches another: the page
   * disposes the session when the presented account changes.
   */
  readonly accountId: string;
  /** Pending import every new observation of this session stages under. */
  readonly importId: string;
  /** Device capability of this deployment; one without a camera only reports that. */
  readonly device: CaptureDevice<Frame>;
  /** Builds the Recognition contract over the deployment's preserved engines. */
  readonly createRecognition: () => Recognition<Frame>;
  /** Engine names the deployment's pipeline prepares, from `recognitionEngineNames`. */
  readonly engines: readonly RecognitionEngineName[];
  /** Staging the session coordinates through UserCards. */
  readonly staging: CaptureStaging;
  /** Reports that the pending review changed, so the page presents what the provider now holds. */
  readonly reviewed?: (change: CaptureReviewChange) => void;
  /** Identity source of new capture attempts; tests control it. */
  readonly identity?: () => string;
  /** Clock of the sampling loop; defaults to the runtime's timer and `performance.now`. */
  readonly timers?: CaptureTimers;
}

/**
 * One live capture session. Prepare and start acquire the device and the Recognition session on
 * demand, stop releases the live device work while keeping the recoverable attempts, retry
 * recovers the attempts whose outcome is not established, and observe returns the current state
 * then every following update. Disposing suppresses later delivery and releases the session's
 * subscriptions and resources; a submitted write may still commit at UserCards and is recovered
 * through its own operation, not through a new session's state.
 */
export interface Capture {
  /** Pending import this session stages under, bound at construction. */
  readonly importId: string;
  /** Verified account this session is bound to. */
  readonly accountId: string;
  /** Prepares the device and the Recognition session on demand; reports failures as state. */
  prepare(): Promise<void>;
  /** Starts the hands-free loop: prepares when needed, then samples until stop or dispose. */
  start(): Promise<void>;
  /** Ends the live session, releasing the camera and the Recognition session. */
  stop(): void;
  /** Recovers the attempts whose staging outcome or later alternatives are not established. */
  retry(): Promise<void>;
  /** Returns the current state and delivers every following update; the result unsubscribes. */
  observe(listener: (snapshot: CaptureSnapshot) => void): () => void;
  /** Ends the session: no later delivery, no open camera and no subscription stays alive. */
  dispose(): void;
}

/** Device capability of the browser composition, over the frames a view can present. */
export type CaptureBrowserDevice = CaptureDevice<HTMLCanvasElement>;
