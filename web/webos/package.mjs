import { copyFile, cp, readFile, writeFile } from 'node:fs/promises';
await copyFile(new URL('./appinfo.json', import.meta.url), new URL('../dist/appinfo.json', import.meta.url));
await copyFile(new URL('./icon.png', import.meta.url), new URL('../dist/icon.png', import.meta.url));

await cp(new URL('./vendor/', import.meta.url), new URL('../dist/webostv/', import.meta.url), { recursive: true });
const index = new URL('../dist/index.html', import.meta.url);
const html = await readFile(index, 'utf8');
if (!html.includes('./webostv/webOSTV.js')) await writeFile(index, html.replace('</head>', '<script src="./webostv/webOSTV.js"></script></head>'));
