/**
 * What to do about it, by who you are.
 *
 * impacts.ts says what a storm touches. This says what the person responsible
 * for that thing should actually do, and when. The useful moment for most of
 * these actions is a day before the storm, not during it: NOAA issues a
 * geomagnetic Watch one to three days ahead and Warnings minutes to an hour
 * ahead, and every operator procedure below is keyed to that lead time.
 *
 * Every action names where it comes from: NOAA's own scale descriptions, the
 * NERC operating procedure template grid control rooms work from, what
 * satellite, airline and grid operators actually did in May 2024, and the
 * published research on pipelines, drilling and rail. Where an industry's own
 * guidance is thin, the entry says less rather than more. A confident
 * instruction to a control room that turns out to be invented would end this
 * project's credibility in one sentence.
 *
 * It also never pretends to make the call. A 2025 survey of operators found
 * many chose to stay in service through the 2024 storms because losing service
 * cost more than the risk. That is a legitimate decision, and the job here is
 * to put the trade in front of the person making it, early enough to matter.
 */

import type { Slot } from './domain.js';

export type Scale = 'G' | 'S' | 'R';
export type Phase = 'quiet' | 'after' | 'watch' | 'imminent' | 'during';
export type Levels = { g: number; s: number; r: number };
export type DayOutlook = {
  date: string;
  g: number | null;
  /** Percent chance of an R1 to R2 radio blackout that day. */
  rMinorProb: number | null;
  /** Percent chance of R3 or worse. */
  rMajorProb: number | null;
  /** Percent chance of S1 or worse. */
  sProb: number | null;
};

/** Everything the playbook reads. Built from the NOAA snapshot already in memory. */
export type Sky = {
  now: Date;
  levels: Levels;
  yesterday: Levels;
  days: DayOutlook[];
  slots: Slot[];
};

export const ROLES = [
  'field_crew', 'drone_pilot', 'satellite_operator', 'crewed_spaceflight', 'grid_operator', 'airline',
  'hf_radio', 'timing', 'data_centre', 'pipeline', 'drilling', 'rail', 'maritime_dp', 'mining',
  'fleet', 'aurora', 'household', 'general_aviation', 'magnetic_survey', 'robots',
  'shipping', 'subsea_cable', 'satellite_services',
] as const;
export type Role = (typeof ROLES)[number];

/** Spoken synonyms, because Alexa+ fills this from what the customer actually said. */
export const ROLE_HINT =
  'Who is asking, by what they look after. field_crew for farming, surveying, drone mapping or grade control. ' +
  'drone_pilot for flying a drone, UAV or UAS, hobby or commercial. ' +
  'satellite_operator for running satellites, a constellation, cubesats or uncrewed spacecraft, or planning a launch. ' +
  'crewed_spaceflight for astronauts, a crewed spacecraft or capsule, a space station, a spacewalk, or a mission to the Moon. ' +
  'grid_operator for a power grid, transmission, a utility control room or substations. ' +
  'airline for flight dispatch, pilots, flight crew or flight planning. ' +
  'hf_radio for shortwave, ham or amateur radio, maritime or emergency HF. ' +
  'timing for GPS time in cell networks, telecom, trading systems or control systems. ' +
  'data_centre for running a data centre, a cloud region, servers, a GPU or AI training cluster, or AI infrastructure. ' +
  'pipeline for pipeline integrity, corrosion or cathodic protection surveys. ' +
  'drilling for directional drilling, MWD or wellbore surveys. ' +
  'rail for railway signalling or track circuits. ' +
  'maritime_dp for holding a vessel on position, dynamic positioning or DP, offshore support vessels, dredgers, ' +
  'cable layers or survey ships. ' +
  'mining for open pit mining, autonomous haulage, haul trucks, blast hole drilling or mine surveying. ' +
  'fleet for tracking trucks, vans, deliveries, telematics or a yard. ' +
  'aurora for seeing the northern lights. household for someone at home. ' +
  'general_aviation for a private or small plane pilot, flight training, or flying a GPS, WAAS or LPV approach. ' +
  'magnetic_survey for an aeromagnetic, airborne or ground magnetic survey, or magnetometer prospecting. ' +
  'robots for robot lawn mowers, delivery or sidewalk robots, warehouse or yard robots, or home robots. ' +
  'shipping for navigating a ship, a ferry, a fishing boat or a yacht, the bridge or the officer of the watch. ' +
  'subsea_cable for operating undersea telecom or internet cables, their power feed or a cable landing station. ' +
  'satellite_services for relying on satellite TV, satellite weather imagery or a satellite data feed.';

export type Source = { name: string; url: string };

