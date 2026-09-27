/**
 * Recognition failures that consumers and Application map to transport outcomes
 * (docs/recognition.md#interface). A reading with no usable identity is a successful `unknown`
 * result, never one of these failures: invalid input, a busy session, cancellation and unavailable
 * inference stay distinct.
 */
export type RecognitionFailureCode = 'invalid-request' | 'busy' | 'cancelled' | 'unavailable';

export class RecognitionError extends Error {
  readonly code: RecognitionFailureCode;

  constructor(code: RecognitionFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecognitionError';
    this.code = code;
  }
}
