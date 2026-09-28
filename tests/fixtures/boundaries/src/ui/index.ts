import { applicationBackend } from '../application/backend.js';
import { applicationDeployment } from '../application/deployment.js';
import { applicationWiring } from '../application/internal/wiring.js';
import { catalogEntry } from '../catalog/index.js';
import { recordShape } from '../catalog/internal/index.js';
import { recognitionEntry } from '../recognition/index.js';
import { recognizeImage } from '../recognition/internal/engine.js';

export const uiEntry = {
  applicationBackend,
  applicationDeployment,
  applicationWiring,
  catalogEntry,
  recordShape,
  recognitionEntry,
  recognizeImage,
};
