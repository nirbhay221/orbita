/**
 * The Echo-style demo page.
 *
 * A screen and the lines somebody might say to it. Every line is a real tool call to this server. No assistant
 * model runs here, so the lines are fixed and listed in echo-scenes.json; what comes back is whatever the
 * server says today, for the farm built on this page.
 *
 * A line can take something typed, marked with `input` in echo-scenes.json. None does on the page today.
 */

const SESSION_KEY = 'orbita.demo.session';
const SESSION_FORMAT = /^[0-9a-f]{32}$/;
const el = (id) => document.getElementById(id);

function newSession() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
let session = null;
try { session = localStorage.getItem(SESSION_KEY); } catch { /* private mode */ }
if (!session || !SESSION_FORMAT.test(session)) {
  session = newSession();
  try { localStorage.setItem(SESSION_KEY, session); } catch { /* nothing to do */ }
}

let rpcId = 0;
async function callTool(name, args) {
  const started = performance.now();
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orbita-demo': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  let json;
  try { json = JSON.parse(line ? line.slice(6) : raw); } catch { throw new Error(`The server answered with something unreadable (HTTP ${res.status}).`); }
  if (json.error) throw new Error(json.error.message || 'The call failed.');
  return { ms: Math.round(performance.now() - started), text: json.result?.content?.[0]?.text ?? '', data: json.result?.structuredContent ?? {} };
}

