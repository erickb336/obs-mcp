// A child process for the lock race test of test/journal.test.mjs: it waits for the go time, then, for each round n,
// tries to claim one start and to create owner file n + 1 of one take, and prints the rounds and numbers that it won.
// The claim of round n is busy when the last claim is of round n or later: then another process started already.
//   node test/journal-race.mjs <folder> <go-time-ms> <count>
import { Journal } from '../dist/journal.js';

const [dir, go, count] = process.argv.slice(2);
const j = new Journal(dir, 'race');
while (Date.now() < Number(go));
const claims = [];
const owners = [];
const round = (id) => Number(/^r(\d+)-/.exec(id ?? '')?.[1] ?? -1);
for (let n = 1; n <= Number(count); n++) {
  if (j.claim(`r${n}-${process.pid}`, (prev) => round(prev) >= n)) claims.push(n);
  if (j.own('race', n + 1)) owners.push(n + 1);
}
console.log(JSON.stringify({ claims, owners }));
