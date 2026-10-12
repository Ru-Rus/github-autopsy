"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Report } from "@/types";
import ReportView from "./ReportView";
export default function AnalyzerApp() {
  const [repository, setRepository] = useState(""),
    [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [copied, setCopied] = useState(false);
  const requestId = useRef(0),
    requestController = useRef<AbortController | null>(null);
  const analyze = useCallback(async (value: string, snapshot?: string) => {
    requestController.current?.abort();
    const controller = new AbortController(),
      id = ++requestId.current;
    requestController.current = controller;
    setError("");
    setLoading(true);
    setReport(null);
    setRepository(value);
    const timeoutId = window.setTimeout(
      () =>
        controller.abort(
          new DOMException(
            "Analysis took too long. Please try again.",
            "TimeoutError",
          ),
        ),
      60000,
    );
    try {
      const r = await fetch(snapshot ? "/api/analyze?snapshot=" + encodeURIComponent(snapshot) : "/api/analyze", {
        method: snapshot ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: snapshot ? undefined : JSON.stringify({ repository: value }),
        signal: controller.signal,
      });
      const b = await r.json();
      if (id !== requestId.current) return;
      if (!r.ok) throw Error(b.error ?? "Analysis failed.");
      setReport(b as Report);
      const u = new URL(location.href);
      u.searchParams.set("repo", b.repository.full_name);
      if (b.snapshotId) u.searchParams.set("snapshot", b.snapshotId);
      else u.searchParams.delete("snapshot");
      history.replaceState({}, "", u);
    } catch (e) {
      if (
        id === requestId.current &&
        !(e instanceof Error && e.name === "AbortError")
      )
        setError(e instanceof Error ? e.message : "Analysis failed.");
    } finally {
      window.clearTimeout(timeoutId);
      if (id === requestId.current) {
        requestController.current = null;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const value = params.get("repo"), snapshot = params.get("snapshot");
    if (snapshot) void analyze(value ?? "", snapshot);
    else if (value) void analyze(value);
    return () => {
      requestId.current++;
      requestController.current?.abort();
    };
  }, [analyze]);
  function submit(e: FormEvent) {
    e.preventDefault();
    void analyze(repository.trim());
  }
  async function share() {
    if (!report) return;
    const u = new URL(location.href);
    u.searchParams.set("repo", report.repository.full_name);
    if (report.snapshotId) u.searchParams.set("snapshot", report.snapshotId);
    else u.searchParams.delete("snapshot");
    try {
      await navigator.clipboard.writeText(u.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Clipboard access failed. Copy the browser URL instead.");
    }
  }
  function download() {
    if (!report) return;
    const a = document.createElement("a"),
      url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], {
          type: "application/json",
        }),
      );
    a.href = url;
    a.download =
      report.repository.full_name.replace("/", "-") + "-autopsy.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  function reset() {
    requestController.current?.abort();
    requestController.current = null;
    requestId.current++;
    setLoading(false);
    setReport(null);
    setRepository("");
    setError("");
    history.replaceState({}, "", "/");
  }
  return (
    <main className="shell">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            if (report) {
              e.preventDefault();
              reset();
            }
          }}
        >
          <span className="brand-mark">✳</span>
          <span>
            GITHUB <b>AUTOPSY</b>
          </span>
        </a>
        <div className="top-note">
          <i />
          Evidence-based repository review
        </div>
      </header>
      {!report ? (
        <section className="hero">
          <div className="eyebrow">
            <span>REPOSITORY INTELLIGENCE</span>
            <i />
          </div>
          <h1>
            Understand how
            <br />
            <em>software evolves.</em>
          </h1>
          <p className="hero-copy">
            A clear-eyed review of the engineering signals inside any public
            GitHub repository. Every score comes with evidence.
          </p>
          <form className="analyze-form" onSubmit={submit}>
            <label htmlFor="repo">PUBLIC GITHUB REPOSITORY</label>
            <div className="input-row">
              <span className="input-icon">↗</span>
              <input
                id="repo"
                value={repository}
                onChange={(e) => setRepository(e.target.value)}
                placeholder="https://github.com/owner/repository"
                autoComplete="url"
              />
              <button disabled={loading || !repository.trim()}>
                {loading ? (
                  <>
                    <i className="spinner" /> Reading
                  </>
                ) : (
                  <>
                    Analyze repository <b>→</b>
                  </>
                )}
              </button>
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="form-foot">
              <span>Public repositories only</span>
              <button
                type="button"
                onClick={() => void analyze("vercel/next.js")}
              >
                Try vercel/next.js ↗
              </button>
            </div>
          </form>
          <div className="signal-strip">
            {[
              ["01", "CODE", "Structure & maintainability"],
              ["02", "TESTING", "Infrastructure signals"],
              ["03", "ACTIVITY", "Change patterns"],
              ["04", "ISSUES", "Maintenance signals"],
              ["05", "DOCS", "Developer experience"],
            ].map((x) => (
              <div className="signal" key={x[0]}>
                <small>{x[0]}</small>
                <b>{x[1]}</b>
                <span>{x[2]}</span>
              </div>
            ))}
          </div>
          <footer className="landing-foot">
            <span>MEASURED SIGNALS. TRANSPARENT SCORES.</span>
            <span>NO CLAIMS OF OBJECTIVE CODE QUALITY.</span>
          </footer>
        </section>
      ) : (
        <ReportView
          report={report}
          onNew={reset}
          onShare={() => void share()}
          onDownload={download}
          copied={copied}
          error={error}
          onSnapshot={(id) => void analyze(repository, id)}
        />
      )}
    </main>
  );
}
