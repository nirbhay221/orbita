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

type Rule = { when: RegExp; tool: string; args?: (said: string) => Record<string, unknown> };

const RULES: Rule[] = [
  { when: /\b(what happened|was it the sun|went wrong|why (did|was) (my|the) (guidance|gps|rtk))\b/i, tool: 'what_happened', args: (s) => ({ when: when(s) ?? 'yesterday', operation: jobIn(s) }) },
  { when: /\b(my field is|field (is )?(near|in|at)|add (a )?field|runs? (on )?(rtk|ppp|waas|sbas))\b/i, tool: 'my_farm', args: (s) => ({
    fieldName: /field/i.test(s) ? 'Home' : undefined,
    place: /\b(?:near|in|at) ([A-Z][A-Za-z .,'-]{2,60})/.exec(s)?.[1]?.replace(/[.?!]+$/, '').replace(/,? and .*$/, ''),
    machineName: /\b(planter|sprayer|combine|tractor|drone|dozer|rover)\b/i.exec(s)?.[1]?.toLowerCase(),
    correction: CORRECTION.find(([re]) => re.test(s))?.[1],
  }) },
  { when: /\b(tell me when|let me know when|watch)\b/i, tool: 'watch_jobs', args: (s) => ({ action: 'start', operation: jobIn(s) ?? 'planting' }) },
  { when: /\b(anything clear|has it cleared|is it clear yet)\b/i, tool: 'watch_jobs', args: () => ({ action: 'check' }) },
  { when: /\b(add|email|tell) .*\b(crew|operator|manager|party chief)\b/i, tool: 'crew_contact', args: (s) => ({ action: 'add', name: /\b([A-Z][a-z]+) to the crew\b/.exec(s)?.[1] ?? 'them' }) },
  { when: /\b(i (just )?(planted|sprayed|surveyed|flew|graded)|log (a |the )?job)\b/i, tool: 'log_job', args: (s) => ({ operation: jobIn(s) ?? 'planting' }) },
  { when: /\b(report|this week|how did (the|my) jobs)\b/i, tool: 'job_report' },
  { when: /\b(trust (my|its|the|this) (gps|gnss|position|location)|(gps|position) (reliable|trustworthy))\b/i, tool: 'position_trust' },
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
    return { tool: r.tool, args: clean(r.args?.(utterance) ?? {}), said: '', ms: Date.now() - started, model: 'word rules' };
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