function speak(text) {
  if (!el('voice').checked || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function showCard(card, enterAt) {
  const box = el('card');
  box.replaceChildren();
  // A page to type an email address on, when the answer handed one back. Opens in a new tab.
  if (enterAt && /^https?:\/\//.test(enterAt)) {
    const a = document.createElement('a');
    a.href = enterAt;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Type the email address here';
    box.append(a);
    box.hidden = false;
    if (!card || card.kind !== 'card') return;
  }
  if (!card || card.kind !== 'card') { if (!enterAt) box.hidden = true; return; }
  const title = document.createElement('h3');
  title.textContent = card.title ?? '';
  box.append(title);
  if (card.status?.label) {
    const s = document.createElement('span');
    s.className = `status ${card.status.tone === 'bad' ? 'bad' : card.status.tone === 'good' ? 'good' : ''}`;
    s.textContent = card.status.label;
    box.append(s);
  }
  const list = document.createElement('ul');
  for (const line of [...(card.lines ?? []), card.confirm, card.foot].filter(Boolean)) {
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  }
  if (list.children.length) box.append(list);
  box.hidden = false;
}

// The idle screen shows the time and a greeting, as an Echo Show does.
function tick() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  for (const id of ['clock', 'sclock', 'ptime']) if (el(id)) el(id).textContent = time;
  const h = now.getHours();
  if (el('greet')) el('greet').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
tick();
setInterval(tick, 20000);

// Light or dark: the system's choice until the button is pressed, then the visitor's, remembered here.
el('theme')?.addEventListener('click', () => {
  const root = document.documentElement;
  const now = root.dataset.theme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  root.dataset.theme = now === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('echo.theme', root.dataset.theme); } catch { /* private mode */ }
});

// Once anything is said, the screen swaps the clock for the conversation.
function goLive() {
  const screen = el('screen');
  screen?.classList.add('live');
  // On a narrow screen the lines sit below the device, so bring the answer back into view.
  if (screen && window.matchMedia('(max-width: 60rem)').matches) screen.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Behind the answer: every tool call, newest first, with how long it took.
function trace(what, detail) {
  const list = el('trace');
  if (!list) return;
  const li = document.createElement('li');
  const a = document.createElement('span');
  a.textContent = what;
  const b = document.createElement('span');
  b.textContent = detail;
  li.append(a, b);
  list.prepend(li);
  while (list.children.length > 6) list.lastChild.remove();
  el('trace-empty').hidden = true;
}

// When the question is about. Starts at now; the picked moment is sent as words, read in the field's own time.
let when = null;
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function spoken(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const clock = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
  return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} at ${clock}`;
}
// A past moment is a look back at what happened; a later one is a check of the forecast for it.
function forWhen(tool, args) {
  if (!when) return [tool, args];
  const past = when.getTime() < Date.now() - 15 * 60_000;
  if (tool === 'can_i_run' || tool === 'storm_status') {
    return past ? ['what_happened', { when: spoken(when), operation: args.operation ?? 'planting' }] : [tool, { ...args, when: spoken(when) }];
  }
  if (tool === 'what_happened') return [tool, { ...args, when: spoken(when) }];
  return [tool, args];
}
// A day named in the words wins over the date button. "What happened on May 10, 2024?" with a date picked used to
// go out as "... I mean October 20 2026 at 9 am.", two dates in one question. A calendar date in a scripted line,
// or any day word in a typed one, is sent as it was said, and the button only fills in when the words name no day.
const CALENDAR = /\b((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}|\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(19|20)\d\d|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i;
const DAY_WORD = /\b(today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|weekend)|next (week|month|\w+day)|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
const namesADay = (words) => CALENDAR.test(words) || DAY_WORD.test(words);
const whenNote = (words) => (when && !namesADay(words) ? ` (${spoken(when)})` : '');
const whenWords = (words) => (when && !namesADay(words) ? `${words} I mean ${spoken(when)}.` : words);

/*
 * Another time. It was one browser date-and-time box, "mm/dd/yyyy --:-- --", and people did not know what to put
 * in it. Now: four one-tap choices, a date and a time apart, and a line that says in words what is being asked
 * about. Times are the field's own; the page sends them as words ("October 21 2026 at 9 pm"), read there.
 */
function setUpWhen() {
  const now = el('when-now');
  const pick = el('when-pick');
  const panel = el('when-panel');
  const dateBox = el('when-date');
  const timeBox = el('when-time');
  const readout = el('when-readout');
  if (!now || !pick || !panel || !dateBox || !timeBox) return;
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  dateBox.min = '1932-01-01';
  dateBox.max = ymd(new Date(Date.now() + 3 * 86_400_000));
  const tell = () => {
    if (!when) { readout.textContent = 'Pick a choice above, or set a date and a time.'; return; }
    const ahead = when.getTime() - Date.now();
    const words = when.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: when.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: 'numeric' });
    readout.textContent = ahead > 3 * 86_400_000
      ? `${words} is past the forecast, which reaches three days ahead. Pick a nearer time.`
      : `Asking about ${words}, the field's own time. ${ahead < -15 * 60_000 ? 'A past time plays back what happened.' : 'A later time checks the forecast.'}`;
  };
  const set = (d) => {
    when = d;
    dateBox.value = ymd(d);
    timeBox.value = `${pad(d.getHours())}:00`;
    tell();
  };
  const fromBoxes = () => {
    if (!dateBox.value) { when = null; tell(); return; }
    const [y, m, d] = dateBox.value.split('-').map(Number);
    const [hh] = (timeBox.value || '12:00').split(':').map(Number);
    when = new Date(y, m - 1, d, hh, 0, 0);
    tell();
  };
  const at = (daysAhead, hour) => { const d = new Date(); d.setDate(d.getDate() + daysAhead); d.setHours(hour, 0, 0, 0); return d; };
  const PRESETS = {
    tonight: () => at(0, 21),
    'tomorrow-am': () => at(1, 9),
    'tomorrow-pm': () => at(1, 19),
    may2024: () => new Date(2024, 4, 10, 19, 0, 0),
  };
  for (const b of panel.querySelectorAll('.preset')) {
    b.addEventListener('click', () => {
      for (const o of panel.querySelectorAll('.preset')) o.setAttribute('aria-pressed', String(o === b));
      set(PRESETS[b.dataset.preset]());
    });
  }
  dateBox.addEventListener('change', fromBoxes);
  timeBox.addEventListener('change', fromBoxes);
  const show = (on) => {
    now.setAttribute('aria-pressed', String(!on));
    pick.setAttribute('aria-pressed', String(on));
    panel.hidden = !on;
    for (const o of panel.querySelectorAll('.preset')) o.setAttribute('aria-pressed', 'false');
    if (!on) { when = null; return; }
    set(at(0, Math.min(23, new Date().getHours() + 1)));
  };
  now.addEventListener('click', () => show(false));
  pick.addEventListener('click', () => show(true));
}
setUpWhen();

