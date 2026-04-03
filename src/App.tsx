import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type EventSimple,
  type Match,
  type TeamEventStatus,
  countMatchesAheadInQueue,
  effectiveStartUnix,
  fetchEvent,
  fetchEventMatches,
  fetchEventPredictionsSafe,
  fetchEventsForYear,
  fetchMatch,
  fetchTeamEventMatches,
  fetchTeamEventStatus,
  fetchTeamSimple,
  findMatchPrediction,
  findNextMatchFromList,
  firstYoutubeEmbedUrl,
  formatMatchTitle,
  matchIsUnplayed,
  myAllianceWinPercent,
  parseManualYoutubeInput,
  parseTeamNumber,
} from "./tba";

const LS_KEY = "tba_read_api_key";
const LS_WEBCAST = "pit_manual_youtube_embed";
const LS_TIMER_OFFSET = "pit_timer_offset_minutes";

function readTimerOffsetMinutes(): number {
  const v = parseInt(localStorage.getItem(LS_TIMER_OFFSET) ?? "0", 10);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-180, Math.min(180, v));
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

type BoardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "no-upcoming"; status: TeamEventStatus }
  | {
      kind: "match";
      match: Match;
      status: TeamEventStatus;
      names: Record<string, string>;
      winChancePercent: number | null;
      embedUrl: string | null;
      matchesAhead: number | null;
    }
  | { kind: "error"; message: string };

