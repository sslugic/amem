#!/usr/bin/env node
import { assertPublishReady } from "../dist/publish.js";

const info = assertPublishReady();
console.log(`npx-ready: ${info.name}@${info.version}`);
console.log(`bin: ${info.bin}`);
console.log(`engines: node ${info.engines}`);
console.log(`files: ${info.filesField.join(", ")}`);
