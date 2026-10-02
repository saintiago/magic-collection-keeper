/** Manual completion gate used only by the local storybook. */

export interface StorybookStage {
  readonly id: number;
  readonly label: string;
}

interface Waiting<Value> extends StorybookStage {
  readonly complete: () => Value | PromiseLike<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (cause: unknown) => void;
  removeAbort: () => void;
}

interface WaitingStage extends StorybookStage {
  readonly completions: Waiting<unknown>[];
}

export class ManualProgression {
  readonly #waiting: WaitingStage[] = [];
  readonly #listeners = new Set<(stage: StorybookStage | null) => void>();
  #sequence = 0;
  #openStage: WaitingStage | null = null;
  #failNext = false;

  get current(): StorybookStage | null {
    return this.#waiting[0] ?? null;
  }

  get failNext(): boolean {
    return this.#failNext;
  }

  set failNext(value: boolean) {
    this.#failNext = value;
    this.#report();
  }

  wait<Value>(
    label: string,
    complete: () => Value | PromiseLike<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<Value>((resolve, reject) => {
      let stage = this.#openStage;
      if (stage === null) {
        this.#sequence += 1;
        stage = { id: this.#sequence, label, completions: [] };
        this.#waiting.push(stage);
        this.#openStage = stage;
        queueMicrotask(() => {
          if (this.#openStage === stage) this.#openStage = null;
        });
      }
      const waiting: Waiting<Value> = {
        id: stage.id,
        label,
        complete,
        resolve: (value) => resolve(value as Value | PromiseLike<Value>),
        reject,
        removeAbort: () => undefined,
      };
      const onAbort = (): void => this.#cancel(waiting as Waiting<unknown>, abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.removeAbort = () => signal?.removeEventListener('abort', onAbort);
      stage.completions.push(waiting as Waiting<unknown>);
      this.#report();
    });
  }

  advance(): boolean {
    const stage = this.#waiting.shift();
    if (stage === undefined) return false;
    if (this.#openStage === stage) this.#openStage = null;
    const fail = this.#failNext;
    this.#failNext = false;
    this.#report();
    if (fail) {
      for (const waiting of stage.completions) {
        waiting.removeAbort();
        waiting.reject(new Error(`Local mock failure while ${waiting.label.toLowerCase()}.`));
      }
      return true;
    }
    for (const waiting of stage.completions) {
      waiting.removeAbort();
      try {
        waiting.resolve(waiting.complete());
      } catch (cause) {
        waiting.reject(cause);
      }
    }
    return true;
  }

  cancelAll(): void {
    const cancelled = this.#waiting.splice(0);
    this.#openStage = null;
    this.#report();
    for (const stage of cancelled) {
      for (const waiting of stage.completions) {
        waiting.removeAbort();
        waiting.reject(abortError());
      }
    }
  }

  subscribe(listener: (stage: StorybookStage | null) => void): () => void {
    this.#listeners.add(listener);
    listener(this.current);
    return () => this.#listeners.delete(listener);
  }

  installKeyboard(target: Window): () => void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isEditing(event.target)) return;
      if (this.advance()) event.preventDefault();
    };
    target.addEventListener('keydown', onKeyDown);
    return () => target.removeEventListener('keydown', onKeyDown);
  }

  #report(): void {
    const stage = this.current;
    for (const listener of this.#listeners) listener(stage);
  }

  #cancel(waiting: Waiting<unknown>, cause: unknown): void {
    const stage = this.#waiting.find((candidate) => candidate.id === waiting.id);
    if (stage === undefined) return;
    const index = stage.completions.indexOf(waiting);
    if (index < 0) return;
    stage.completions.splice(index, 1);
    waiting.removeAbort();
    waiting.reject(cause);
    if (stage.completions.length === 0) {
      const stageIndex = this.#waiting.indexOf(stage);
      if (stageIndex >= 0) this.#waiting.splice(stageIndex, 1);
      if (this.#openStage === stage) this.#openStage = null;
    }
    this.#report();
  }
}

function isEditing(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLInputElement &&
      ['email', 'password', 'search', 'tel', 'text', 'url'].includes(target.type)) ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function abortError(): DOMException {
  return new DOMException('The local view closed.', 'AbortError');
}
