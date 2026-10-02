/** Manual completion gate used only by the local storybook. */

export interface StorybookStage {
  readonly id: number;
  readonly label: string;
}

interface Waiting<Value> extends StorybookStage {
  readonly complete: () => Value | PromiseLike<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (cause: unknown) => void;
}

export class ManualProgression {
  readonly #waiting: Waiting<unknown>[] = [];
  readonly #listeners = new Set<(stage: StorybookStage | null) => void>();
  #sequence = 0;
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

  wait<Value>(label: string, complete: () => Value | PromiseLike<Value>): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      this.#sequence += 1;
      this.#waiting.push({
        id: this.#sequence,
        label,
        complete,
        resolve: (value) => resolve(value as Value | PromiseLike<Value>),
        reject,
      });
      this.#report();
    });
  }

  advance(): boolean {
    const waiting = this.#waiting.shift();
    if (waiting === undefined) return false;
    const fail = this.#failNext;
    this.#failNext = false;
    this.#report();
    if (fail) {
      waiting.reject(new Error(`Local mock failure while ${waiting.label.toLowerCase()}.`));
      return true;
    }
    try {
      waiting.resolve(waiting.complete());
    } catch (cause) {
      waiting.reject(cause);
    }
    return true;
  }

  cancelAll(): void {
    const cancelled = this.#waiting.splice(0);
    this.#report();
    for (const waiting of cancelled) {
      waiting.reject(new DOMException('The local view closed.', 'AbortError'));
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
}

function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