export function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_KEY) ?? "");
  const [year, setYear] = useState(2026);
  const [events, setEvents] = useState<EventSimple[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventQuery, setEventQuery] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<EventSimple | null>(null);
  const [teamInput, setTeamInput] = useState("");
  const [board, setBoard] = useState<BoardState>({ kind: "idle" });
  const [tick, setTick] = useState(0);
  const [setupOpen, setSetupOpen] = useState(true);
  const [manualWebcast, setManualWebcast] = useState(
    () => localStorage.getItem(LS_WEBCAST) ?? ""
  );
  const [timerOffsetMinutes, setTimerOffsetMinutes] = useState(readTimerOffsetMinutes);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!apiKey.trim()) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setEventsLoading(true);
    fetchEventsForYear(year, apiKey.trim())
      .then((list) => {
        if (!cancelled) setEvents(list);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, year]);

  const filteredEvents = useMemo(() => {
    const q = eventQuery.trim().toLowerCase();
    if (!q) return events.slice(0, 12);
    return events
      .filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.event_code.toLowerCase().includes(q) ||
          e.key.toLowerCase().includes(q)
      )
      .slice(0, 24);
  }, [events, eventQuery]);

  const resolveEmbedUrl = useCallback(async (): Promise<string | null> => {
    const key = apiKey.trim();
    if (!selectedEvent || !key) return null;
    const manual = parseManualYoutubeInput(manualWebcast);
    if (manual) return manual;
    try {
      const ev = await fetchEvent(selectedEvent.key, key);
      return firstYoutubeEmbedUrl(ev.webcasts ?? []);
    } catch {
      return null;
    }
  }, [apiKey, selectedEvent, manualWebcast]);

  const refreshBoard = useCallback(
    async (silent: boolean) => {
      const key = apiKey.trim();
      const teamNum = parseTeamNumber(teamInput);
      if (!key || !selectedEvent || teamNum === null) return;

      if (!silent) setBoard({ kind: "loading" });
      const teamKey = `frc${teamNum}`;

      try {
        const [status, predictions, embedUrl, eventMatches] = await Promise.all([
          fetchTeamEventStatus(teamNum, selectedEvent.key, key),
          fetchEventPredictionsSafe(selectedEvent.key, key),
          resolveEmbedUrl(),
          fetchEventMatches(selectedEvent.key, key).catch(() => [] as Match[]),
        ]);

        let match: Match | null = null;

        if (status.next_match_key) {
          const m = await fetchMatch(status.next_match_key, key);
          if (matchIsUnplayed(m)) match = m;
        }
        if (!match) {
          const matches = await fetchTeamEventMatches(teamNum, selectedEvent.key, key);
          match = findNextMatchFromList(matches, teamKey);
        }

        if (!match) {
          setBoard({ kind: "no-upcoming", status });
          return;
        }

        const keys = new Set<string>();
        for (const tk of match.alliances.red.team_keys) keys.add(tk);
        for (const tk of match.alliances.blue.team_keys) keys.add(tk);

        const entries = await Promise.all(
          [...keys].map(async (tk) => {
            try {
              const t = await fetchTeamSimple(tk, key);
              return [tk, t.nickname || t.name] as const;
            } catch {
              return [tk, tk.replace(/^frc/i, "")] as const;
            }
          })
        );
        const names = Object.fromEntries(entries);

        const onRed = match.alliances.red.team_keys.includes(teamKey);
        const pred = findMatchPrediction(predictions, match.key);
        let winChancePercent: number | null = null;
        if (pred) {
          winChancePercent = myAllianceWinPercent(pred, onRed);
        }

        const matchesAhead = countMatchesAheadInQueue(eventMatches, match);

        setBoard({
          kind: "match",
          match,
          status,
          names,
          winChancePercent,
          embedUrl,
          matchesAhead,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Request failed.";
        setBoard({ kind: "error", message });
      }
    },
    [apiKey, teamInput, selectedEvent, resolveEmbedUrl]
  );

  useEffect(() => {
    if (!apiKey.trim() || !selectedEvent || parseTeamNumber(teamInput) === null) {
      setBoard({ kind: "idle" });
      return;
    }
    refreshBoard(false);
    const id = window.setInterval(() => refreshBoard(true), 20000);
    return () => window.clearInterval(id);
  }, [apiKey, selectedEvent, teamInput, refreshBoard]);

  const saveKey = () => {
    localStorage.setItem(LS_KEY, apiKey.trim());
  };

  const saveWebcast = () => {
    localStorage.setItem(LS_WEBCAST, manualWebcast.trim());
  };

  const countdown = useMemo(() => {
    if (board.kind !== "match") return null;
    const start = effectiveStartUnix(board.match);
    if (!start) return { label: "—", sub: "No scheduled time yet", soon: false };
    const adjusted = start + timerOffsetMinutes * 60;
    const left = adjusted - Date.now() / 1000;
    const offsetHint =
      timerOffsetMinutes === 0
        ? ""
        : ` (${timerOffsetMinutes > 0 ? "+" : ""}${timerOffsetMinutes} min vs TBA)`;
    if (left <= 0) {
      return {
        label: "ON DECK",
        sub: `Match should begin soon${offsetHint}`,
        soon: true,
      };
    }
    return {
      label: formatCountdown(left),
      sub: `until scheduled start${offsetHint}`,
      soon: false,
    };
  }, [board, tick, timerOffsetMinutes]);

  const adjustTimerMinutes = (delta: number) => {
    setTimerOffsetMinutes((prev) => {
      const n = Math.max(-180, Math.min(180, prev + delta));
      localStorage.setItem(LS_TIMER_OFFSET, String(n));
      return n;
    });
  };

  const roster = useMemo(() => {
    if (board.kind !== "match") return null;
    const m = board.match;
    const teamNum = parseTeamNumber(teamInput);
    if (teamNum === null) return null;
    const tk = `frc${teamNum}`;
    const onRed = m.alliances.red.team_keys.includes(tk);
    const myAlliance = onRed ? m.alliances.red : m.alliances.blue;
    const theirAlliance = onRed ? m.alliances.blue : m.alliances.red;
    const allies = myAlliance.team_keys.filter((k) => k !== tk);
    return { allies, opponents: theirAlliance.team_keys, you: tk, onRed };
  }, [board, teamInput]);

  const rankLine = useMemo(() => {
    if (board.kind !== "match" && board.kind !== "no-upcoming") return null;
    const q = board.status.qual?.ranking;
    const n = board.status.qual?.num_teams;
    if (q?.rank == null) return null;
    const r = q.rank;
    const rec = q.record;
    const recStr =
      rec && typeof rec.wins === "number"
        ? `${rec.wins}-${rec.losses}-${rec.ties}`
        : null;
    return {
      rank: r,
      of: n,
      played: q.matches_played,
      record: recStr,
    };
  }, [board]);

  const configured = Boolean(
    apiKey.trim() && selectedEvent && parseTeamNumber(teamInput) !== null
  );

  return (
    <div className={`shell ${roster ? (roster.onRed ? "side-red" : "side-blue") : ""}`}>
      <header className="top-bar">
        <div className="top-bar-main">
          <span className="brand">GRT PIT UI</span>
          {selectedEvent && (
            <span className="top-event" title={selectedEvent.key}>
              {selectedEvent.name}
            </span>
          )}
          {parseTeamNumber(teamInput) !== null && (
            <span className="top-team">Team {parseTeamNumber(teamInput)}</span>
          )}
        </div>
        <div className="top-bar-actions">
          {board.kind === "match" && roster && (
            <div
              className={`alliance-pill ${roster.onRed ? "is-red" : "is-blue"}`}
              aria-live="polite"
            >
              <span className="alliance-pill-label">You</span>
              <span className="alliance-pill-value">{roster.onRed ? "RED" : "BLUE"}</span>
            </div>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => setSetupOpen(true)}
          >
            Setup
          </button>
        </div>
      </header>

      {setupOpen && (
        <div
          className="setup-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Connection and event setup"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSetupOpen(false);
          }}
        >
          <div className="setup-modal">
            <div className="setup-modal-head">
              <h2 className="setup-title">Setup</h2>
              <button
                type="button"
                className="btn-close"
                onClick={() => setSetupOpen(false)}
                aria-label="Close setup"
              >
                ×
              </button>
            </div>
            <div className="setup-grid">
              <div>
                <label className="field-label" htmlFor="api-key">
                  TBA read API key —{" "}
                  <a
                    href="https://www.thebluealliance.com/account"
                    target="_blank"
                    rel="noreferrer"
                  >
                    account
                  </a>
                </label>
                <input
                  id="api-key"
                  type="password"
                  autoComplete="off"
                  placeholder="X-TBA-Auth-Key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={saveKey}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="year">
                  Season year
                </label>
                <select
                  id="year"
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                >
                  {[2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="team">
                  Your team number
                </label>
                <input
                  id="team"
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 254"
                  value={teamInput}
                  onChange={(e) => setTeamInput(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="search">
                  Search competitions
                </label>
                <input
                  id="search"
                  type="text"
                  placeholder="Event name or code"
                  value={eventQuery}
                  onChange={(e) => setEventQuery(e.target.value)}
                  disabled={!apiKey.trim()}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="webcast">
                  YouTube override (optional)
                </label>
                <input
                  id="webcast"
                  type="text"
                  placeholder="Video ID or youtube.com/watch?v=…"
                  value={manualWebcast}
                  onChange={(e) => setManualWebcast(e.target.value)}
                  onBlur={saveWebcast}
                />
              </div>
              <div className="setup-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={
                    !apiKey.trim() || !selectedEvent || parseTeamNumber(teamInput) === null
                  }
                  onClick={() => {
                    refreshBoard(false);
                    setSetupOpen(false);
                  }}
                >
                  Save &amp; close
                </button>
              </div>
            </div>

            {apiKey.trim() && (
              <div className="setup-events-block">
                <span className="field-label">
                  {eventsLoading ? "Loading events…" : `Events (${events.length} in ${year})`}
                </span>
                <div className="event-hint" role="listbox" aria-label="Event results">
                  {filteredEvents.map((e) => (
                    <button
                      key={e.key}
                      type="button"
                      className={selectedEvent?.key === e.key ? "active" : ""}
                      onClick={() => setSelectedEvent(e)}
                    >
                      <strong>{e.name}</strong>
                      <span className="event-key">{e.key}</span>
                    </button>
                  ))}
                  {!eventsLoading && filteredEvents.length === 0 && (
                    <div className="event-empty">No matches — try another search.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="main-area">
        {board.kind === "error" && (
          <div className="error-box full-center" role="alert">
            {board.message}
          </div>
        )}

        {board.kind === "loading" && (
          <p className="idle-msg full-center">Loading from The Blue Alliance…</p>
        )}

        {board.kind === "idle" && (
          <p className="idle-msg full-center">
            Open <strong>Setup</strong> to add your API key, pick an event, and enter your team.
          </p>
        )}

        {board.kind === "no-upcoming" && (
          <div className="display-root">
            <div className="display-col video-col">
              {board.status.pit_location && (
                <p className="pit-strip">Pit: {board.status.pit_location}</p>
              )}
              <div className="video-placeholder">
                No upcoming match scheduled in TBA for this team.
              </div>
            </div>
            <div className="display-col info-col">
              {rankLine && (
                <p className="meta-line">
                  Rank {rankLine.rank}
                  {rankLine.of ? ` / ${rankLine.of}` : ""}
                  {rankLine.record ? ` · ${rankLine.record}` : ""}
                </p>
              )}
            </div>
          </div>
        )}

        {board.kind === "match" && roster && countdown && (
          <div className="display-root">
            <aside className="alliance-rail" aria-hidden="true">
              <span className="alliance-rail-text">{roster.onRed ? "RED" : "BLUE"}</span>
            </aside>

            <div className="display-col video-col">
              {board.embedUrl ? (
                <div className="video-frame">
                  <div className="video-16x9">
                    <iframe
                      title="Event webcast"
                      src={board.embedUrl}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      loading="lazy"
                    />
                  </div>
                </div>
              ) : (
                <div className="video-placeholder">
                  No YouTube webcast on this event in TBA. Paste a video URL in Setup → YouTube
                  override.
                </div>
              )}
            </div>

            <div className="display-col info-col">
              <div className="match-block">
                <p className="match-label">Next match</p>
                <p className="match-title">{formatMatchTitle(board.match)}</p>
              </div>

              <div className="timer-block">
                <div className="timer-main">
                  <div className={`timer-digits ${countdown.soon ? "soon" : ""}`}>
                    {countdown.label}
                  </div>
                  <p className="timer-sub">{countdown.sub}</p>
                </div>
                <div className="timer-trim" role="group" aria-label="Adjust countdown vs TBA time">
                  <span className="timer-trim-label">Trim</span>
                  <div className="timer-trim-btns">
                    <button
                      type="button"
                      className="btn-trim"
                      onClick={() => adjustTimerMinutes(-5)}
                      title="Subtract 5 minutes"
                    >
                      −5
                    </button>
                    <button
                      type="button"
                      className="btn-trim"
                      onClick={() => adjustTimerMinutes(-1)}
                      title="Subtract 1 minute"
                    >
                      −1
                    </button>
                    <button
                      type="button"
                      className="btn-trim"
                      onClick={() => adjustTimerMinutes(1)}
                      title="Add 1 minute"
                    >
                      +1
                    </button>
                    <button
                      type="button"
                      className="btn-trim"
                      onClick={() => adjustTimerMinutes(5)}
                      title="Add 5 minutes"
                    >
                      +5
                    </button>
                  </div>
                  <span className="timer-trim-value">
                    {timerOffsetMinutes === 0
                      ? "0 min"
                      : `${timerOffsetMinutes > 0 ? "+" : ""}${timerOffsetMinutes} min`}
                  </span>
                  {timerOffsetMinutes !== 0 && (
                    <button
                      type="button"
                      className="btn-trim-reset"
                      onClick={() => {
                        setTimerOffsetMinutes(0);
                        localStorage.setItem(LS_TIMER_OFFSET, "0");
                      }}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              <div className="stats-row">
                {board.matchesAhead !== null && (
                  <div className="stat-card stat-card-wide">
                    <span className="stat-label">Matches until yours</span>
                    <span className="stat-value">
                      {board.matchesAhead === 0
                        ? "Next on field"
                        : `${board.matchesAhead} ahead`}
                    </span>
                  </div>
                )}
                {board.winChancePercent !== null && (
                  <div className="stat-card">
                    <span className="stat-label">Win chance (TBA model)</span>
                    <span className="stat-value">
                      {board.winChancePercent.toFixed(1)}%
                    </span>
                  </div>
                )}
                {rankLine && (
                  <div className="stat-card">
                    <span className="stat-label">Qual rank</span>
                    <span className="stat-value">
                      {rankLine.rank}
                      {rankLine.of ? ` / ${rankLine.of}` : ""}
                    </span>
                  </div>
                )}
                {rankLine?.record && (
                  <div className="stat-card">
                    <span className="stat-label">Record</span>
                    <span className="stat-value">{rankLine.record}</span>
                  </div>
                )}
                {board.status.pit_location && (
                  <div className="stat-card pit">
                    <span className="stat-label">Pit</span>
                    <span className="stat-value pit-txt">{board.status.pit_location}</span>
                  </div>
                )}
              </div>

              <div className="rosters">
                <div
                  className={`roster roster-us ${
                    roster.onRed ? "alliance-red" : "alliance-blue"
                  }`}
                >
                  <h2>US</h2>
                  <ul>
                    <li className="you-row">
                      <span className="team-num">{roster.you.replace(/^frc/i, "")}</span>
                      <span className="team-nick">
                        {board.names[roster.you] ?? roster.you}
                        <span className="you-pill">You</span>
                      </span>
                    </li>
                    {roster.allies.map((k) => (
                      <li key={k}>
                        <span className="team-num">{k.replace(/^frc/i, "")}</span>
                        <span className="team-nick">{board.names[k] ?? k}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div
                  className={`roster roster-them ${
                    roster.onRed ? "alliance-blue" : "alliance-red"
                  }`}
                >
                  <h2>THEM</h2>
                  <ul>
                    {roster.opponents.map((k) => (
                      <li key={k}>
                        <span className="team-num">{k.replace(/^frc/i, "")}</span>
                        <span className="team-nick">{board.names[k] ?? k}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {configured && (
        <footer className="foot-note">
          TBA data · predicted start · win odds from /event predictions when available
        </footer>
      )}
    </div>
  );
}
