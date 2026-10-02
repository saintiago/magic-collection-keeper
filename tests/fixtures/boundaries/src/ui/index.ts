import { applicationBackend } from '../application/backend.js';
import { applicationCatalogJob } from '../application/catalog-job.js';
import { applicationDeployment } from '../application/deployment.js';
import { applicationWiring } from '../application/internal/wiring.js';
import { listWindow } from '../card-list/internal/window.js';
import { captureEntry } from '../capture/index.js';
import { deviceSession } from '../capture/internal/device.js';
import { catalogEntry } from '../catalog/index.js';
import { recordShape } from '../catalog/internal/index.js';
import { recognitionEntry } from '../recognition/index.js';
import { recognizeImage } from '../recognition/internal/engine.js';

export const uiEntry = {
  applicationBackend,
  applicationCatalogJob,
  applicationDeployment,
  applicationWiring,
  listWindow,
  captureEntry,
  deviceSession,
  catalogEntry,
  recordShape,
  recognitionEntry,
  recognizeImage,
};
