import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import { readLegacyTemplate, TemplateFragment } from '../constructs/template.js';

/** Transitional adoption stack: same resources, parameters, outputs and logical IDs as foundation.json. */
export class LegacyFoundationStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    _configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    const source = readLegacyTemplate('foundation.json');
    this.templateOptions.description = source.Description;
    this.templateOptions.templateFormatVersion = source.AWSTemplateFormatVersion;
    const fragment = new TemplateFragment(this, 'Foundation');
    fragment.addParameters(source.Parameters ?? {}, Object.keys(source.Parameters ?? {}));
    fragment.addRules(source.Rules ?? {}, Object.keys(source.Rules ?? {}));
    fragment.addResources(source.Resources, Object.keys(source.Resources));
    fragment.addOutputs(source.Outputs ?? {}, Object.keys(source.Outputs ?? {}));
  }
}

/** Transitional adoption stack: same resources, parameters, outputs and logical IDs as service.json. */
export class LegacyServiceStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    _configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    const source = readLegacyTemplate('service.json');
    this.templateOptions.description = source.Description;
    this.templateOptions.templateFormatVersion = source.AWSTemplateFormatVersion;
    const fragment = new TemplateFragment(this, 'Service');
    fragment.addParameters(source.Parameters ?? {}, Object.keys(source.Parameters ?? {}));
    fragment.addRules(source.Rules ?? {}, Object.keys(source.Rules ?? {}));
    fragment.addConditions(source.Conditions ?? {}, Object.keys(source.Conditions ?? {}));
    fragment.addResources(source.Resources, Object.keys(source.Resources));
    fragment.addOutputs(source.Outputs ?? {}, Object.keys(source.Outputs ?? {}));
  }
}
