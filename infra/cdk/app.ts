#!/usr/bin/env node

import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';

import { readDeploymentConfiguration, stackName } from './configuration.js';
import { CatalogIngestionStack } from './stacks/catalog-ingestion.js';
import { CatalogServingStack } from './stacks/catalog-serving.js';
import { FoundationStack } from './stacks/foundation.js';
import { GatewayStack } from './stacks/gateway.js';
import { LegacyFoundationStack, LegacyServiceStack } from './stacks/legacy.js';
import { RecognitionStack } from './stacks/recognition.js';
import { UserCardsStack } from './stacks/usercards.js';
import { WebStack } from './stacks/web.js';

const app = new App({ analyticsReporting: false, treeMetadata: false, stackTraces: false });
const configuration = readDeploymentConfiguration(app);
const common = { synthesizer: new BootstraplessSynthesizer() };

if (configuration.layout === 'legacy') {
  new LegacyFoundationStack(app, 'FoundationStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'foundation'),
  });
  new LegacyServiceStack(app, 'ServiceStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'service'),
  });
} else {
  new FoundationStack(app, 'FoundationStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'foundation'),
  });
  new GatewayStack(app, 'GatewayStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'gateway'),
  });
  new WebStack(app, 'WebStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'web'),
  });
  new CatalogServingStack(app, 'CatalogServingStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'catalog-serving'),
  });
  new UserCardsStack(app, 'UserCardsStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'usercards'),
  });
  new RecognitionStack(app, 'RecognitionStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'recognition'),
  });
  new CatalogIngestionStack(app, 'CatalogIngestionStack', configuration, {
    ...common,
    stackName: stackName(configuration.environment, 'catalog-ingestion'),
  });
}

app.synth();