const SRC = {
  noaa: { name: 'NOAA Space Weather Scales', url: 'https://www.spaceweather.gov/noaa-scales-explanation' },
  /*
   * How long a clock keeps time with GPS gone depends on its oscillator. The one published table by time budget
   * is a vendor's, said as that: Microchip's TimeProvider 4500 datasheet gives the time to drift past 1.5
   * microseconds (the end-to-end budget for mobile networks that share time) as about 16.5 hours for a standard
   * oven-controlled quartz oscillator, about 52 hours for a better one and about 4.3 days for rubidium. The ITU-T
   * G.8272.1 standard for an enhanced primary reference time clock requires holding within 100 nanoseconds of
   * UTC for 14 days.
   */
  holdoverTable: {
    name: 'Microchip TimeProvider 4500 datasheet, holdover by time budget (vendor figures)',
    url: 'https://www.microchip.com/content/dam/mchp/documents/FTD/ProductDocuments/Brochures/TimeProvider-4500-Series-Release-3.0-DS00005123.pdf',
  },
  eprtc: { name: 'ITU-T G.8272.1, enhanced primary reference time clock (via Microchip)', url: 'https://www.microchip.com/en-us/about/media-center/blog/2020/enhanced-primary-reference-time-clock-eprtc' },
  nercTemplate: {
    name: 'NERC Geomagnetic Disturbance Operating Procedure Template, Transmission Operator',
    url: 'https://www.nerc.com/globalassets/who-we-are/standing-committees/rstc/template_top.pdf',
  },
  nercMay2024: {
    name: 'NERC, May 2024 Geomagnetic Disturbance Event Review',
    url: 'https://www.nerc.com/globalassets/programs/rapa/gmd/reference-documents/may-2024-gmd-event-review.pdf',
  },
  laneve: {
    name: 'LaNeve et al., Brace for Impact: mitigation decisions of critical infrastructure operators during the 2024 solar maximum',
    url: 'https://arxiv.org/abs/2512.22424',
  },
  parkerLinares: {
    name: 'Parker and Linares, Satellite Drag Analysis During the May 2024 Gannon Geomagnetic Storm, Journal of Spacecraft and Rockets',
    url: 'https://arc.aiaa.org/doi/10.2514/1.A36164',
  },
  knipp: {
    name: 'Knipp, May 2024 Gannon Storm: Impacts on LEO Spacecraft and Operations, National Academies Space Weather Roundtable, February 2025',
    url: 'https://www.nationalacademies.org/cdn/materials/9fba0be5-6b42-4e11-8d98-fe4c5cfb896c',
  },
  ual990: {
    name: 'Advances in aviation radiation mitigation demonstrated during the Gannon storm, Frontiers in Astronomy and Space Sciences, 2025',
    url: 'https://www.frontiersin.org/journals/astronomy-and-space-sciences/articles/10.3389/fspas.2025.1657731/full',
  },
  droneAcademy: {
    name: 'Drone Academy, What is the Kp index and why does it matter to drone pilots',
    url: 'https://www.droneacademy.com/what-is-kp-index/',
  },
  cisa: {
    name: 'CISA advisory ICSA-11-084-01, Solar Magnetic Storm Impact on Control Systems',
    url: 'https://www.cisa.gov/news-events/ics-advisories/icsa-11-084-01',
  },
  divett: {
    name: 'Divett et al., Modeling Pipe to Soil Potentials From Geomagnetic Storms in Gas Pipelines, Space Weather, 2023',
    url: 'https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2023SW003601',
  },
  halliburton: {
    name: 'Halliburton, IFR2 service delivers accuracy amidst storms in Alaska',
    url: 'https://www.halliburton.com/en/resources/operator-continues-drilling-despite-magnetic-storm',
  },
  bgs: {
    name: 'British Geological Survey, directional drilling services',
    url: 'https://geomag.bgs.ac.uk/data_service/directionaldrilling/home.html',
  },
  boteler: {
    name: 'Boteler, Modeling Geomagnetic Interference on Railway Signaling Track Circuits, Space Weather, 2021',
    url: 'https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2020SW002609',
  },
  patterson: {
    name: 'Patterson et al., Modeling wrong side failures caused by geomagnetically induced currents in electrified railway signaling, Space Weather, 2023',
    url: 'https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2023SW003625',
  },
  imca: {
    name: 'IMCA, Increasing Solar Activity and the Effect on GNSS Positioning',
    url: 'https://www.imca-int.com/information-notes/increasing-solar-activity-and-the-effect-on-gnss-positioning/',
  },
  nistGps: {
    name: 'Economic Benefits of the Global Positioning System, RTI International for NIST, 2019',
    url: 'https://www.nist.gov/system/files/documents/2020/02/06/gps_finalreport618.pdf',
  },
  mineTruck: {
    name: 'IMU and LiDAR collaborative positioning for unmanned mine trucks under weak GNSS conditions, Scientific Reports',
    url: 'https://www.nature.com/articles/s41598-026-52022-8',
  },
  uptime: {
    name: 'Uptime Institute, Data centers weather solar storms',
    url: 'https://journal.uptimeinstitute.com/data-centers-weather-solar-storms/',
  },
  dhsPnt: {
    name: 'DHS, Resilient Positioning, Navigation, and Timing Reference Architecture',
    url: 'https://www.dhs.gov/sites/default/files/2022-06/22_0609_st_resilient_pnt_ra.pdf',
  },
  starlinkMay2024: {
    name: 'Starlink reports degraded service in the May 2024 storm (The Register)',
    url: 'https://www.theregister.com/2024/05/13/starlink_solar_storm/',
  },
  cablesGoogle: {
    name: 'Castellanos and others (Google), Solar storms and submarine internet cables',
    url: 'https://www.datacenterdynamics.com/en/news/google-researchers-confirm-submarine-cables-are-safe-from-solar-storms/',
  },
  cablesJyothi: {
    name: 'Abdu Jyothi, Solar Superstorms: Planning for an Internet Apocalypse, SIGCOMM 2021',
    url: 'https://ics.uci.edu/~sabdujyo/papers/sigcomm21-cme.pdf',
  },
  srag: {
    name: 'NASA Space Radiation Analysis Group, why space weather matters to crews',
    url: 'https://srag.jsc.nasa.gov/SpaceWeather/Motivation.cfm',
  },
  sragOverview: {
    name: 'NASA/JSC Space Radiation Analysis Group, overview of operations (Whitman)',
    url: 'https://cpaess.ucar.edu/sites/default/files/meetings/2017/documents/Whitman-Kathryn-Space-Radiation.pdf',
  },
  artemisShelter: {
    name: 'NASA, To Protect Artemis II Astronauts, NASA Experts Keep Eyes on Sun',
    url: 'https://science.nasa.gov/missions/artemis/artemis-2/to-protect-artemis-ii-astronauts-nasa-experts-keep-eyes-on-sun/',
  },
  s4Jan2026: {
    name: 'NOAA SWPC, S4 (Severe) Solar Radiation Storm in Progress, 19 January 2026',
    url: 'https://www.spaceweather.gov/news/s4-severe-solar-radiation-storm-progress-january-19th-2026',
  },
  goesElectrons: {
    name: 'NOAA SWPC, GOES Electron Flux and its alert for deep dielectric charging',
    url: 'https://www.swpc.noaa.gov/products/goes-electron-flux',
  },
  radiationBelts: {
    name: "Baker and others, Space Weather Effects in the Earth's Radiation Belts, Space Science Reviews",
    url: 'https://link.springer.com/article/10.1007/s11214-017-0452-7',
  },
  glauert: {
    name: 'Glauert and others, A 30-Year Simulation of the Outer Electron Radiation Belt, Space Weather',
    url: 'https://nora.nerc.ac.uk/id/eprint/520357/1/Glauert-2018-A--year-simulation-of-the-outer-ele.pdf',
  },
  webbLaunch: {
    name: 'Minow and others (NASA), Space Weather Launch Constraints for JWST',
    url: 'https://ntrs.nasa.gov/api/citations/20230013623/downloads/Minow_etal_ASEC_2023_presentation.pdf',
  },
  waasMay2024: {
    name: 'FAA William J. Hughes Technical Center, WAAS Discrepancy Report 158, ionospheric activity 10 to 12 May 2024',
    url: 'https://www.nstb.tc.faa.gov/Discrepancy%20Reports%20PDF/DR%20158%20Iono%20Activity%20May%2010%20-%2012%202024.pdf',
  },
  satNavNews: {
    name: 'FAA SatNavNews, volume 78, summer 2024',
    url: 'https://www.faa.gov/sites/faa.gov/files/SatNavNews_vol78_Summer_2024_Final.pdf',
  },
  bomSurvey: {
    name: 'Australian Bureau of Meteorology Space Weather Services, Geomagnetic Pulsations in Aeromagnetic Surveys',
    url: 'https://sws.bom.gov.au/Educational/3/1/2',
  },
  usgsReflights: {
    name: 'USGS Open-File Report 02-98, survey specifications appendix',
    url: 'https://pubs.usgs.gov/of/2002/0098/APPENDIX.HTM',
  },
  radioBurst: {
    name: 'Cerruti and others, Effect of intense December 2006 solar radio bursts on GPS receivers, Space Weather (2008)',
    url: 'https://doi.org/10.1029/2007SW000375',
  },
  danishRtk: {
    name: 'Ingenioren, Danish farmers hit by huge solar storm: machinery at a standstill (May 2024)',
    url: 'https://ing.dk/artikel/danish-farmers-hit-huge-solar-storm-machinery-standstill',
  },
  uscgTrustVerify: {
    name: 'US Coast Guard marine safety alert, Global Navigation Satellite Systems: Trust, But Verify, 19 January 2016',
    url: 'https://amerisurv.com/?p=15313',
  },
  medford1989: {
    name: 'Medford and others, Transatlantic Earth Potential Variations During the March 1989 Magnetic Storms, Geophysical Research Letters (1989)',
    url: 'https://www.nokia.com/bell-labs/publications-and-media/publications/transatlantic-earth-potential-variations-during-the-march-1989-magnetic-storms',
  },
  boteler2024: {
    name: 'Boteler and others, An Examination of Geomagnetic Induction in Submarine Cables, Space Weather (2024)',
    url: 'https://doi.org/10.1029/2023SW003687',
  },
  goes16May2024: {
    name: 'May 2024 solar storms (Wikipedia, citing NOAA): GOES-16 stopped transmitting all data on 13 May 2024',
    url: 'https://en.wikipedia.org/wiki/May_2024_solar_storms',
  },
  dlrSectors: {
    name: 'DLR, the impact of space weather on Earth: satellite communications and TV broadcasting, meteorological forecasting',
    url: 'https://www.dlr.de/en/research-and-transfer/featured-topics/space-weather/visualising-space-weather/infographic-impact-of-space-weather-on-earth',
  },
  yizengaw2026: {
    name: 'Yizengaw and others, the November 2025 superstorm over the American sector, Geophysical Research Letters (2026)',
    url: 'https://doi.org/10.1029/2026GL124645',
  },
} satisfies Record<string, Source>;

