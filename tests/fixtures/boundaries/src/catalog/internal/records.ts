export interface RecordShape {
  readonly id: string;
}

export function recordShape(id: string): RecordShape {
  return { id };
}