async function say(line, typed, focusBack) {
  const controls = [...document.querySelectorAll('.chip, .typed')];
  controls.forEach((b) => (b.disabled = true));
  goLive();
  el('heard').classList.remove('idle');
  const said = typed ? `${line.say} ${typed}` : line.say;
  el('heard').textContent = when && !CALENDAR.test(said) ? `${said.replace(/\btoday\b|\bright now\b/i, 'then')} (${spoken(when)})` : said;
  el('answer').textContent = '…';
  try {
    const args = { ...(line.args ?? {}) };
    if (line.input) args[line.input] = typed;
    const [tool, sent] = CALENDAR.test(said) ? [line.tool, args] : forWhen(line.tool, args);
    const r = await callTool(tool, sent);
    el('answer').textContent = r.text;
    el('meta').textContent = `${tool} answered in ${r.ms} ms${r.data.decidedBy ? `, decided by the ${r.data.decidedBy}` : ''}`;
    trace(tool, `${r.ms} ms`);
    showCard(r.data.card, r.data.enterAt);
    speak(r.text);
  } catch (err) {
    el('answer').textContent = err.message;
    el('meta').textContent = '';
    showCard(null);
  } finally {
    controls.forEach((b) => (b.disabled = false));
    focusBack?.focus();
    void readPhone();
  }
}

/* ---------------------------------------------------------------- the crew member's inbox */

const acted = new Map();

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  return res.ok;
}

function action(label, cls, run, key, done) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `act ${cls}`;
  b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    const ok = await run();
    acted.set(key, ok ? done : 'That link no longer works.');
    void readPhone();
  });
  return b;
}

function renderPhone(messages) {
  const inbox = el('inbox');
  inbox.replaceChildren();
  el('empty').hidden = messages.length > 0;
  for (const m of [...messages].reverse()) {
    const key = `${m.at}|${m.reason}`;
    const li = document.createElement('li');
    const h = document.createElement('h3');
    h.textContent = m.to ? `To ${m.to}: ${m.subject}` : m.subject;
    const p = document.createElement('p');
    p.textContent = m.text;
    li.append(h, p);
    if (acted.has(key)) {
      const d = document.createElement('p');
      d.className = 'done';
      d.textContent = acted.get(key);
      li.append(d);
    } else if (m.accept) {
      li.append(
        action('Yes, send them to me', '', () => post('/contact/accept', { t: m.accept, answer: 'yes' }), key, 'Agreed. Alerts will now reach this inbox.'),
        action('No', 'second', () => post('/contact/accept', { t: m.accept, answer: 'no' }), key, 'Declined. Nothing more will be sent.'),
      );
    }
    inbox.append(li);
  }
}

async function readPhone() {
  try {
    const res = await fetch('/demo/phone', { headers: { 'x-orbita-demo': session } });
    if (!res.ok) return;
    renderPhone((await res.json()).messages ?? []);
  } catch { /* the inbox simply stays as it was */ }
}

async function start() {
  void readPhone();
  el('heard').classList.add('idle');
  const scenes = await (await fetch('/echo-scenes.json')).json();
  const host = el('lines');
  let n = 0;
  for (const group of scenes.groups) {
    const box = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = group.name;
    box.append(title);
    for (const line of group.lines) {
      if (line.input) {
        // A line with something to type: the words, a box for the rest, and a button that says it.
        const form = document.createElement('form');
        form.className = 'chip-form';
        const id = `typed-${(n += 1)}`;
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = line.say;
        const box2 = document.createElement('input');
        box2.id = id;
        box2.className = 'typed';
        box2.inputMode = 'numeric';
        box2.autocomplete = 'off';
        box2.placeholder = line.hint ?? '';
        const go = document.createElement('button');
        go.type = 'submit';
        go.className = 'chip go';
        go.textContent = 'Say it';
        form.append(label, box2, go);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (box2.value.trim()) void say(line, box2.value.trim(), go);
        });
        box.append(form);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      // A real person's words: in quotes, with who said them. Where is in the button's title.
      b.textContent = line.source ? `“${line.say}”` : line.say;
      if (line.who) {
        const who = document.createElement('small');
        who.className = 'who';
        who.textContent = line.who;
        b.append(who);
        b.title = `Said by ${line.who}. Source: ${line.source}`;
      }
      b.addEventListener('click', () => void say(line, '', b));
      box.append(b);
    }
    host.append(box);
  }
  el('reset').addEventListener('click', () => {
    try { localStorage.setItem(SESSION_KEY, newSession()); } catch { /* nothing to do */ }
    location.reload();
  });
}

void start();

/* ---------------------------------------------------------------- say anything */

/*
 * Say anything, by typing or with the microphone.
 *
 * The sentence goes to /agent, where a model reads this server's own tool list and picks a tool, the way
 * Alexa+ would; with no model available the server's word rules pick instead. Either way the page shows
 * which tool was chosen and by what, so it is clear what was decided and what was answered. Speech in and
 * out is the browser's own (Chrome and Edge hear; most browsers speak), so nothing about the voice leaves
 * the visitor's machine except the words.
 */