type Ctx = { expected: Levels };

export type Action = {
  when: Exclude<Phase, 'quiet'>[];
  /** Only said once this scale is expected to reach this level. HF blackout advice needs an R event. */
  needs?: { scale: Scale; from: number };
  say: string | ((c: Ctx) => string);
  sources: Source[];
  /** Said only for this kind of orbit when the caller names one; said to everyone when they do not. */
  orbit?: Orbit;
};

/** low is low Earth orbit; medium is where navigation satellites fly; high is geostationary; beyond is the Moon and deep space. */
export const ORBITS = ['low', 'medium', 'high', 'beyond'] as const;
export type Orbit = (typeof ORBITS)[number];

type Driver = { scale: Scale; from: (geomagneticLat: number | null) => number };

type Playbook = {
  label: string;
  drivers: Driver[];
  actions: Action[];
  quiet: string;
  note?: { say: string; sources: Source[] };
};

const at = (n: number) => () => n;

/**
 * NOAA's own descriptions put some effects at a lower level for high latitude
 * systems than for everyone else (G2 "high-latitude power systems", "HF radio
 * propagation can fade at higher latitudes"). Only roles whose source says so
 * use this.
 */
const byLatitude = (high: number, other: number) => (lat: number | null) =>
  lat != null && Math.abs(lat) >= 55 ? high : other;

/** Where NOAA says aurora has been seen at each G level, NOAA's own places. */
const AURORA_REACH: Record<number, string> = {
  1: 'northern Michigan and Maine',
  2: 'New York and Idaho',
  3: 'Illinois and Oregon',
  4: 'Alabama and northern California',
  5: 'Florida and southern Texas',
};

