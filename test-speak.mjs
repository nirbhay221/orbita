/**
 * Saying it out loud, and the two ways that could cost money.
 *
 * Polly bills per character, and an endpoint that turns text into audio is a
 * general-purpose text-to-speech service billed to whoever is hosting it unless
 * it is fenced. Two fences are tested here: the input has to look like a sentence
 * this server would itself have said, and the same sentence twice must cost one
 * synthesis rather than two.
 *
 * SSML is the case worth being explicit about. Polly accepts markup that changes
 * the voice, inserts silence, or spells text out character by character at a
 * different price. Passing caller text through as SSML would hand all of that to
 * anyone who can reach the endpoint, so angle brackets are refused outright
 * rather than escaped.
 *
 * Nothing here reaches Polly; synthesis is seeded.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const speak = await import('./dist/speak.js');

const A_SENTENCE =
  'Hold off planting. Kp 6.3 puts expected drift near 0.7 metres, about 34 times your normal 0.8 inches.';

console.log('\nOnly things this server would have said are speakable');
{
  check('a real answer is speakable', speak.usable(A_SENTENCE) === true);
  check('a degree sign survives, because the phrasing uses it', speak.usable('58 degrees geomagnetic, 66.5 at Kp 0') === true);
  check('empty text is not', speak.usable('') === false);

  // The expensive one: SSML would let a caller change voice, insert silence, or
  // spell text out at a different rate and price.
  check('SSML is refused, not escaped', speak.usable('<speak>hello</speak>') === false);
  check('a lone angle bracket is refused', speak.usable('drift < 2 inches') === false);
  check('a closing bracket is refused', speak.usable('drift > 2 inches') === false);

  check('anything past the character ceiling is refused', speak.usable('a'.repeat(2001)) === false);
  check('and just inside it is allowed', speak.usable('a'.repeat(1999)) === true);
  check('control characters are refused', speak.usable('hello\u0007world') === false);
  check('non-ASCII beyond the allowed set is refused', speak.usable('planting is 良い') === false);
}

console.log('\nThe same sentence twice is one synthesis, not two');
{
  let calls = 0;
  speak.resetForTest();
  speak.configureForTest(async () => { calls += 1; return new Uint8Array([1, 2, 3]); });

  const first = await speak.speak(A_SENTENCE);
  check('the first call synthesises', calls === 1 && first.cached === false);

  const second = await speak.speak(A_SENTENCE);
  check('the second is served from cache', second.cached === true, JSON.stringify(second.cached));
  check('and no second synthesis happened', calls === 1, String(calls));
  check('the audio is identical', Buffer.compare(Buffer.from(first.audio), Buffer.from(second.audio)) === 0);

  // Whitespace differences must not defeat the cache, or a demo page that
  // re-wraps a line pays twice for the same sentence.
  const spaced = await speak.speak(`  ${A_SENTENCE.replace('. ', '.   ')}  `);
  check('collapsed whitespace hits the same cache entry', spaced.cached === true && calls === 1, String(calls));

  const other = await speak.speak('Clear for planting.');
  check('a different sentence does synthesise', other.cached === false && calls === 2, String(calls));
}

console.log('\nUnspeakable input throws rather than silently costing a call');
{
  let calls = 0;
  speak.resetForTest();
  speak.configureForTest(async () => { calls += 1; return new Uint8Array([1]); });
  for (const bad of ['<speak>x</speak>', '', 'a'.repeat(3000)]) {
    let threw = false;
    try { await speak.speak(bad); } catch { threw = true; }
    check(`refused: ${JSON.stringify(bad.slice(0, 20))}`, threw === true);
  }
  check('and nothing was synthesised', calls === 0, String(calls));
}

console.log('\nThe cache is bounded, so a long-lived process cannot grow on audio');
{
  speak.resetForTest();
  speak.configureForTest(async () => new Uint8Array([1]));
  for (let i = 0; i < 80; i += 1) await speak.speak(`Sentence number ${i}.`);
  check('it stops growing at the ceiling', speak.status().cached <= 64, String(speak.status().cached));
}

console.log('\nStatus reports what it would use, for /health');
{
  const s = speak.status();
  check('a voice is named', typeof s.voice === 'string' && s.voice.length > 0, s.voice);
  check('an engine is named', typeof s.engine === 'string' && s.engine.length > 0, s.engine);
  check('and whether it is switched on at all', typeof s.on === 'boolean');
}

speak.resetForTest();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
