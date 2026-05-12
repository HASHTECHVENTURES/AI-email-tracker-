#!/usr/bin/env python3
"""One-shot edit: remove Historical Search from MyEmailPageClient.tsx."""
from pathlib import Path


def cut(t: str, start: str, end: str) -> str:
    i = t.index(start)
    j = t.index(end, i)
    return t[:i] + t[j:]


def main() -> None:
    path = Path("frontend/app/my-email/MyEmailPageClient.tsx")
    t = path.read_text()

    t = t.replace("  apiPostSse,\n", "")

    t = cut(t, "/** One Gmail message the historical fetch AI marked relevant", "function ConversationSubjectCell")

    t = cut(t, "function isoToLocalYmd(iso: string): string {", "type AiSkippedMailItem = {")

    t = cut(
        t,
        "/** Start/end of local calendar days as ISO strings for the historical missed API. */\nfunction localYmdRangeToIsoBounds(",
        "/** `datetime-local` value in the user's local timezone */",
    )

    start = "  /** Live + Historical inbox chrome (same surface as CEO) for all My Email roles. */"
    end = "  const loadAiSkippedMails = useCallback(async (opts?: { silent?: boolean }) => {"
    i = t.index(start)
    j = t.index(end, i)
    replacement = """  /** My Email inbox chrome for CEO, department managers, and employees. */
  const showFullInboxChrome =
    me?.role === 'CEO' || isDepartmentManagerRole(me?.role) || me?.role === 'EMPLOYEE';
  /** Manual "Run sync now" — CEO/HEAD (company crawl) or employee (their mailbox only via API). */
  const canRunMyMailboxSync =
    me?.role === 'CEO' || isDepartmentManagerRole(me?.role) || me?.role === 'EMPLOYEE';

  useEffect(() => {
    if (!showFullInboxChrome) return;
    const primary = ownMailboxes.find((m) => isMailboxGmailConnected(m)) ?? ownMailboxes[0];
    if (!primary) return;
    const key = `${primary.id}:${primary.tracking_start_at ?? ''}`;
    if (liveTrackSourceRef.current === key) return;
    liveTrackSourceRef.current = key;
    const { date, time } = isoToLiveTrackingDateTime(primary.tracking_start_at);
    setLiveTrackDate(date);
    setLiveTrackTime(time);
  }, [showFullInboxChrome, ownMailboxes]);

  useEffect(() => {
    if (!token || !showFullInboxChrome || myEmailTab !== 'ceo') return;
    let cancelled = false;
    void loadLiveIngestSchedule();
    const id = window.setInterval(() => {
      if (!cancelled) void loadLiveIngestSchedule();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [token, showFullInboxChrome, myEmailTab, loadLiveIngestSchedule]);

  useEffect(() => {
    setAiSkippedOffset(0);
  }, [aiSkippedMailboxId]);

"""
    t = t[:i] + replacement + t[j:]

    t = cut(t, "  const loadHistWindowSkippedMails = useCallback(async () => {", "  const clearAiSkipEntry = useCallback(")

    t = cut(
        t,
        "  const clearHistWindowSkipEntry = useCallback(",
        "  useEffect(() => {\n    if (!showFullInboxChrome || ceoInboxMode !== 'live' || mailTab !== 'skipped') return;\n    if (!token || !aiSkippedMailboxId) return;\n    void loadAiSkippedMails();",
    )

    t = t.replace(
        "if (!showFullInboxChrome || ceoInboxMode !== 'live' || mailTab !== 'skipped') return;",
        "if (!showFullInboxChrome || mailTab !== 'skipped') return;",
    )
    t = t.replace("if (!showFullInboxChrome || ceoInboxMode !== 'live') return;", "if (!showFullInboxChrome) return;")

    t = cut(
        t,
        "  useEffect(() => {\n    if (ceoInboxMode === 'historical' && mailTab === 'skipped') {\n      setMailTab('action');\n    }\n  }, [ceoInboxMode, mailTab]);\n\n  const applySavedHistoricalRun = useCallback(",
        "  const applySavedHistoricalRun = useCallback(",
    )

    start = "  const applySavedHistoricalRun = useCallback("
    end = "  /** Department managers only — matches HEAD user in org (not every IC). */"
    i = t.index(start)
    j = t.index(end, i)
    t = t[:i] + t[j:]

    t = cut(
        t,
        "  /** Main inbox: live feed vs past missed search (only when `myEmailTab === 'ceo'`). */\n  const [ceoInboxMode, setCeoInboxMode]",
        "  const [aiSkippedMailboxId, setAiSkippedMailboxId] = useState('');",
    )

    t = cut(
        t,
        "  useEffect(() => {\n    if (myEmailTab !== 'ceo') {\n      setCeoInboxMode('live');",
        "  useEffect(() => {\n    setFilterMailbox('');",
    )


    t = t.replace(", ceoInboxMode", "")

    start = "          {showHistoricalShell ? (\n            <section className=\"rounded-2xl border border-slate-200/60 bg-white p-4 shadow-card sm:p-5\">"
    end = "          ) : (\n            <>\n          {/* ── KPI strip"
    i = t.index(start)
    j = t.index(end, i)
    t = t[:i] + t[j + len("          ) : (\n            <>\n") :]

    old = """                  <div className=\"flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/60 bg-white p-3 shadow-card\">
                    <span className=\"mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500\">
                      {me?.role === 'CEO' ? 'CEO inbox' : 'Your inbox'}
                    </span>
                    <button
                      type=\"button\"
                      onClick={() => setCeoInboxMode('live')}
                      className={`rounded-full px-4 py-2 text-xs font-semibold shadow-sm transition-colors ${
                        ceoInboxMode === 'live'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200/90'
                      }`}
                    >
                      Live Mails
                    </button>
                    <button
                      type=\"button\"
                      onClick={() => {
                        setCeoInboxMode('historical');
                        if (!histEndDate || !histStartDate) {
                          const end = new Date();
                          const start = new Date();
                          start.setDate(start.getDate() - 30);
                          setHistEndDate(formatLocalYmd(end));
                          setHistStartDate(formatLocalYmd(start));
                        }
                      }}
                      className={`rounded-full px-4 py-2 text-xs font-semibold shadow-sm transition-colors ${
                        ceoInboxMode === 'historical'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200/90'
                      }`}
                    >
                      Historical Search
                    </button>
                  </div>
                  {ceoInboxMode === 'live' ? (
                    <CeoLiveSyncStrip"""
    new = """                  <div className=\"flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/60 bg-white p-3 shadow-card\">
                    <span className=\"mr-1 text-xs font-semibold uppercase tracking-wide text-slate-500\">
                      {me?.role === 'CEO' ? 'CEO inbox' : 'Your inbox'}
                    </span>
                  </div>
                  <CeoLiveSyncStrip"""
    if old not in t:
        raise SystemExit("CEO toggle strip not found")
    t = t.replace(old, new, 1)

    old2 = """                    />
                  ) : null}"""
    new2 = """                    />"""
    if old2 not in t:
        raise SystemExit("CEO sync strip closing not found")
    t = t.replace(old2, new2, 1)

    t = t.replace(
        "          ? 'Your inbox: live mail, follow-ups, and historical search — same My Email tools as leadership, scoped to your mailbox. Connect Gmail here, run sync when you need it, and track SLAs on your threads.'",
        "          ? 'Your inbox: live mail and follow-ups — same My Email tools as leadership, scoped to your mailbox. Connect Gmail here, run sync when you need it, and track SLAs on your threads.'",
    )

    t = t.replace("showFullInboxChrome && ceoInboxMode === 'live' && aiSkippedMailboxId", "showFullInboxChrome && aiSkippedMailboxId")
    t = t.replace("...(ceoInboxMode === 'live'\n                    ? ([", "...([")
    t = t.replace("                      ] as const)\n                    : []),", "                      ] as const),")
    t = t.replace("{mailTab === 'skipped' && ceoInboxMode === 'live' ?", "{mailTab === 'skipped' ?")

    t = t.replace(
        "    /** My Email: CEO full workspace; HEAD/EMPLOYEE — Historical Search (scoped mailboxes). */",
        "    /** My Email: CEO full workspace; HEAD/EMPLOYEE — scoped mailboxes and follow-ups. */",
    )

    path.write_text(t)
    print("OK:", path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