// The conversation so far and the next step the last answer named, sent with each sentence.
const echoTurns = [];
let echoNext = null;
async function sayAnything(words, button) {
  if (!String(words ?? '').trim()) return;
  const buttons = [...document.querySelectorAll('.chip, #free button')];
  buttons.forEach((b) => (b.disabled = true));
  goLive();
  el('heard').classList.remove('idle');
  el('heard').textContent = words + whenNote(words);
  el('answer').textContent = '…';
  const sent = whenWords(words);
  try {
    const res = await fetch('/agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orbita-demo': session }, body: JSON.stringify({ say: sent, history: echoTurns, next: echoNext }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `The server said no (HTTP ${res.status}).`);
    const text = body.reply || body.result?.content?.[0]?.text || body.said || '';
    // Kept for the next sentence, as Alexa+ keeps the conversation. See conversation() in standin.ts.
    echoTurns.push({ role: 'user', text: words }, { role: 'assistant', text });
    echoTurns.splice(0, Math.max(0, echoTurns.length - 6));
    echoNext = body.result?.structuredContent?.nextAction ?? null;
    el('answer').textContent = text;
    const by = body.model === 'word rules' ? 'word rules (no model running)' : body.model;
    el('meta').textContent = body.chose ? `${by} chose ${(body.steps ?? [body.chose]).map((s) => s.tool).join(' then ')}` : `${by} chose no tool`;
    for (const step of [...(body.steps ?? (body.chose ? [body.chose] : []))].reverse()) trace(step.tool, `chosen by ${body.model === 'word rules' ? 'word rules' : 'the model'}`);
    showCard(body.result?.structuredContent?.card, body.result?.structuredContent?.enterAt);
    speak(text);
  } catch (err) {
    el('answer').textContent = err.message;
    el('meta').textContent = '';
    showCard(null);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    button?.focus();
    if (typeof readPhone === 'function') void readPhone();
  }
}

function setUpFree() {
  const form = el('free');
  if (!form) return;
  const box = el('free-text');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const words = box.value.trim();
    if (words) void sayAnything(words, form.querySelector('button[type=submit]'));
  });
  const Hear = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = el('mic');
  if (!Hear) { mic.hidden = true; return; }
  const label = mic.querySelector('.mic-label');
  /*
   * Listening, done the way a person speaks. The browser's recogniser used to stop at the first pause, or on a
   * cough, and could end with nothing heard; that empty text was sent and the server refused it (HTTP 400). Now it
   * keeps listening, shows the words in the box as they come, stops after about a second and a half of quiet or a
   * second press, sends only words, and says why when it could not hear.
   */
  let r = null;
  let heard = '';
  let quiet = null;
  const WHY = {
    'not-allowed': 'The microphone is blocked. Allow it for this page in the browser, or type instead.',
    'service-not-allowed': 'The microphone is blocked. Allow it for this page in the browser, or type instead.',
    'no-speech': "I didn't hear anything. Press the microphone and speak, or type instead.",
    'audio-capture': 'No microphone was found. Type instead.',
    network: "The browser's speech service could not be reached. Type instead.",
  };
  const stop = () => { if (r) r.stop(); };
  const reset = () => { r = null; clearTimeout(quiet); label.textContent = 'Speak'; mic.setAttribute('aria-label', 'Speak'); mic.classList.remove('listening'); };
  mic.addEventListener('click', () => {
    if (r) { stop(); return; }
    heard = '';
    r = new Hear();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    label.textContent = 'Listening… press again to stop';
    mic.setAttribute('aria-label', 'Listening. Press again to stop');
    mic.classList.add('listening');
    r.onresult = (ev) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) final += t; else interim += t;
      }
      heard = (final + ' ' + interim).replace(/\s+/g, ' ').trim();
      box.value = heard;
      clearTimeout(quiet);
      quiet = setTimeout(stop, 1500);
    };
    r.onerror = (ev) => {
      if (ev.error === 'aborted') return;
      const why = WHY[ev.error];
      if (why) { el('heard').classList.remove('idle'); el('screen')?.classList.add('live'); el('heard').textContent = ''; el('answer').textContent = why; el('meta').textContent = ''; }
    };
    r.onend = () => {
      const words = heard.trim();
      reset();
      if (words) void sayAnything(words, mic);
    };
    try { r.start(); } catch { reset(); }
  });
}
setUpFree();
