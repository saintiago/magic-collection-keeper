import { importValue, type ResourceDefinition } from './template.js';

/** Replaces references to resources now owned by another independently deployed stack. */
export function withGatewayImports(definition: ResourceDefinition): ResourceDefinition {
  return mapValue(definition, (value) => {
    if (same(value, { Ref: 'HttpApi' })) return importValue('keeper-${Environment}-api-id');
    if (same(value, { Ref: 'JwtAuthorizer' })) {
      return importValue('keeper-${Environment}-authorizer-id');
    }
    const substitution = asRecord(value)?.['Fn::Sub'];
    if (typeof substitution === 'string' && substitution.includes('${HttpApi}')) {
      return {
        'Fn::Sub': [
          substitution.replaceAll('${HttpApi}', '${ApiId}'),
          {
            ApiId: importValue('keeper-${Environment}-api-id'),
          },
        ],
      };
    }
    return value;
  }) as ResourceDefinition;
}

export function replaceImportWithRef(
  definition: ResourceDefinition,
  exportName: string,
  logicalId: string,
): ResourceDefinition {
  return replaceImportValue(definition, exportName, { Ref: logicalId });
}

export function replaceImportValue(
  definition: ResourceDefinition,
  exportName: string,
  replacement: unknown,
): ResourceDefinition {
  return mapValue(definition, (value) =>
    same(value, importValue(exportName)) ? replacement : value,
  ) as ResourceDefinition;
}

function mapValue(value: unknown, transform: (value: unknown) => unknown): unknown {
  const transformed = transform(value);
  if (transformed !== value) return transformed;
  if (Array.isArray(value)) return value.map((entry) => mapValue(entry, transform));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, mapValue(entry, transform)]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
