const TBA_BASE = "https://www.thebluealliance.com/api/v3";

export type MatchAlliance = {
  score: number;
  team_keys: string[];
  surrogate_team_keys: string[];
  dq_team_keys: string[];
};

export type Match = {
  key: string;
  comp_level: string;
  set_number: number;
  match_number: number;
  alliances: { red: MatchAlliance; blue: MatchAlliance };
  event_key: string;
  time: number | null;
  predicted_time: number | null;
  actual_time: number | null;
  post_result_time: number | null;
};

export type WltRecord = {
  wins: number;
  losses: number;
  ties: number;
};

export type TeamEventStatus = {
  next_match_key: string | null;
  last_match_key: string | null;
  pit_location: string | null;
  qual?: {
    num_teams?: number;
    ranking?: {
      rank?: number | null;
      matches_played?: number;
      record?: WltRecord | null;
    } | null;
  } | null;
};

export type TeamSimple = {
  key: string;
  team_number: number;
  nickname: string;
  name: string;
  city: string | null;
  state_prov: string | null;
  country: string | null;
};

export type EventSimple = {
  key: string;
  name: string;
  event_code: string;
  event_type: number;
  year: number;
  start_date: string;
  end_date: string;
};

export type Webcast = {
  type: string;
  channel: string;
  date?: string | null;
  file?: string | null;
  status?: string | null;
  stream_title?: string | null;
};

export type EventDetail = EventSimple & {
  short_name?: string | null;
  webcasts?: Webcast[];
};

/** TBA event predictions — year-specific; we read match_predictions only. */
export type MatchPredictionRaw = {
  winning_alliance?: string;
  prob?: number;
  red?: Record<string, unknown>;
  blue?: Record<string, unknown>;
};

export type EventPredictionsRaw = {
  match_predictions?: {
    qual?: Record<string, MatchPredictionRaw>;
    playoff?: Record<string, MatchPredictionRaw>;
  } | null;
} | null;

function teamKeyFromNumber(num: number): string {
  return `frc${num}`;
}

export function parseTeamNumber(raw: string): number | null {
  const n = parseInt(raw.replace(/^\s*frc\s*/i, "").trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 99999) return null;
  return n;
}

