import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CfnCondition, CfnOutput, CfnParameter, CfnResource, Fn, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';

type Json = Readonly<Record<string, unknown>>;

export interface ParameterDefinition extends Json {
  readonly Type: string;
}

export interface ResourceDefinition extends Json {
  readonly Type: string;
  readonly Properties?: Json;
  readonly DependsOn?: string | readonly string[];
  readonly Condition?: string;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

export interface OutputDefinition extends Json {
  readonly Value: unknown;
  readonly Description?: string;
  readonly Export?: { readonly Name: unknown };
}

export interface TemplateDefinition {
  readonly Description?: string;
  readonly Parameters?: Readonly<Record<string, ParameterDefinition>>;
  readonly Conditions?: Readonly<Record<string, unknown>>;
  readonly Resources: Readonly<Record<string, ResourceDefinition>>;
  readonly Outputs?: Readonly<Record<string, OutputDefinition>>;
}

const infraRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readLegacyTemplate(file: 'foundation.json' | 'service.json'): TemplateDefinition {
  return JSON.parse(readFileSync(path.join(infraRoot, file), 'utf8')) as TemplateDefinition;
}

/** Adds raw L1 definitions while retaining their existing CloudFormation logical identities. */
export class TemplateFragment extends Construct {
  readonly resources = new Map<string, CfnResource>();

  constructor(scope: Stack, id: string) {
    super(scope, id);
  }

  addParameters(
    definitions: Readonly<Record<string, ParameterDefinition>>,
    names: readonly string[],
  ): void {
    for (const name of names) {
      const definition = required(definitions[name], `parameter ${name}`);
      const parameter = new CfnParameter(this, `Parameter${name}`, parameterProps(definition));
      parameter.overrideLogicalId(name);
    }
  }

  addConditions(definitions: Readonly<Record<string, unknown>>, names: readonly string[]): void {
    for (const name of names) {
      const condition = new CfnCondition(this, `Condition${name}`, {
        expression: definitions[name] as never,
      });
      condition.overrideLogicalId(name);
    }
  }

  addResources(
    definitions: Readonly<Record<string, ResourceDefinition>>,
    names: readonly string[],
  ): void {
    for (const name of names)
      this.addResource(name, required(definitions[name], `resource ${name}`));
  }

  addResource(name: string, definition: ResourceDefinition): CfnResource {
    const resource = new CfnResource(this, `Resource${name}`, {
      type: definition.Type,
      properties: clone(definition.Properties ?? {}),
    });
    resource.overrideLogicalId(name);
    if (definition.DependsOn !== undefined) resource.addOverride('DependsOn', definition.DependsOn);
    if (definition.Condition !== undefined) resource.addOverride('Condition', definition.Condition);
    if (definition.DeletionPolicy !== undefined) {
      resource.addOverride('DeletionPolicy', definition.DeletionPolicy);
    }
    if (definition.UpdateReplacePolicy !== undefined) {
      resource.addOverride('UpdateReplacePolicy', definition.UpdateReplacePolicy);
    }
    this.resources.set(name, resource);
    return resource;
  }

  addOutputs(
    definitions: Readonly<Record<string, OutputDefinition>>,
    names: readonly string[],
  ): void {
    for (const name of names) this.addOutput(name, required(definitions[name], `output ${name}`));
  }

  addOutput(name: string, definition: OutputDefinition): CfnOutput {
    const output = new CfnOutput(this, `Output${name}`, {
      value: definition.Value as string,
      ...(definition.Description === undefined ? {} : { description: definition.Description }),
      ...(definition.Export === undefined
        ? {}
        : { exportName: outputExportName(definition.Export.Name) }),
    });
    output.overrideLogicalId(name);
    return output;
  }
}

function outputExportName(value: unknown): string {
  if (typeof value === 'string') return value;
  const substitution = (value as { readonly 'Fn::Sub'?: unknown } | null | undefined)?.['Fn::Sub'];
  if (typeof substitution === 'string') return Fn.sub(substitution);
  throw new Error('A template output export name must be a string or Fn::Sub string.');
}

export function environmentParameter(environment: string): ParameterDefinition {
  return { Type: 'String', Default: environment, AllowedValues: [environment] };
}

export function stringParameter(description: string, allowedPattern?: string): ParameterDefinition {
  return {
    Type: 'String',
    Description: description,
    ...(allowedPattern === undefined ? {} : { AllowedPattern: allowedPattern }),
  };
}

export function importValue(name: string): Json {
  return { 'Fn::ImportValue': { 'Fn::Sub': name } };
}

export function exportOutput(value: unknown, name: string, description?: string): OutputDefinition {
  return {
    Value: value,
    Export: { Name: { 'Fn::Sub': name } },
    ...(description === undefined ? {} : { Description: description }),
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

function parameterProps(
  definition: ParameterDefinition,
): ConstructorParameters<typeof CfnParameter>[2] {
  return {
    type: definition.Type,
    ...(definition.Default === undefined ? {} : { default: definition.Default }),
    ...(definition.AllowedValues === undefined
      ? {}
      : { allowedValues: definition.AllowedValues as string[] }),
    ...(definition.AllowedPattern === undefined
      ? {}
      : { allowedPattern: definition.AllowedPattern as string }),
    ...(definition.Description === undefined
      ? {}
      : { description: definition.Description as string }),
    ...(definition.ConstraintDescription === undefined
      ? {}
      : { constraintDescription: definition.ConstraintDescription as string }),
    ...(definition.MinLength === undefined ? {} : { minLength: definition.MinLength as number }),
    ...(definition.MaxLength === undefined ? {} : { maxLength: definition.MaxLength as number }),
    ...(definition.MinValue === undefined ? {} : { minValue: definition.MinValue as number }),
    ...(definition.MaxValue === undefined ? {} : { maxValue: definition.MaxValue as number }),
    ...(definition.NoEcho === undefined ? {} : { noEcho: definition.NoEcho as boolean }),
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`The legacy template has no ${label}.`);
  return value;
}
