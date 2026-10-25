import { copyFile } from 'node:fs/promises';
await copyFile(new URL('./appinfo.json', import.meta.url), new URL('../dist/appinfo.json', import.meta.url));
await copyFile(new URL('./icon.png', import.meta.url), new URL('../dist/icon.png', import.meta.url));
