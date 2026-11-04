// A child process for the lock race tests: it takes the controller lock of one endpoint when its input says "go",
// prints whether it controls, and holds the lock until its input ends. SIMULATED: no OBS.
import { Control } from '../dist/control.js';

const control = new Control(() => process.argv[2]);
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (d) => {
  if (d.includes('go')) process.stdout.write(`${(await control.acquire()) ? 'controls' : 'reads'}\n`);
});
process.stdin.on('end', () => process.exit(0));
process.stdout.write('ready\n');
