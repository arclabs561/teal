import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchMusicbrainz } from "./search/searchOrchestrator.ts";
import { reportResults } from "./report/reporting.ts";

const source = (path) => readFileSync(path, "utf8");

async function verifySearch() {
  const track = "Moonrise";
  const artist = "Evening Ensemble";
  const release = "Original Album";
  const credit = [{ name: artist, artist: { id: "artist", name: artist } }];
  const live = { id: "live", title: track, score: 100, "artist-credit": credit, releases: [{ title: "Live Album" }] };
  const studio = { id: "studio", title: track, score: 100, "artist-credit": credit, releases: [{ title: release }] };
  const queries = [];
  let fallback = 0;
  globalThis.fetch = async (input) => {
    const query = new URL(input).searchParams.get("query");
    queries.push(query);
    const recordings = query.includes("~") ? [live] : query.includes("artist:") ? [] : [studio];
    return Response.json({ recordings });
  };
  const [first] = await searchMusicbrainz({ track, artist, release }, { onFallback: () => fallback++ });
  assert.equal(first.id, "studio");
  assert.equal(queries.length, 4);
  assert.equal(fallback, 1);
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    controller.abort();
    return Response.json({ recordings: [] });
  };
  const results = await searchMusicbrainz({ track: "Cancel this", artist }, {
    signal: controller.signal,
    onFallback: () => assert.fail("Canceled search started fallback"),
  });
  assert.deepEqual(results, []);
  assert.equal(requests, 1);
  console.log("Search picked studio edition, reported fallback, and stopped after cancellation.");
}

async function verifyLogin() {
  const login = source("252/apps/amethyst/app/auth/login.tsx");
  const handler = login.match(/  const handleLogin = async \(\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(handler);
  const run = Function("deps", `
    const { getLoginUrl, openAuthSessionAsync, oauthCallback, router, useStore, setErr, setIsRedirecting, setIsLoading } = deps;
    const Platform = { OS: "ios" };
    const handle = "example.test";
    const isLoading = false;
    const isRedirecting = false;
    const debounceTimeoutRef = { current: null };
    const setIsResolvingPds = () => {};
    const setPdsResolutionError = () => {};
    ${handler.replace("catch (e: any)", "catch (e)")}
    return handleLogin();
  `);
  for (const outcome of ["success", "exchange fails", "provider declines", "browser canceled"]) {
    let status = "loggedOut";
    let loading;
    let redirecting;
    let error;
    let count = 0;
    let destination;
    await run({
      getLoginUrl: async () => new URL("https://provider.example/authorize"),
      openAuthSessionAsync: async () => outcome === "browser canceled"
        ? { type: "cancel" }
        : { type: "success", url: outcome === "provider declines"
          ? "teal://login?error=access_denied"
          : "teal://login?code=code&state=state&iss=https%3A%2F%2Fprovider.example" },
      oauthCallback: async (params) => {
        count++;
        assert.equal(params.get("iss"), "https://provider.example");
        if (outcome === "success") status = "loggedIn";
      },
      useStore: { getState: () => ({ status }) },
      router: { replace: (path) => { destination = path; } },
      setErr: (value) => { error = value; },
      setIsRedirecting: (value) => { redirecting = value; },
      setIsLoading: (value) => { loading = value; },
    });
    assert.equal(count, outcome === "success" || outcome === "exchange fails" ? 1 : 0);
    if (outcome === "success") assert.equal(destination, "/");
    else {
      assert.ok(error);
      assert.equal(loading, false);
      assert.equal(redirecting, false);
      assert.equal(destination, undefined);
    }
  }
  console.log("Native sign-in handler recovered from denial, cancellation, and exchange failure.");
}

function verifyUndo() {
  const onboarding = source("254/apps/amethyst/app/onboarding/index.tsx");
  const editor = source("254/apps/amethyst/components/actor/editProfileView.tsx");
  for (const kind of ["Avatar", "Banner"]) {
    const onboardingAction = onboarding.match(new RegExp(`onUndo${kind}=[\\s\\S]*?\\? \\(\\) => \\{([\\s\\S]*?)\\}`))?.[1];
    const editorAction = editor.match(new RegExp(`onPress=\\{\\(\\) => \\{(\\s*set${kind}\\(undefined\\);[\\s\\S]*?)\\}\\}\\s*>\\s*<Text>Undo`))?.[1];
    assert.ok(onboardingAction);
    assert.ok(editorAction);
    for (const [code, setImage, setError] of [
      [onboardingAction, `setSelected${kind}`, "setSubmissionError"],
      [editorAction, `set${kind}`, "setError"],
    ]) {
      let image = { uri: "file:///new.jpg" };
      let error = "Upload failed";
      Function(setImage, setError, code)((value) => { image = value; }, (value) => { error = value; });
      assert.equal(image, undefined);
      assert.equal(error, "");
      assert.equal(image?.uri ?? "https://example.test/saved.jpg", "https://example.test/saved.jpg");
    }
  }
  console.log("Undo handlers reset only the selected image and clear the upload error.");
}

function verifyReport() {
  const cwd = process.cwd();
  const output = mkdtempSync(join(tmpdir(), "teal-report-"));
  const cases = Array.from({ length: 100 }, (_, i) => ({
    track: `song ${i}`, artist: "Test", mbid: String(i),
    baselinePos: i < 50 ? 0 : 26, improvedPos: i < 50 ? 26 : 0,
    baselineFound: true, improvedFound: true, baselineNDCG: 1, improvedNDCG: 1,
    improvedCacheHit: true,
  }));
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    process.chdir(output);
    reportResults({
      cases, scrobblesTotal: 100, validScrobblesCount: 100,
      duplicateStats: { total: 100, duplicates: 0, unique: 100 },
      duplicateDistribution: {}, searchConfig: {}, apiMetrics: {},
      startTime: Date.now() - 1000, totalSearches: 0,
    });
  } finally {
    process.chdir(cwd);
    console.log = log;
  }
  const archive = join(output, "scripts", "eval", "results", "archive");
  const [date] = readdirSync(archive);
  const report = JSON.parse(readFileSync(join(archive, date, "lastfm-evaluation-results.json")));
  assert.equal(report.evaluated_queries, 100);
  assert.equal(report.recording_count, 100);
  for (const metric of ["p1", "p5", "p10", "p25"]) {
    const [low, high] = report.improvement_intervals_95_pp[metric];
    assert.ok(low < 0 && high > 0);
    assert.equal(report.metrics[`${metric}_improvement`], 0);
  }
  assert.ok(logs.some((line) => /^  Precision@10: 0.0 pp \[/.test(line)));
  assert.ok(logs.some((line) => /^  Precision@25: 0.0 pp \[/.test(line)));
  console.log("Evaluator prints and archives paired intervals at every cutoff.");
}

await verifySearch();
await verifyLogin();
verifyUndo();
verifyReport();
