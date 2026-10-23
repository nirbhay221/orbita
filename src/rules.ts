/**
 * The stand-in with no model behind it.
 *
 * The talking demo asks a language model to read this server's tool list and pick a tool, which is the
 * honest test of the tool descriptions. When no model is configured, or today's budget is spent, the page
 * still has to answer somebody who types or speaks a sentence. Recall Check, another entry in this
 * hackathon, does the same thing: plain word rules choose the tool. These are those rules for Orbita.
 *
 * Every answer chosen this way says so (`model: 'word rules'`). Only the tool and the arguments that can
 * be read straight off the sentence are filled in.
 */

import type { Chosen, ToolDef } from './agent.js';

const JOBS: [RegExp, string][] = [
  [/\bplant/i, 'planting'], [/\bstrip.?till/i, 'strip_till'], [/\bcultivat/i, 'cultivating'], [/\bspray/i, 'spraying'],
  [/\bharvest|\bcombin/i, 'harvest'], [/\btill/i, 'tillage'], [/\bscout/i, 'scouting'], [/\bsurvey(?!.*drone)|\bstake|\bboundar/i, 'surveying'],
  [/\bdrone (light )?show|\bswarm|\blight show/i, 'drone_show'], [/\bdrone|\buav\b|\bmapping flight/i, 'drone_survey'], [/\bgrad(e|ing)|\bdozer|\bmachine control|\bblade/i, 'machine_control'],
];
const jobIn = (s: string): string | undefined => JOBS.find(([re]) => re.test(s))?.[1];
const CORRECTION: [RegExp, string][] = [[/\brtk\b/i, 'rtk'], [/\bppp\b|starfire|centerpoint/i, 'ppp'], [/\bwaas\b|\bsbas\b|\begnos\b|\bgagan\b|\bsouthpan\b|\bmsas\b/i, 'sbas'], [/\bno correction|\bplain gps\b/i, 'autonomous']];
const when = (s: string): string | undefined =>
  /\b(yesterday|last \w+|on \w+day|\d{1,2} \w+ \d{4}|\w+ \d{1,2},? \d{4}|this morning|at \d{1,2}\s*(am|pm))\b/i.exec(s)?.[0];

type Rule = { when: RegExp; tool: string; args?: (said: string) => Record<string, unknown> | null };

/*
 * Found by saying the demo's own lines to these rules with no model behind them, 22 October 2026: the satellite
 * operator, the robot fleet, the grid room and the household got no tool at all; "how many hours did space weather cost
 * me" got the storm status; an email address, "stop watching" and "forget everything" did nothing; and "my field is near
 * Sorriso, Brazil. The planter's on RTK. Can I plant tonight?" saved the rest of the sentence as the town. The daily
 * model budget is what makes these matter: once it is spent, these rules are the whole demo.
 */