export const PLAYBOOKS: Record<Role, Playbook> = {
  field_crew: {
    label: 'GPS guided field work',
    drivers: [
      { scale: 'G', from: at(1) },
      { scale: 'R', from: at(3) },
    ],
    actions: [
      {
        when: ['watch', 'imminent', 'during', 'after'],
        say: 'Ask me whether you can run the job on your field, and I will check it against your rig and the accuracy that job needs.',
        sources: [SRC.noaa],
      },
      /*
       * A big flare can come with a solar radio burst, which drowns the GPS signal itself on the daylit side. In
       * December 2006 one cut the dual frequency stations tracking four satellites from over 120 to under 60. Rare,
       * short, and nothing the geomagnetic forecast sees coming, so it is said only while a strong flare is running.
       */
      {
        when: ['during'],
        needs: { scale: 'R', from: 3 },
        say: 'A strong solar flare is running. Rarely one comes with a radio burst that drowns GPS on the daylit side for some minutes, as in December 2006, so if guidance drops in daylight now, wait a few minutes before you blame the rig.',
        sources: [SRC.noaa, SRC.radioBurst],
      },
    ],
    quiet: 'Nothing in the forecast should upset satellite guidance for field work.',
  },

  /*
   * Holding a ship on a spot is the same problem as holding a planter on a row,
   * with a worse consequence: a drill floor, a diver or a cable is on the other
   * end of it. IMCA's own note is the source, including the detail that
   * scintillation bites hardest in the hours after local sunset.
   */
  maritime_dp: {
    label: 'holding a vessel on position',
    drivers: [{ scale: 'G', from: at(1) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Put satellite positioning loss into the risk assessment for anything critical, and set the point in your operating guidelines where you reduce capability or stop.',
        sources: [SRC.imca],
      },
      {
        when: ['watch', 'imminent'],
        say: 'Line up a reference that does not come from satellites, inertial, acoustic, radar or laser, and prove it is working before you need it.',
        sources: [SRC.imca],
      },
      {
        when: ['during'],
        say: 'Watch for scintillation after dark. The worst of it runs from about an hour after local sunset until midnight.',
        sources: [SRC.imca],
      },
      {
        when: ['during'],
        say: 'If position goes unstable, fall back to the non satellite reference and suspend the critical part of the job rather than holding on a degraded fix.',
        sources: [SRC.imca],
      },
    ],
    quiet: 'Nothing in the forecast should upset satellite positioning for station keeping.',
  },

  /*
   * An autonomous haul truck is built to stop rather than guess when its
   * centimetre fix degrades, which turns a space weather problem into a
   * production problem. Survey and blast hole setting out are the tasks that
   * actually need the centimetres.
   */
  mining: {
    label: 'automated mining',
    // From G3, not G1. This used to tell a mine to expect its centimetre corrections to drop out at a minor
    // storm. Permanent receivers at four North American sites held about 2 cm through Kp 5 and 6 and lost
    // precise positioning at Kp 8 and 9 (evals/receivers.mjs), so the warning starts where the loss does.
    drivers: [{ scale: 'G', from: at(3) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Expect centimetre corrections to drop out. Autonomous haulage stops rather than guesses when accuracy falls below its threshold, so plan for stoppages instead of being surprised by them.',
        sources: [SRC.mineTruck],
      },
      {
        when: ['watch', 'imminent'],
        say: 'Move survey, blast hole setting out and anything else that needs centimetres away from the worst hours.',
        sources: [SRC.nistGps],
      },
      {
        when: ['during'],
        say: 'Run on inertial backup or manual where you have it, and keep the pit working on tasks that do not need precise positioning.',
        sources: [SRC.mineTruck],
      },
      {
        when: ['after'],
        say: 'Check anything positioned during the storm before you drill or blast on it, because survey and drill positioning are the mining tasks that lean hardest on satellite accuracy.',
        sources: [SRC.nistGps],
      },
    ],
    quiet: 'Nothing in the forecast should drop autonomous haulage or survey accuracy.',
  },

  /*
   * The honest role. Ordinary vehicle tracking rides through most storms, and
   * saying otherwise to a fleet manager would be crying wolf, so this one only
   * speaks at the strong end and names the two things that genuinely move.
   */
  fleet: {
    label: 'tracking a vehicle fleet',
    drivers: [{ scale: 'G', from: at(3) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Ordinary vehicle tracking rides through most storms. Plan for the two parts that do move: satellite messaging in remote areas, and any yard or terminal equipment that needs centimetres.',
        sources: [SRC.nistGps, SRC.noaa],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 4 },
        say: 'Satellite navigation can be degraded for hours at this level, so treat arrival times and geofences as rough and do not dispatch on them alone.',
        sources: [SRC.noaa],
      },
      {
        when: ['during'],
        needs: { scale: 'R', from: 2 },
        say: 'A radio blackout is running on the sunlit side, so satellite phones and radio backups for remote runs can be unreliable while it lasts.',
        sources: [SRC.noaa],
      },
      {
        when: ['after'],
        say: 'If a geofence or an arrival time looked wrong during the storm, that is the likely reason, and it is worth checking before it lands on a driver.',
        sources: [SRC.nistGps],
      },
    ],
    quiet: 'Nothing in the forecast should upset vehicle tracking.',
  },

  drone_pilot: {
    label: 'flying drones',
    drivers: [{ scale: 'G', from: at(1) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Check the Kp again before you launch, and practise flying without GPS hold, in attitude or manual mode, so a lost fix is not the first time you do it.',
        sources: [SRC.droneAcademy],
      },
      {
        when: ['imminent', 'during'],
        say: 'Keep the aircraft close and in sight. The home point and return to home can be less precise, so be ready to fly it back yourself.',
        sources: [SRC.droneAcademy],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 3 },
        say: 'Postpone mapping flights. NOAA expects intermittent satellite navigation problems from G3, and the error lands in every image.',
        sources: [SRC.noaa],
      },
      {
        when: ['after'],
        say: 'Check flight logs for position jumps before trusting any mapping flown during the storm.',
        sources: [SRC.droneAcademy],
      },
    ],
    quiet: 'Kp is low enough that satellite positioning should behave for flying.',
  },

  satellite_operator: {
    label: 'satellite operations',
    drivers: [
      { scale: 'G', from: at(2) },
      { scale: 'S', from: at(2) },
    ],
    actions: [
      {
        when: ['watch', 'imminent'],
        orbit: 'low',
        say: 'Expect orbit predictions to degrade. NOAA says drag changes affect them from G2, and in May 2024 air density at 400 kilometres reached six times normal.',
        sources: [SRC.noaa, SRC.parkerLinares],
      },
      {
        when: ['watch'],
        say: 'Put the team on alert and free people up by deferring routine ground maintenance. Staff awareness was the most common step operators took in 2024.',
        sources: [SRC.laneve],
      },
      {
        when: ['watch', 'imminent', 'during'],
        orbit: 'medium',
        say: 'In medium orbit, where navigation satellites fly, there is no drag; the hazard is the outer radiation belt. Its energetic electrons build charge inside components, and a storm can raise them enormously, ten thousand times in the 2003 Halloween storm. NOAA measures them at geostationary orbit and not in medium orbit, so treat its electron alert as the nearest warning you have.',
        sources: [SRC.radiationBelts, SRC.glauert, SRC.goesElectrons],
      },
      {
        when: ['watch', 'imminent', 'during'],
        orbit: 'high',
        say: 'In geostationary and other high orbits there is no drag to worry about; the problem is charging. Energetic electrons build charge inside insulation until it discharges, which is why NOAA alerts when electrons above 2 MeV pass 1,000 at its GOES satellites. Hold commanding that can wait and watch for phantom commands.',
        sources: [SRC.goesElectrons, SRC.noaa],
      },
      {
        when: ['watch', 'imminent'],
        say: 'For a launch, the published example of a rule is the Webb telescope\'s: no go from twelve hours to ten minutes before lift-off with a NOAA warning out for protons above 100 MeV, or with the flux above 50 MeV past 5, because those protons upset avionics on the way up. Such a rule avoids a storm that is already running; it cannot predict one.',
        sources: [SRC.webbLaunch],
      },
      {
        when: ['watch', 'imminent'],
        say: 'Decide now whether a launch or deployment into low orbit should wait. About one in ten operators surveyed held launches in 2024.',
        sources: [SRC.laneve],
      },
      {
        when: ['imminent', 'during'],
        orbit: 'low',
        say: 'Treat conjunction warnings as low confidence for about three days. In May 2024 collision avoidance was compromised that long, and about half of all active low orbit satellites manoeuvred at once.',
        sources: [SRC.knipp, SRC.parkerLinares],
      },
      {
        when: ['during'],
        say: 'Choose deliberately between safe mode and staying in service. In May 2024 Planet paused imaging, a UK cubesat was powered down and ICESat-2 dropped into safe hold on its own, while other operators stayed in service because losing it cost more.',
        sources: [SRC.knipp, SRC.laneve],
      },
      {
        when: ['during'],
        needs: { scale: 'S', from: 2 },
        say: 'Protons are up. NOAA expects single event upsets, and from S3 noise in imaging and star trackers, so check memory and attitude health.',
        sources: [SRC.noaa],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 3 },
        say: 'NOAA expects surface charging on spacecraft components from G3.',
        sources: [SRC.noaa],
      },
      {
        when: ['after'],
        orbit: 'low',
        say: 'Run fresh orbit determination before trusting ephemerides. Storm time orbit forecasts can be off by tens of kilometres, and several low cubesats re-entered early after May 2024.',
        sources: [SRC.knipp],
      },
      {
        when: ['after'],
        orbit: 'low',
        say: 'Budget propellant to restore station keeping. Putting spacecraft back where they were cost significant fuel after May 2024.',
        sources: [SRC.knipp],
      },
    ],
    quiet: "Nothing in NOAA's three day forecast should change orbit predictions or radiation risk.",
  },

  /*
   * People in space. For a crew the scale that matters is S, protons, and the thing that changes with where they
   * are is how much of the Earth's magnetic field is in the way: a station in low orbit is inside it for most of
   * each orbit, a crew on the way to the Moon is outside it altogether. NOAA's scale names spacewalks from S3.
   * NASA's radiation group publishes what gets through a suit and what gets through a hull, and the Artemis II
   * shelter plan is public. Flight rules themselves are not published, so nothing here states one: each line
   * says what a published source says, and that the decision is the flight surgeon's and the flight director's.
   */
  crewed_spaceflight: {
    label: 'crewed spaceflight',
    drivers: [
      { scale: 'S', from: at(1) },
      { scale: 'G', from: at(4) },
    ],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Plan spacewalks around the forecast. NOAA recommends astronauts outside the vehicle avoid the radiation from S3 and calls the hazard unavoidable at S4. Protons above about 10 MeV get through a spacesuit; it takes about 100 MeV to get inside the spacecraft.',
        sources: [SRC.noaa, SRC.sragOverview],
      },
      {
        when: ['during'],
        needs: { scale: 'S', from: 3 },
        say: 'Bring anyone outside back in and hold spacewalks: this is the level NOAA names for it. The call is the flight director\'s and the flight surgeon\'s.',
        sources: [SRC.noaa],
      },
      {
        when: ['imminent', 'during'],
        orbit: 'beyond',
        say: 'Beyond low Earth orbit there is no magnetic field in the way, so a crew near the Moon or in deep space takes the whole event. Shelter on the first threshold rather than waiting to see how large it gets.',
        sources: [SRC.srag, SRC.artemisShelter],
      },
      {
        when: ['imminent', 'during'],
        orbit: 'low',
        say: 'In low Earth orbit the magnetic field shields the crew for most of each orbit. The exposed stretches are the passes at high latitude and through the South Atlantic Anomaly, so that is when to be in the most shielded module.',
        sources: [SRC.srag, SRC.sragOverview],
      },
      {
        when: ['watch', 'imminent', 'during'],
        say: 'Know where the most shielded part of the vehicle is and how long a shelter takes to build. On Artemis II the crew can build one inside Orion from stowed equipment in about half an hour, at a dose rate set in advance, with a lower level that only raises the watch.',
        sources: [SRC.artemisShelter],
      },
      {
        when: ['imminent', 'during'],
        say: 'Decide on the alert, not the forecast. The particles from a large event can arrive tens of minutes after the flare, about half an hour on average, and nobody can time one days ahead.',
        sources: [SRC.sragOverview],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 4 },
        orbit: 'low',
        say: 'A station in low orbit also feels the drag: in May 2024 air density at 400 kilometres reached six times normal, so expect to lose altitude faster and plan the reboost.',
        sources: [SRC.parkerLinares],
      },
      {
        when: ['after'],
        say: 'Read the crew dosimeters and the cabin sensors and give the dose to the flight surgeon before the next spacewalk is planned.',
        sources: [SRC.artemisShelter],
      },
    ],
    quiet: 'No solar radiation storm is running or forecast strongly enough to change a spacewalk or send a crew to shelter.',
    note: {
      say: 'The last S4 radiation storm was on 19 January 2026, the first since October 2003.',
      sources: [SRC.s4Jan2026],
    },
  },

  grid_operator: {
    label: 'power grid operations',
    drivers: [{ scale: 'G', from: byLatitude(2, 3) }],
    actions: [
      {
        when: ['watch'],
        say: 'Check black start units and cranking paths are ready, and warn field crews they may be sent to substations to monitor on site.',
        sources: [SRC.nercTemplate],
      },
      {
        when: ['watch'],
        say: 'If your GIC studies support it, return equipment on outage to service, especially series capacitors, and delay planned outages.',
        sources: [SRC.nercTemplate],
      },
      {
        when: ['imminent', 'during'],
        say: "Watch reactive reserves, voltage and MVAR swings, harmonics, and transformer temperature and gassing. NERC's starting point for concern is ten amps of GIC per phase on heavily loaded transformers.",
        sources: [SRC.nercTemplate],
      },
      {
        when: ['during'],
        say: 'Hold reactive reserves up and take load off susceptible equipment, and act on at least two indicators, never GIC alone.',
        sources: [SRC.nercTemplate, SRC.laneve],
      },
      {
        when: ['after'],
        say: 'Log GIC, harmonics and any relay or capacitor bank operations. Those are what NERC reviewed after May 2024.',
        sources: [SRC.nercMay2024],
      },
    ],
    quiet: "Nothing in NOAA's forecast calls for your geomagnetic disturbance procedure.",
    note: {
      say: "In May 2024 NOAA's notification came about six hours before storm conditions, operators ran their procedures, and the bulk power system stayed stable through G5.",
      sources: [SRC.nercMay2024],
    },
  },

  airline: {
    label: 'flight operations',
    drivers: [
      { scale: 'S', from: at(1) },
      { scale: 'R', from: at(3) },
      { scale: 'G', from: at(4) },
    ],
    actions: [
      {
        when: ['watch'],
        say: 'Put the space weather advisory in the flight packet and brief crews. That is how most crews heard about it in 2024.',
        sources: [SRC.laneve],
      },
      {
        when: ['watch', 'imminent'],
        say: 'Where a flight can wait, delay it. Otherwise plan a lower latitude, lower altitude track: in May 2024 United kept UAL 990 south of 51 degrees and around 10.4 to 11 kilometres, and the crew took a lower dose than on a quiet day.',
        sources: [SRC.laneve, SRC.ual990],
      },
      {
        when: ['imminent'],
        say: 'Carry extra fuel for the longer routing.',
        sources: [SRC.laneve],
      },
      {
        when: ['during'],
        needs: { scale: 'R', from: 3 },
        say: 'HF contact on the sunlit side can be lost for an hour or more, so do not plan around HF alone.',
        sources: [SRC.noaa],
      },
      // NOAA puts single event upsets in satellite electronics from S3. Avionics at cruise sit under the same particles
      // with less shielding than the ground has, so the line asks for a report, not a diagnosis.
      {
        when: ['during'],
        needs: { scale: 'S', from: 3 },
        say: 'At this level NOAA expects single event upsets in satellite electronics, and avionics at cruise see the same particles, so treat an unexplained avionics fault as possibly radiation and report it.',
        sources: [SRC.noaa],
      },
      {
        when: ['during'],
        needs: { scale: 'S', from: 1 },
        say: 'Radiation is raised at high latitudes. Keep flights off polar routes and lower where you can.',
        sources: [SRC.noaa, SRC.ual990],
      },
      // The May 2024 replay (evals/may2024.mjs) found this only said a day ahead. United set UAL 990's route at
      // 15 UTC on 10 May, seven hours before departure and with the storm already running, for fear of losing
      // communications at high latitude. Flights keep leaving through a storm that lasts days.
      {
        when: ['during'],
        needs: { scale: 'G', from: 4 },
        say: 'For flights leaving while it runs, plan the lower latitude, lower altitude track too. United set UAL 990 south of 51 degrees seven hours before departure in May 2024, with the storm already under way, because high latitude routes risked losing communications.',
        sources: [SRC.ual990],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 4 },
        say: 'Satellite navigation can be degraded for hours and WAAS was affected in May 2024, so have an approach that does not depend on it.',
        sources: [SRC.noaa, SRC.knipp],
      },
    ],
    quiet: "Nothing in NOAA's forecast calls for polar rerouting or HF contingencies.",
  },

  hf_radio: {
    label: 'HF radio',
    drivers: [
      { scale: 'R', from: at(1) },
      { scale: 'S', from: at(1) },
      { scale: 'G', from: byLatitude(2, 4) },
    ],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Keep a way to reach people that is not HF for anything that matters. At the extreme end NOAA expects no HF contact at all across the sunlit side.',
        sources: [SRC.noaa],
      },
      {
        when: ['during'],
        needs: { scale: 'R', from: 1 },
        say: 'A radio blackout is running on the sunlit side of the Earth. At R2 it lasts tens of minutes and at R3 about an hour, so wait it out or work a path on the night side.',
        sources: [SRC.noaa],
      },
      {
        when: ['during'],
        needs: { scale: 'S', from: 1 },
        say: 'Polar paths are degraded while the radiation storm runs, so route around the poles.',
        sources: [SRC.noaa],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 2 },
        say: 'HF fades at higher latitudes while the geomagnetic storm runs.',
        sources: [SRC.noaa],
      },
    ],
    quiet: "No radio blackout or polar radiation event is running, and NOAA's chance of one is low.",
  },

  timing: {
    label: 'GPS timing',
    drivers: [{ scale: 'G', from: at(3) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Make sure anything that takes its time from GPS has a backup timing source for a temporary loss of GPS, which is what CISA recommends for control systems.',
        sources: [SRC.cisa],
      },
      {
        when: ['watch', 'imminent'],
        say: 'Know how long your clocks keep time without GPS. A vendor table puts drifting past the 1.5 microseconds mobile networks allow at about 16 hours for a standard quartz oscillator, 2 days for a better one and 4 days for rubidium.',
        sources: [SRC.holdoverTable],
      },
      {
        when: ['watch', 'imminent', 'during'],
        needs: { scale: 'G', from: 4 },
        say: 'Hours of degraded GPS at G4 is within what rubidium rides out and past what a standard quartz oscillator does. An enhanced reference clock to the ITU standard holds within 100 nanoseconds for 14 days.',
        sources: [SRC.holdoverTable, SRC.eprtc, SRC.noaa],
      },
      {
        when: ['imminent', 'during'],
        say: 'Plan for how long you can run without GPS time. NOAA expects satellite navigation to be intermittent at G3, degraded for hours at G4 and for days at G5.',
        sources: [SRC.noaa],
      },
      {
        when: ['after'],
        say: 'Check every GPS timed system went back to satellite time cleanly before trusting its timestamps.',
        sources: [SRC.cisa],
      },
    ],
    quiet: 'No storm in the forecast is strong enough to threaten satellite timing.',
  },

  /*
   * Data centres and the AI clusters in them. A storm does not reach the servers: a building on the ground is
   * under the whole atmosphere, and nobody has documented a geomagnetic storm damaging computing hardware at
   * ground level. It reaches what the building depends on. The grid that feeds it (the Uptime Institute's
   * guidance), the GPS time its clocks follow (DHS), satellite links at remote sites (Starlink in May 2024) and
   * the long-haul routes between regions, where two published studies disagree about undersea cables and
   * agree that the grid at the landing ends is exposed. Each line below says which, and nothing here claims a
   * chip is at risk.
   */
  data_centre: {
    label: 'data centres and AI infrastructure',
    drivers: [{ scale: 'G', from: at(3) }],
    actions: [
      {
        when: ['watch', 'imminent', 'during'],
        say: 'The risk to a data centre or an AI cluster is the grid, not the servers: a storm drives currents into long transmission lines and can trip or damage transformers. Check generator fuel now and that the transfer to backup power has been tested. The Uptime Institute advises more fuel on site ahead of intense solar activity.',
        sources: [SRC.uptime],
      },
      {
        when: ['watch', 'imminent'],
        say: 'Grid operators delay their own planned outages and hold reserves through a storm, so expect less margin from the utility, and do not take a power path of your own out for maintenance until it has passed.',
        sources: [SRC.nercTemplate],
      },
      {
        when: ['imminent', 'during'],
        say: 'Clocks that follow GPS should be ready to run in holdover on their own oscillator. NOAA expects satellite navigation to be intermittent at G3, degraded for hours at G4 and for days at G5, so know how long your time servers hold before logs and distributed systems drift apart.',
        sources: [SRC.noaa, SRC.dhsPnt],
      },
      {
        when: ['watch', 'imminent'],
        say: 'Know how long your clocks keep time without GPS. A vendor table puts drifting past the 1.5 microseconds mobile networks allow at about 16 hours for a standard quartz oscillator, 2 days for a better one and 4 days for rubidium.',
        sources: [SRC.holdoverTable],
      },
      {
        when: ['watch', 'imminent', 'during'],
        needs: { scale: 'G', from: 4 },
        say: 'Hours of degraded GPS at G4 is within what rubidium rides out and past what a standard quartz oscillator does. An enhanced reference clock to the ITU standard holds within 100 nanoseconds for 14 days.',
        sources: [SRC.holdoverTable, SRC.eprtc, SRC.noaa],
      },
      {
        when: ['imminent', 'during'],
        say: 'Sites and edge devices that reach the network over low orbit satellites should expect degraded service: Starlink reported it in the May 2024 storm, when about half of all active low orbit satellites manoeuvred at once.',
        sources: [SRC.starlinkMay2024],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 5 },
        say: 'At G5 the Uptime Institute suggests considering running on backup power to isolate the site from the grid, and warns that an outage from the largest storms can outlast the fuel. That is the case for spreading training and serving across regions and keeping an offline copy of what cannot be rebuilt.',
        sources: [SRC.uptime],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 4 },
        say: 'For traffic between continents: a Google study found undersea cables have voltage margin for a once in a century storm and put the risk in the power grids at their landing ends, while an earlier study put it in the cable repeaters. Either way, do not depend on one long-haul route.',
        sources: [SRC.cablesGoogle, SRC.cablesJyothi],
      },
      {
        when: ['after'],
        say: 'Check every time source went back to satellite time cleanly before trusting timestamps across systems, top the fuel back up, and ask the utility whether any transformer feeding you alarmed.',
        sources: [SRC.cisa, SRC.uptime],
      },
    ],
    quiet: 'No storm in the forecast is strong enough to threaten the grid, the satellite timing or the satellite links a data centre depends on.',
    note: {
      say: 'Servers on the ground are not what a storm reaches: it is the grid, GPS time and satellite links they depend on. Chips in orbit are different, where particle strikes flip bits.',
      sources: [SRC.uptime],
    },
  },

  pipeline: {
    label: 'pipeline integrity',
    drivers: [{ scale: 'G', from: byLatitude(2, 3) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Move pipe to soil potential and cathodic protection surveys out of the storm window. Induced currents corrupt the readings.',
        sources: [SRC.divett],
      },
      {
        when: ['during'],
        say: 'Flag any cathodic protection readings taken now for a re-survey. NOAA says induced pipeline currents affect preventive measures at G4 and reach hundreds of amps at G5.',
        sources: [SRC.noaa, SRC.divett],
      },
      {
        when: ['after'],
        say: 'Re-survey anything recorded during the storm before acting on it.',
        sources: [SRC.divett],
      },
    ],
    quiet: 'No storm in the forecast should disturb cathodic protection readings.',
  },

  drilling: {
    label: 'directional drilling',
    drivers: [{ scale: 'G', from: byLatitude(1, 2) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Line up geomagnetic referencing or nearby observatory corrections for your magnetic surveys before it arrives.',
        sources: [SRC.bgs, SRC.halliburton],
      },
      {
        when: ['during'],
        say: 'Do not read an out of tolerance survey as a failed tool. In an Alaska storm the field swung to twice the quality limits, and in-field referencing let the operator keep drilling and save about 15,000 dollars.',
        sources: [SRC.halliburton],
      },
      {
        when: ['during'],
        say: 'Without a live magnetic reference, hold magnetic surveys and retake them once it quiets.',
        sources: [SRC.halliburton],
      },
    ],
    quiet: 'No storm in the forecast should upset magnetic surveys.',
  },

  rail: {
    label: 'railway signalling',
    drivers: [{ scale: 'G', from: at(4) }],
    actions: [
      {
        when: ['imminent', 'during'],
        say: 'Tell signal maintainers an unexplained signal change may be storm induced, and log it. In a Swedish storm in 1982 a signal went from green to red with no train on the section.',
        sources: [SRC.boteler],
      },
    ],
    quiet: 'No storm in the forecast is strong enough to worry track circuits.',
    note: {
      say: 'UK modelling finds a storm of the size seen once every one or two decades could turn a red signal green on some lines.',
      sources: [SRC.patterson],
    },
  },

  aurora: {
    label: 'seeing the aurora',
    drivers: [{ scale: 'G', from: at(1) }],
    actions: [
      {
        when: ['watch', 'imminent', 'during'],
        say: ({ expected }) => {
          const level = Math.max(1, Math.min(5, expected.g));
          // The storm replays (evals/storms.mjs) found NOAA's G4 line short of what was seen: at Kp 9 minus in
          // November 2025 auroral precipitation reached Florida. NOAA's line is kept, and what happened follows it.
          const seen = level >= 4 ? ' At the top of the G4 in November 2025 it reached Florida.' : '';
          return `At G${level} NOAA says aurora has been seen as far south as ${AURORA_REACH[level]}.${seen} Get away from city lights after dark and look north.`;
        },
        sources: [SRC.noaa, SRC.yizengaw2026],
      },
    ],
    quiet: 'Nothing strong enough for aurora outside the far north.',
  },

  household: {
    label: 'your home',
    drivers: [{ scale: 'G', from: at(5) }],
    actions: [
      {
        when: ['watch', 'imminent', 'during'],
        say:
          'NOAA says some power grids can see voltage problems at G5. That has actually happened once, in ' +
          'Quebec in 1989, and the G5 in May 2024 passed over North America with the lights on, so this is not a ' +
          'prediction about your street. Charging phones and finding a torch costs you nothing though.',
        sources: [SRC.noaa, SRC.nercMay2024],
      },
      {
        when: ['during'],
        say: 'If you are on satellite internet, expect it to be slower for a while. Starlink reported degraded service during the May 2024 storm.',
        sources: [SRC.starlinkMay2024],
      },
    ],
    quiet: "Nothing in NOAA's forecast should affect your home. Storms like this do not damage phones, cars or anything in the house.",
  },

  /*
   * A small plane flying a GPS approach depends on WAAS for the vertical guidance, and WAAS switches that off
   * when the ionosphere is too disturbed to trust. In May 2024 it did, across the lower 48 and Alaska from
   * about 19:00 UTC on the 10th to 10:30 UTC on the 11th, while the lateral only LNAV service carried on.
   */
  general_aviation: {
    label: 'flying a small plane',
    drivers: [{ scale: 'G', from: at(4) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Plan the flight as if LPV approaches are not there. In May 2024 WAAS lost LPV and LP across the lower 48 and Alaska for about fifteen hours while LNAV kept working, so pick a destination and an alternate you can reach on LNAV minimums or an ILS.',
        sources: [SRC.waasMay2024],
      },
      {
        when: ['watch', 'imminent', 'during'],
        say: 'Check the WAAS NOTAMs before you go. When the ionosphere is too disturbed WAAS suspends vertical guidance, and LPV and LNAV slash VNAV approaches will not load.',
        sources: [SRC.satNavNews],
      },
      {
        when: ['during'],
        say: 'If the box will only give you LNAV, fly the LNAV minimums, and expect to need better weather at the airport than you planned for.',
        sources: [SRC.satNavNews, SRC.waasMay2024],
      },
    ],
    quiet: 'Nothing in the forecast should take WAAS vertical guidance away. NOTAMs still have the last word for your airport.',
  },

  /*
   * A magnetic survey measures the Earth's field, so a storm is not a fault in the kit, it is noise in the thing
   * being measured. Contracts set a tolerance on the base station record and lines flown outside it are flown
   * again. Storm variations cannot be corrected out the way the ordinary daily swing can.
   */
  magnetic_survey: {
    label: 'magnetic survey',
    drivers: [{ scale: 'G', from: at(1) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Plan the flying days around the storm. Survey specifications commonly call conditions unfit when the field changes by 5 nanotesla in 5 minutes or 10 in 10, and lines flown outside the tolerance get flown again.',
        sources: [SRC.bomSurvey, SRC.usgsReflights],
      },
      {
        when: ['during'],
        say: 'Surveys are generally stopped during storms of any size, because storm variations cannot be corrected out like the daily swing. Keep the base station running and check its record against your contract before the next line.',
        sources: [SRC.bomSurvey],
      },
    ],
    quiet: "No geomagnetic storm is in NOAA's forecast. Check the base station for the ordinary daily swing as usual.",
  },

  /*
   * Wire free mowers, yard and delivery robots steer by the same centimetre RTK fix that farms lost in May 2024,
   * so the farm evidence carries over: permanent receivers held about 2 cm through Kp 5 and 6 and lost precise
   * positioning at Kp 8 and 9 (evals/receivers.mjs). Nobody has published a robot losing its way in a storm, and
   * the note says so.
   */
  robots: {
    label: 'robots',
    drivers: [{ scale: 'G', from: at(3) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Robots that steer by RTK, like wire free mowers and yard robots, use the same centimetre fix that dropped out on farm tractors in May 2024. Hold off unattended runs over the storm nights, and know whether yours stops or carries on when the fix goes.',
        sources: [SRC.noaa, SRC.danishRtk],
      },
      {
        when: ['during'],
        say: 'If a robot stops with a lost fix, leave it parked until the storm passes rather than driving it home on a poor position.',
        sources: [SRC.danishRtk],
      },
      {
        when: ['watch', 'imminent', 'during'],
        needs: { scale: 'G', from: 5 },
        say: 'At G5 NOAA expects some grids to have voltage problems. A robot that needs the cloud or a remote operator should have a safe stop for when the link goes.',
        sources: [SRC.noaa],
      },
    ],
    quiet: "Nothing in NOAA's forecast should upset the satellite fix robots steer by.",
    note: {
      say: 'Nobody has published a robot losing its way in a storm. This is the farm evidence applied to the same receivers.',
      sources: [SRC.danishRtk],
    },
  },

  /*
   * A ship, not a vessel holding station: the bridge navigating by GNSS, with HF and satellite for its radio. The Coast
   * Guard's 2016 alert came from ships whose radar, gyro and ECDIS lost their GPS input and carried on safely on radar,
   * the magnetic compass and terrestrial fixes. NOAA puts intermittent satellite navigation problems at G3.
   */
  shipping: {
    label: 'navigating a ship',
    drivers: [
      { scale: 'G', from: at(3) },
      { scale: 'R', from: at(2) },
    ],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'Brief the watch that satellite position can be degraded for hours, and check now that radar, the compass and terrestrial fixes are working and that the crew is current on them.',
        sources: [SRC.noaa, SRC.uscgTrustVerify],
      },
      {
        when: ['during'],
        needs: { scale: 'G', from: 3 },
        say: 'Cross-check the GNSS position against radar and visual fixes. If they disagree, navigate on radar, the compass and terrestrial fixes, and record where, when and for how long, then report it to the Coast Guard Navigation Center.',
        sources: [SRC.uscgTrustVerify],
      },
      {
        when: ['during'],
        needs: { scale: 'R', from: 2 },
        say: 'HF on the sunlit side is fading or out with this flare, so keep another way to reach shore and other ships for anything that matters.',
        sources: [SRC.noaa],
      },
    ],
    quiet: "Nothing in NOAA's forecast should upset satellite navigation or HF at sea.",
  },

  /*
   * An undersea cable's repeaters are powered down a copper conductor at constant current, so the ground voltage a
   * storm induces along the route adds to or fights the power feed. In March 1989 TAT-8 saw Earth potential swings of
   * 700 V peak to peak across the Atlantic and its power feed, conservatively designed, rode through. Boteler and
   * others (2024) reproduce those numbers and find exposure depends on each route, and the Google study the data
   * centre role cites found margin for a once in a century storm, so this says to check headroom, not to expect a
   * failure.
   */
  subsea_cable: {
    label: 'an undersea cable',
    drivers: [{ scale: 'G', from: at(4) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: "Check each power feed's voltage headroom against the induced voltage modelled for its route. In March 1989 TAT-8 saw Earth potential swings of 700 volts across the Atlantic and rode through, and a Google study found cables have margin even for a once in a century storm, with the risk in the grids at the landing ends.",
        sources: [SRC.medford1989, SRC.boteler2024, SRC.cablesGoogle],
      },
      {
        when: ['during'],
        say: 'Watch power feed voltage and current at both landing stations, and treat fast swings as the storm rather than a cable fault before dispatching anyone.',
        sources: [SRC.medford1989, SRC.boteler2024],
      },
    ],
    quiet: "No storm in NOAA's forecast is strong enough to matter to a cable's power feed.",
  },

  /*
   * People who rely on what satellites send down: satellite TV, satellite weather imagery, a satellite data feed.
   * DLR names satellite communications and broadcasting, and meteorological forecasting, among the sectors space
   * weather reaches. The worked case is GOES-16, which stopped sending all data from 00:19 to about 02:00 UTC on
   * 13 May 2024, a day after the peak of the storm, so this speaks in the day after a strong storm too.
   */
  satellite_services: {
    label: 'relying on satellite services',
    drivers: [{ scale: 'G', from: at(3) }],
    actions: [
      {
        when: ['watch', 'imminent'],
        say: 'If you rely on satellite TV, satellite weather imagery or a satellite data feed, line up a fallback for a few hours.',
        sources: [SRC.dlrSectors],
      },
      {
        when: ['during', 'after'],
        say: 'Short outages can come during the storm and in the day after it: GOES-16 stopped sending all its data for nearly two hours on 13 May 2024, a day after the peak. Wait it out before calling it a fault on your side.',
        sources: [SRC.goes16May2024, SRC.dlrSectors],
      },
    ],
    quiet: "Nothing in NOAA's forecast should interrupt satellite services.",
  },
};

