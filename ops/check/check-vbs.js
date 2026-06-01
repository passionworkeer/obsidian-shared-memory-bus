import path from 'node:path';

const m = await import('./bus/platform/index.js');
const pidPath = path.join(process.env.AI_MEMORY_STORE || process.cwd(), 'watchdog.pid');
const s = m.platform.makeWatchdogScript(pidPath, 'echo recovered');
const match = s.match(/pidPath = '([^']+)'/);
console.log('pidPath VBS string:', match ? match[1] : 'NOT FOUND');
