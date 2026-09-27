/**
 * Moxfield access of the source-import boundary (docs/user-cards.md#source-imports). The component
 * owns the public endpoint, its bounds and how a provider failure reads to a caller, so a card
 * list reaches the workspace without UserInterface or Application knowing Moxfield's format. The
 * source stays a replaceable port: a deployment may supply configured limits or an approved access
 * path instead.
 */

import { UserCardsError } from './errors.js';

/**
 * Bounds one deck read keeps: a request that never ends and a response larger than one import
 * buffers are refused instead of exhausting the process, matching the pinned reference
 * implementation's provider bounds.
 */
const moxfieldRequestTimeoutMs = 10_000;
const moxfieldResponseBytes = 2 * 1024 * 1024;
const moxfieldUserAgent =
  'MagicCollectionKeeper/0.1 (+https://github.com/saintiago/magic-collection-keeper)';

/** Public Moxfield deck source: reads the deck document one public deck identity names. */
export interface MoxfieldDeckSource {
  readDeck(sourceId: string): Promise<unknown>;
}

export interface MoxfieldSourceOptions {
  /** Fetch implementation used for the deck request; defaults to the platform `fetch`. */
  readonly fetcher?: typeof fetch;
  /** User agent the public API receives; identifies the application that reads the deck. */
  readonly userAgent?: string;
}

/**
 * The public Moxfield API as a deck source. It is credential-free and reads one deck per call; a
 * refusal, a missing deck, a rate limit and an unreadable response stay distinct failures.
 */
export function createMoxfieldDeckSource(options: MoxfieldSourceOptions = {}): MoxfieldDeckSource {
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new TypeError('A Moxfield deck source needs a fetch implementation.');
  }
  const userAgent = options.userAgent ?? moxfieldUserAgent;
  return {
    async readDeck(sourceId: string): Promise<unknown> {
      const response = await readDeckResponse(fetcher, userAgent, sourceId);
      const text = await readBoundedText(response);
      try {
        return JSON.parse(text);
      } catch (cause) {
        throw new UserCardsError('unavailable', 'Moxfield returned an unreadable deck.', {
          cause,
        });
      }
    },
  };
}

/** One deck request: a refusal, an unknown deck, a rate limit and a transport failure stay apart. */
async function readDeckResponse(
  fetcher: typeof fetch,
  userAgent: string,
  sourceId: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(
      `https://api2.moxfield.com/v3/decks/all/${encodeURIComponent(sourceId)}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        redirect: 'error',
        signal: AbortSignal.timeout(moxfieldRequestTimeoutMs),
      },
    );
  } catch (cause) {
    throw new UserCardsError(
      'unavailable',
      'Moxfield could not be reached within the time limit; no import changed.',
      { cause },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new UserCardsError(
      'invalid-request',
      'Moxfield denied this request; only public decks can be imported.',
    );
  }
  if (response.status === 404) {
    throw new UserCardsError('not-found', 'Moxfield has no accessible deck at that link.');
  }
  if (response.status === 429) {
    throw new UserCardsError(
      'unavailable',
      'Moxfield is limiting requests; retry later; no import changed.',
    );
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new UserCardsError(
      'unavailable',
      'Moxfield returned an unavailable or unreadable response.',
    );
  }
  return response;
}

/** Reads one bounded response body; a larger document is refused before it is buffered whole. */
async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > moxfieldResponseBytes) {
        throw new UserCardsError(
          'invalid-request',
          'The Moxfield deck is larger than one import reads.',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}