const HOUR = 3_600_000;

/** NOAA G level from a Kp value. G1 is Kp 5, G5 is Kp 9. */
export const gFromKp = (kp: number): number =>
  kp >= 9 ? 5 : kp >= 8 ? 4 : kp >= 7 ? 3 : kp >= 6 ? 2 : kp >= 5 ? 1 : 0;

/**
 * NOAA publishes day ahead probabilities for radio blackouts and radiation
 * storms. This decides when a probability is worth mentioning; the number
 * itself is always spoken, so the listener can weigh it for themselves.
 */
export const PREPARE_AT_PERCENT = 25;

export type Reading = {
  scale: Scale;
  from: number;
  phase: Phase;
  level: number;
  peak?: { kp: number; time: string };
  probability?: number;
  day?: string;
};

const RANK: Record<Phase, number> = { quiet: 0, after: 1, watch: 2, imminent: 3, during: 4 };
const key = (s: Scale) => s.toLowerCase() as keyof Levels;
const maxOf = (xs: (number | null)[]) => Math.max(0, ...xs.filter((x): x is number => x != null));
const startOf = (s: Slot) => new Date(s.time).getTime();

function readG(from: number, sky: Sky): Reading {
  const t = sky.now.getTime();
  // The three hour block containing now counts as now, observed or estimated.
  const current = sky.slots.filter((s) => startOf(s) <= t && t - startOf(s) < 3 * HOUR);
  const nowLevel = Math.max(sky.levels.g, ...current.map((s) => gFromKp(s.kp)));
  if (nowLevel >= from) return { scale: 'G', from, phase: 'during', level: nowLevel };

  const ahead = sky.slots.filter((s) => startOf(s) > t && startOf(s) - t <= 72 * HOUR && gFromKp(s.kp) >= from);
  if (ahead.length) {
    const peak = ahead.reduce((a, b) => (b.kp > a.kp ? b : a));
    const hoursToFirst = (startOf(ahead[0]) - t) / HOUR;
    return {
      scale: 'G',
      from,
      phase: hoursToFirst <= 24 ? 'imminent' : 'watch',
      level: gFromKp(peak.kp),
      peak: { kp: peak.kp, time: peak.time },
    };
  }

  const outlook = sky.days.find((d) => (d.g ?? 0) >= from);
  if (outlook) return { scale: 'G', from, phase: 'watch', level: outlook.g ?? from, day: outlook.date };

  const recent = sky.slots.filter(
    (s) => t - startOf(s) >= 3 * HOUR && t - startOf(s) <= 24 * HOUR && gFromKp(s.kp) >= from,
  );
  const lastDay = Math.max(sky.yesterday.g, ...recent.map((s) => gFromKp(s.kp)));
  if (lastDay >= from) return { scale: 'G', from, phase: 'after', level: lastDay };

  return { scale: 'G', from, phase: 'quiet', level: nowLevel };
}

