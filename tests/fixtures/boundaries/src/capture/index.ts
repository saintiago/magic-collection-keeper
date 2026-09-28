import { recognitionEntry } from '../recognition/index.js';
import { usercardsEntry } from '../usercards/index.js';

import { deviceSession } from './internal/device.js';

export const captureEntry = { recognitionEntry, usercardsEntry, deviceSession };