export async function tbaFetch<T>(
  path: string,
  apiKey: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${TBA_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "X-TBA-Auth-Key": apiKey,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchEventsForYear(
  year: number,
  apiKey: string
): Promise<EventSimple[]> {
  return tbaFetch<EventSimple[]>(`/events/${year}/simple`, apiKey);
}

export async function fetchEvent(eventKey: string, apiKey: string): Promise<EventDetail> {
  return tbaFetch<EventDetail>(`/event/${encodeURIComponent(eventKey)}`, apiKey);
}

export async function fetchEventPredictions(
  eventKey: string,
  apiKey: string
): Promise<EventPredictionsRaw> {
  return tbaFetch<EventPredictionsRaw>(
    `/event/${encodeURIComponent(eventKey)}/predictions`,
    apiKey
  );
}

/** Predictions may be null or 404 early in the season — never block the board. */
export async function fetchEventPredictionsSafe(
  eventKey: string,
  apiKey: string
): Promise<EventPredictionsRaw> {
  try {
    return await fetchEventPredictions(eventKey, apiKey);
  } catch {
    return null;
  }
}

export async function fetchTeamEventStatus(
  teamNum: number,
  eventKey: string,
  apiKey: string
): Promise<TeamEventStatus> {
  const tk = teamKeyFromNumber(teamNum);
  return tbaFetch<TeamEventStatus>(
    `/team/${tk}/event/${eventKey}/status`,
    apiKey
  );
}

export async function fetchMatch(matchKey: string, apiKey: string): Promise<Match> {
  return tbaFetch<Match>(`/match/${encodeURIComponent(matchKey)}`, apiKey);
}

export async function fetchTeamSimple(
  teamKey: string,
  apiKey: string
): Promise<TeamSimple> {
  return tbaFetch<TeamSimple>(`/team/${encodeURIComponent(teamKey)}`, apiKey);
}

export async function fetchTeamEventMatches(
  teamNum: number,
  eventKey: string,
  apiKey: string
): Promise<Match[]> {
  const tk = teamKeyFromNumber(teamNum);
  return tbaFetch<Match[]>(
    `/team/${tk}/event/${eventKey}/matches`,
    apiKey
  );
}

export async function fetchEventMatches(
  eventKey: string,
  apiKey: string
): Promise<Match[]> {
  return tbaFetch<Match[]>(
    `/event/${encodeURIComponent(eventKey)}/matches`,
    apiKey
  );
}

export function matchIsUnplayed(m: Match): boolean {
  return m.alliances.red.score < 0 || m.alliances.blue.score < 0;
}

export function matchSortTime(m: Match): number {
  return m.predicted_time ?? m.time ?? 0;
}

/** Earliest unplayed match for the team with a scheduled time, by schedule order. */
export function findNextMatchFromList(matches: Match[], teamKey: string): Match | null {
  const ours = matches.filter((m) => {
    const onRed = m.alliances.red.team_keys.includes(teamKey);
    const onBlue = m.alliances.blue.team_keys.includes(teamKey);
    return onRed || onBlue;
  });
  const pending = ours.filter(
    (m) => matchIsUnplayed(m) && matchSortTime(m) > 0
  );
  pending.sort((a, b) => matchSortTime(a) - matchSortTime(b));
  return pending[0] ?? null;
}

const LEVEL_LABEL: Record<string, string> = {
  qm: "Qualification",
  ef: "Eighths",
  qf: "Quarterfinal",
  sf: "Semifinal",
  f: "Final",
};

export function formatMatchTitle(m: Match): string {
  const label = LEVEL_LABEL[m.comp_level] ?? m.comp_level.toUpperCase();
  if (m.comp_level === "qm") {
    return `${label} ${m.match_number}`;
  }
  return `${label} ${m.set_number}-${m.match_number}`;
}

export function effectiveStartUnix(m: Match): number | null {
  const t = m.predicted_time ?? m.time;
  return t && t > 0 ? t : null;
}

/**
 * How many unplayed matches at the same competition level are scheduled before this match
 * in official order (set number, then match number). 0 = your match is next on field.
 */
export function countMatchesAheadInQueue(
  eventMatches: Match[],
  ourMatch: Match
): number | null {
  if (eventMatches.length === 0) return null;
  const level = ourMatch.comp_level;
  const sameLevel = eventMatches.filter(
    (m) => m.comp_level === level && matchIsUnplayed(m)
  );
  sameLevel.sort((a, b) => {
    if (a.set_number !== b.set_number) return a.set_number - b.set_number;
    return a.match_number - b.match_number;
  });
  const idx = sameLevel.findIndex((m) => m.key === ourMatch.key);
  if (idx < 0) return null;
  return idx;
}

/** First YouTube embed URL from TBA webcasts (channel = video id or URL). */
export function firstYoutubeEmbedUrl(webcasts: Webcast[]): string | null {
  for (const w of webcasts) {
    if (w.type !== "youtube" || !w.channel?.trim()) continue;
    const url = parseYoutubeChannelToEmbed(w.channel.trim());
    if (url) return url;
  }
  return null;
}

export function parseYoutubeChannelToEmbed(channel: string): string | null {
  if (/^[a-zA-Z0-9_-]{11}$/.test(channel)) {
    return `https://www.youtube.com/embed/${channel}`;
  }
  const m = channel.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  return null;
}

export function parseManualYoutubeInput(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  return parseYoutubeChannelToEmbed(t);
}

export function findMatchPrediction(
  predictions: EventPredictionsRaw,
  matchKey: string
): MatchPredictionRaw | null {
  const mp = predictions?.match_predictions;
  if (!mp) return null;
  return mp.qual?.[matchKey] ?? mp.playoff?.[matchKey] ?? null;
}

/**
 * TBA reports a predicted winner and `prob` as that alliance's win probability.
 */
export function myAllianceWinPercent(
  pred: MatchPredictionRaw,
  onRed: boolean
): number | null {
  const wa = pred.winning_alliance?.toLowerCase();
  if (wa !== "red" && wa !== "blue") return null;
  const p = pred.prob;
  if (typeof p !== "number" || Number.isNaN(p)) return null;
  const clamped = Math.max(0, Math.min(1, p));
  const predictedRed = wa === "red";
  const weMatchPredicted = onRed === predictedRed;
  return (weMatchPredicted ? clamped : 1 - clamped) * 100;
}