function readOdds(scale: 'R' | 'S', from: number, sky: Sky): Reading {
  const nowLevel = sky.levels[key(scale)];
  if (nowLevel >= from) return { scale, from, phase: 'during', level: nowLevel };

  // Flares and proton events cannot be timed days ahead, only given odds, so
  // these never reach 'imminent'. NOAA's S probability is for S1 or worse, so
  // it only stands in for drivers that start at S1.
  const probability =
    scale === 'R'
      ? maxOf(sky.days.map((d) => (from >= 3 ? d.rMajorProb : d.rMinorProb)))
      : from <= 1
        ? maxOf(sky.days.map((d) => d.sProb))
        : 0;
  if (probability >= PREPARE_AT_PERCENT) return { scale, from, phase: 'watch', level: from, probability };

  const yesterday = sky.yesterday[key(scale)];
  if (yesterday >= from) return { scale, from, phase: 'after', level: yesterday };
  return { scale, from, phase: 'quiet', level: nowLevel };
}

/** The worst each scale is expected to reach across yesterday, now and the outlook. */
function expectedLevels(sky: Sky): Levels {
  const t = sky.now.getTime();
  const windowKp = sky.slots
    .filter((s) => startOf(s) - t > -3 * HOUR && startOf(s) - t <= 72 * HOUR)
    .map((s) => gFromKp(s.kp));
  return {
    g: Math.max(sky.levels.g, sky.yesterday.g, ...windowKp, ...sky.days.map((d) => d.g ?? 0)),
    r: Math.max(
      sky.levels.r,
      sky.yesterday.r,
      maxOf(sky.days.map((d) => d.rMajorProb)) >= PREPARE_AT_PERCENT ? 3 : 0,
      maxOf(sky.days.map((d) => d.rMinorProb)) >= PREPARE_AT_PERCENT ? 1 : 0,
    ),
    s: Math.max(sky.levels.s, sky.yesterday.s, maxOf(sky.days.map((d) => d.sProb)) >= PREPARE_AT_PERCENT ? 1 : 0),
  };
}

