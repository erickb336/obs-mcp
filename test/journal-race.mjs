// A child process for the lock race test of test/journal.test.mjs: it waits for the go time, then tries each start
// claim and each owner file of one take, and prints the numbers that it won.
//   node test/journal-race.mjs <folder> <go-time-ms> <count>
import { Journal } from '../dist/journal.js';

const [dir, go, count] = process.argv.slice(2);
const j = new Journal(dir, 'race');
while (Date.now() < Number(go));
const claims = [];
const owners = [];
for (let n = 1; n <= Number(count); n++) {
  if (j.claim(n)) claims.push(n);
  if (j.own('race', n + 1)) owners.push(n + 1);
}
console.log(JSON.stringify({ claims, owners }));