/** The town after near, in, at or outside, up to the end of its sentence. */
const placeIn = (s: string): string | undefined =>
  /\b(?:near|in|at|outside(?: of)?|by) ([A-Z][\p{L} .,'-]{2,80})/u.exec(s)?.[1]
    ?.split(/[.?!](?:\s|$)/)[0]
    .replace(/,? and .*$/, '')
    .replace(/[.,\s]+$/, '')
    .replace(/\s+(tonight|today|tomorrow|now|right now|this (morning|afternoon|evening|week))$/i, '')
    .trim() || undefined;
/** "The North 40, near Grand Island" names the field. */
const fieldNamed = (s: string): string | undefined => {
  const name = /^(?:[Tt]he |[Mm]y |[Oo]ur )?([A-Z0-9][\w' ]{1,30}?),? (?:near|in|outside|by) [A-Z]/.exec(s.trim())?.[1]?.trim();
  return name && !/\b(field|farm) is\b|\bis$/i.test(name) ? name : undefined;
};
const correctionIn = (s: string) => CORRECTION.find(([re]) => re.test(s))?.[1];
const machineIn = (s: string) => /\b(planter|sprayer|combine|tractor|drone|dozer|rover|strip-till bar|drill|grader)\b/i.exec(s)?.[1]?.toLowerCase();
const asksToRun = /\b(can|could|should|may) (i|we|they|it|(?:the|my|our) [\w ]{1,24}?) (run|plant|spray|seed|drill|till|survey|fly|go|work|start|cut|harvest|grade)\b|\bok(ay)? to (run|plant|spray|fly)\b|\bsafe to\b/i;

const ROLE_WORDS: [RegExp, string][] = [
  [/\bsatellites?\b|\bspacecraft\b|\bconstellation\b/i, 'satellite_operator'],
  [/\bastronauts?\b|\bcrew(ed)? (in|to) (orbit|the moon)|\bspace station\b/i, 'crewed_spaceflight'],
  [/\bgrid\b|\bsubstation|\butility\b|\btransmission\b|\bcontrol room\b/i, 'grid_operator'],
  [/\bairline|\bflights?\b|\bdispatch(er)?\b|\bpolar route/i, 'airline'],
  [/\bhf\b|\bshortwave\b|\bham radio\b|\bradio net\b/i, 'hf_radio'],
  [/\bdata cent(er|re)|\bgpu cluster|\bcloud region/i, 'data_centre'],
  [/\bpipelines?\b/i, 'pipeline'], [/\bdrilling\b|\bdirectional drill/i, 'drilling'], [/\brail(way|road)?\b|\btrains?\b/i, 'rail'],
  [/\bships?\b|\bvessels?\b|\bferr(y|ies)\b/i, 'shipping'], [/\bundersea cable|\bsubsea cable/i, 'subsea_cable'],
  [/\bmines?\b|\bmining\b|\bhaul trucks?\b/i, 'mining'], [/\bfleet\b|\btrucks\b|\bvehicles\b/i, 'fleet'],
  [/\brobots?\b|\bmowers?\b/i, 'robots'], [/\bsmall plane|\bpilot\b|\bcessna\b/i, 'general_aviation'],
  [/\baurora\b|\bnorthern lights\b/i, 'aurora'],
  [/\bmy (phone|house|home|car|tv|laptop)\b|\bat home\b|\bhousehold\b/i, 'household'],
];
const roleIn = (s: string) => ROLE_WORDS.find(([re]) => re.test(s))?.[1];

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40 };
/** "Twelve hours of planting and six of spraying", as jobs and hours. */
function jobsIn(s: string): { operation: string; hours: number }[] {
  const out: { operation: string; hours: number }[] = [];
  for (const m of s.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty)(?: hours?)? of ([a-z-]+(?: [a-z-]+)?)/gi)) {
    const hours = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUM[m[1].toLowerCase()];
    const operation = jobIn(m[2]);
    if (hours && operation) out.push({ operation, hours: Math.min(72, hours) });
  }
  return out;
}

const RULES: Rule[] = [
  { when: /\b(what happened|was it the sun|went wrong|why (did|was) (my|the) (guidance|gps|rtk))\b/i, tool: 'what_happened', args: (s) => ({ when: when(s) ?? 'yesterday', operation: jobIn(s) }) },
  { when: /\b(forget everything|forget all|delete (all )?my data|start over|start fresh|erase everything)\b/i, tool: 'my_farm', args: () => ({ removeWhat: 'everything' }) },
  { when: /\b(stop (watching|waiting)|cancel the watch|don'?t watch)\b/i, tool: 'watch_jobs', args: (s) => ({ action: 'stop', operation: jobIn(s) }) },
  { when: /[\w.+-]+@[\w-]+\.[\w.]+/, tool: 'crew_contact', args: (s) => ({ action: 'add', name: /^\s*(?:add |tell |email )?([A-Z][a-z]+)\b/.exec(s)?.[1] ?? /\b([A-Z][a-z]+)(?:,| at| to the crew)/.exec(s)?.[1] ?? 'them', email: /[\w.+-]+@[\w-]+\.[\w.]*[a-z]/i.exec(s)?.[0] }) },
  { when: /\b(how many hours|hours? (did|has) .*(cost|lost|take)|cost me|downtime|how much time .* lost)\b/i, tool: 'outage_patterns', args: (s) => ({ period: /\byear\b/i.test(s) ? 'year' : /\bweek\b/i.test(s) ? 'week' : 'month', operation: jobIn(s) }) },
  { when: /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty) hours? of\b/i, tool: 'schedule_jobs', args: (s) => (jobsIn(s).length ? { jobs: jobsIn(s) } : null) },
  { when: /\b(trust (my|its|the|this|their|our) (gps|gnss|position|location|fix)|(gps|position) (reliable|trustworthy))\b/i, tool: 'position_trust', args: (s) => ({ place: placeIn(s) }) },
  // A first question that carries its own setup: answered for that town and correction, then offered to be remembered.
  { when: asksToRun, tool: 'can_i_run', args: (s) => (placeIn(s) || correctionIn(s) ? { operation: jobIn(s) ?? 'planting', place: placeIn(s), correction: correctionIn(s), equipment: machineIn(s), when: /\b(tomorrow|tonight|this afternoon|this evening|on \w+day|at \d{1,2}\s*(am|pm))\b/i.exec(s)?.[0] } : null) },
  { when: /\b(my field is|field (is )?(near|in|at)|add (a )?field|runs? (on )?(rtk|ppp|waas|sbas))\b|('s|is) on (rtk|ppp|waas|sbas)\b|, near [A-Z]/i, tool: 'my_farm', args: (s) => ({
    fieldName: fieldNamed(s),
    place: placeIn(s),
    machineName: machineIn(s),
    correction: correctionIn(s),
  }) },
  { when: /\b(i|we) (run|operate|manage|look after|fly|work (on|at|in)|own)\b|\bwhat should (i|we) do\b|\bhurt my\b|\baffect my\b/i, tool: 'what_should_i_do', args: (s) => (roleIn(s) ? { role: roleIn(s), place: placeIn(s) } : null) },
  { when: /\b(tell me when|let me know when|watch)\b/i, tool: 'watch_jobs', args: (s) => ({ action: 'start', operation: jobIn(s) ?? 'planting' }) },
  { when: /\b(anything clear|has it cleared|is it clear yet|going to clear|when does it clear)\b/i, tool: 'watch_jobs', args: () => ({ action: 'check' }) },
  { when: /\b(add|email|tell) .*\b(crew|operator|manager|party chief)\b/i, tool: 'crew_contact', args: (s) => ({ action: 'add', name: /\b([A-Z][a-z]+) to the crew\b/.exec(s)?.[1] ?? 'them' }) },
  { when: /\b(i (just )?(planted|sprayed|surveyed|flew|graded)|log (a |the )?job)\b/i, tool: 'log_job', args: (s) => ({ operation: jobIn(s) ?? 'planting' }) },
  { when: /\b(report|this week|how did (the|my) jobs)\b/i, tool: 'job_report' },
  { when: /\b(season|next few weeks|next month)\b/i, tool: 'plan_season' },
  { when: /\b(whole farm|all my fields|everything look)\b/i, tool: 'farm_status' },
  { when: /\b(sun doing|space weather|storm coming|geomagnetic|aurora|solar)\b/i, tool: 'storm_status' },
  { when: /\b(tell me more|go on|what else|why)\b/i, tool: 'tell_me_more' },
  { when: /\b(what can you do|how does this work)\b/i, tool: 'what_can_you_do' },
];

/*
 * A bare answer to the question just asked. Every setup question ends on a yes or no, and "no" on its own matches
 * no rule: it only means something against the question before it, which is how Alexa+ reads it. The page sends
 * the turns so far and the next step the last answer named; a yes takes that step, and the answers below are read
 * against the question's own words.
 */
const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|please( do)?|go ahead|do it|i do|i have|that'?s right|correct)\b/i;
const NO = /^\s*(no|nope|nah|none|not really|i don'?t|i do not|never)\b/i;
const UNSURE = /\b(not sure|don'?t know|no idea|unsure|no clue)\b/i;
type Bare = { tool: string; args: Record<string, unknown> } | null;
const BARE: [RegExp, (said: string, question: string) => Bare][] = [
  [/Is it RTK, (?:WAAS|EGNOS|GAGAN|SouthPAN|MSAS|KASS|PPP), or are you not sure\?$/, (s, q) => {
    const machine = /correction (?:the )?(.+?) runs\./.exec(q)?.[1];
    const name = machine && machine !== 'your machine' ? machine : 'my machine';
    if (UNSURE.test(s)) return { tool: 'my_farm', args: { machineName: name, notSure: true } };
    const c = CORRECTION.find(([re]) => re.test(s))?.[1];
    return c ? { tool: 'my_farm', args: { machineName: name, correction: c } } : null;
  }],
];

export function bareAnswer(utterance: string, history: { role: string; text: string }[] = [], next?: { tool?: unknown; arguments?: unknown } | null): Bare {
  const last = [...history].reverse().find((t) => t.role === 'assistant')?.text.trim() ?? '';
  if (!last) return null;
  for (const [asked, read] of BARE) if (asked.test(last)) { const hit = read(utterance, last); if (hit) return hit; }
  if (YES.test(utterance) && next && typeof next.tool === 'string') return { tool: next.tool, args: next.arguments && typeof next.arguments === 'object' ? (next.arguments as Record<string, unknown>) : {} };
  return null;
}

export function chooseByWords(utterance: string, tools: ToolDef[], history: { role: string; text: string }[] = [], next?: { tool?: unknown; arguments?: unknown } | null): Chosen {
  const bare = bareAnswer(utterance, history, next);
  if (bare && tools.some((t) => t.name === bare.tool)) return { tool: bare.tool, args: bare.args, said: '', ms: 0, model: 'word rules' } as Chosen;
  const started = Date.now();
  const listed = new Set(tools.map((t) => t.name));
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  for (const r of RULES) {
    if (!listed.has(r.tool) || !r.when.test(utterance)) continue;
    // A rule whose arguments come back null does not apply after all: the next one is tried.
    const args = r.args ? r.args(utterance) : {};
    if (args === null) continue;
    // "Watch it for me" after a question answered for a town and nothing saved: the town, the correction and the job
    // are in what the customer said before, as Alexa+ would read them from the conversation.
    if (r.tool === 'watch_jobs' && args.action === 'start') {
      const said = history.filter((t) => t.role === 'user').map((t) => t.text).reverse();
      const place = said.map(placeIn).find(Boolean);
      const correction = said.map(correctionIn).find(Boolean);
      const job = jobIn(utterance) ?? said.map(jobIn).find(Boolean);
      Object.assign(args, place ? { place } : {}, correction ? { correction } : {}, job ? { operation: job } : {});
    }
    return { tool: r.tool, args: clean(args), said: '', ms: Date.now() - started, model: 'word rules' };
  }
  // "Can I plant", "is it safe to fly", "can we run the dozer": a job named is a question about running it.
  const job = jobIn(utterance);
  if (job && listed.has('can_i_run')) {
    const at = /\b(tomorrow|tonight|this afternoon|this evening|on \w+day|at \d{1,2}\s*(am|pm))\b/i.exec(utterance)?.[0];
    return { tool: 'can_i_run', args: clean({ operation: job, when: at }), said: '', ms: Date.now() - started, model: 'word rules' };
  }
  return {
    tool: null,
    args: {},
    said: 'I did not catch what you want. Try asking whether you can plant today, or what the sun is doing.',
    ms: Date.now() - started,
    model: 'word rules',
  };
}