/** Operators run on UTC, so times are said in UTC rather than guessing a zone. */
const utc = (iso: string) =>
  `${new Date(iso).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', timeZone: 'UTC' })} UTC`;
const weekday = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const STORM: Record<Scale, string> = { G: 'A geomagnetic storm', S: 'A solar radiation storm', R: 'A radio blackout' };
const SCALE_ORDER: Record<Scale, number> = { G: 0, R: 1, S: 2 };

/**
 * When more than one scale is up at once, say all of them. The first version
 * named only whichever driver came first in the role, so an airline in a G5
 * storm with R3 blackouts heard only about the radiation storm.
 */
function runningNow(readings: Reading[]): string {
  const items = [...readings]
    .sort((a, b) => SCALE_ORDER[a.scale] - SCALE_ORDER[b.scale])
    .map((r) => `${STORM[r.scale].toLowerCase()} at ${r.scale}${r.level}`);
  const list = `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} are running now.`;
}

function situation(r: Reading, pb: Playbook): string {
  switch (r.phase) {
    case 'during':
      return `${STORM[r.scale]} is running now at ${r.scale}${r.level}.`;
    case 'imminent':
      return `NOAA forecasts G${r.level} within the day, Kp ${r.peak!.kp.toFixed(1)} around ${utc(r.peak!.time)}.`;
    case 'watch':
      if (r.peak) return `NOAA's three day forecast reaches G${r.level}, Kp ${r.peak.kp.toFixed(1)} around ${utc(r.peak.time)}.`;
      if (r.day) return `NOAA's outlook reaches G${r.level} on ${weekday(r.day)}.`;
      return r.scale === 'R'
        ? `NOAA gives a ${r.probability} percent chance of ${r.from >= 3 ? 'a strong radio blackout' : 'a radio blackout'} in the next three days.`
        : `NOAA gives a ${r.probability} percent chance of a solar radiation storm in the next three days.`;
    case 'after':
      return `It has eased, after ${r.scale}${r.level} in the last day.`;
    default:
      return pb.quiet;
  }
}

