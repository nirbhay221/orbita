/*
 * When the question is about, on the main page: now, or another time.
 *
 * The same control as the Echo page (see setUpWhen in echo.js): Now, or Another time with four one-tap
 * choices, a date and a time apart, and a line saying in words what is being asked about. A later time is a
 * check of the forecast for it; a past one plays back what happened. The time goes to the server as words
 * ("October 21 2026 at 9 pm"), read in the field's own time.
 */

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let when = null;

export const picked = () => when;

/** "October 21 2026 at 9 pm" */
export function spoken(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const clock = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
  return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} at ${clock}`;
}

// A day named in the words wins over the picked time, so a question never carries two dates.
const CALENDAR = /\b((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}|\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(19|20)\d\d|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i;
const DAY_WORD = /\b(today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|weekend)|next (week|month|\w+day)|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
export const namesADay = (words) => CALENDAR.test(words) || DAY_WORD.test(words);

/** A typed or spoken question, with the picked time added when the words name no day. */
export const withWhen = (words) => (when && !namesADay(words) ? `${words} I mean ${spoken(when)}.` : words);

/**
 * A tapped example, sent for the picked time. The tools that take a time get it; a past time turns a
 * check into a look back. An example whose own words name a day keeps its own.
 */
export function forWhen(tool, args, words = '') {
  if (!when || namesADay(words)) return [tool, args];
  const past = when.getTime() < Date.now() - 15 * 60_000;
  if (tool === 'can_i_run') {
    return past ? ['what_happened', { when: spoken(when), operation: args.operation ?? 'planting' }] : [tool, { ...args, when: spoken(when) }];
  }
  // storm_status takes no time: it is now and the forecast peak. A past time is a look back instead.
  if (tool === 'storm_status') return past ? ['what_happened', { when: spoken(when) }] : [tool, args];
  if (tool === 'what_happened') return [tool, { ...args, when: spoken(when) }];
  return [tool, args];
}

export function setUpWhen(onChange = () => {}) {
  const el = (id) => document.getElementById(id);
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
    onChange(when);
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
    for (const o of panel.querySelectorAll('.preset')) o.setAttribute('aria-pressed', 'false');
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
    if (!on) { when = null; tell(); return; }
    set(at(0, Math.min(23, new Date().getHours() + 1)));
  };
  now.addEventListener('click', () => show(false));
  pick.addEventListener('click', () => show(true));
}