export type Advice = {
  role: Role;
  label: string;
  phase: Phase;
  reading: Reading;
  situation: string;
  /** Every applicable step, in order, each with its sources. */
  actions: { say: string; sources: Source[] }[];
  /** How many steps were read aloud this turn, never more than three. */
  spokenSteps: number;
  /** Pass back as `step` to hear the rest, or null when nothing is left. */
  nextStep: number | null;
  note: { say: string; sources: Source[] } | null;
  spoken: string;
};

/**
 * What this person should do, right now, given the sky.
 * `step` continues a longer list when the customer asks for the rest, because
 * certification caps what is read aloud and no one holds nine steps in their head.
 */
export function advise(role: Role, sky: Sky, geomagneticLat: number | null, step = 0, orbit?: Orbit): Advice {
  const pb = PLAYBOOKS[role];
  const readings = pb.drivers.map((d) =>
    d.scale === 'G' ? readG(d.from(geomagneticLat), sky) : readOdds(d.scale, d.from(geomagneticLat), sky),
  );
  const reading = readings.reduce((best, r) => (RANK[r.phase] > RANK[best.phase] ? r : best));
  const expected = expectedLevels(sky);

  const actions =
    reading.phase === 'quiet'
      ? []
      : pb.actions
          .filter((a) => a.when.includes(reading.phase as Exclude<Phase, 'quiet'>))
          .filter((a) => !a.needs || expected[key(a.needs.scale)] >= a.needs.from)
          // With an orbit named, only what applies there; with none, everything, each line saying which it is about.
          .filter((a) => !orbit || !a.orbit || a.orbit === orbit)
          .map((a) => ({ say: typeof a.say === 'function' ? a.say({ expected }) : a.say, sources: a.sources }));

  const from = Math.max(0, Math.floor(step));
  const now = actions.slice(from, from + 3);
  const left = actions.length - (from + now.length);
  const running = readings.filter((r) => r.phase === 'during');
  const opening = running.length > 1 ? runningNow(running) : situation(reading, pb);

  const spoken =
    from > 0 && now.length === 0
      ? 'That was everything I have for this.'
      : [
          from === 0 ? opening : '',
          ...now.map((a) => a.say),
          left > 0 ? `There ${left === 1 ? 'is 1 more step' : `are ${left} more steps`}, ask me for the rest.` : '',
        ]
          .filter(Boolean)
          .join(' ');

  return {
    role,
    label: pb.label,
    phase: reading.phase,
    reading,
    situation: opening,
    actions,
    spokenSteps: now.length,
    nextStep: left > 0 ? from + now.length : null,
    note: pb.note ?? null,
    spoken,
  };
}
