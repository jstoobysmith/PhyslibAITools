// Live state for the mission workbench: the agent runs in flight, and the
// mission documents they are writing to.
//
// This deliberately lives *outside* React, as a small external store read
// through `useSyncExternalStore`. Runs take minutes to hours, and the user is
// expected to switch mission, switch to the Tasks tab, and come back; if run
// state lived in a component it would die with the first unmount. The only
// thing that ends a run is the process ending or the user stopping it.
//
// Two invariants this file exists to hold:
//
//  1. **One writer per mission at a time.** Several runs can finish at once,
//     and each finish is a read-modify-write of `mission.json` plus a Lean
//     verification over shared scratch files. Both go through `withMission`,
//     a per-mission promise chain, so concurrent finishes queue instead of
//     racing - the second one re-reads the document the first just wrote
//     rather than clobbering it.
//  2. **Listeners are attached before the process starts.** A fast run could
//     otherwise emit `finished` into a void, and the UI would show it running
//     forever.

import { useCallback, useSyncExternalStore } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { describeEvent } from "../tasks/describeEvent";
import {
  applyChecks,
  applyWork,
  cancelMissionAgent,
  generateGraph,
  listMissionRuns,
  loadMission,
  materializeLean,
  mergeGraph,
  newRunId,
  runExtendAgent,
  runProveAgent,
  saveMission,
  toSourceInput,
  unitsFor,
  verifyLean,
  withLog,
  workspaceLeanEnv,
} from "./missionStore";
import type {
  AgentGraph,
  AgentWork,
  FeedLine,
  Mission,
  MissionAgentFinished,
  LeanEnv,
  MissionRun,
  RunKind,
  VerifyProgress,
} from "./missionTypes";

// --- store ---------------------------------------------------------------

let runs: MissionRun[] = [];
const missions = new Map<string, Mission>();
/** Per-mission Lean progress, so two missions verifying at once each get
 *  their own bar. */
let verifying: Record<string, { done: number; total: number; module: string }> = {};
/** The workspace's current verification environment, refreshed whenever it
 *  could have moved. Checks recorded under a different one are stale. */
let leanEnv: LeanEnv | null = null;

const subscribers = new Set<() => void>();
const unlisteners = new Map<string, UnlistenFn[]>();

function emit() {
  // `useSyncExternalStore` demands a stable snapshot between notifications, so
  // per-mission slices are memoized here and invalidated exactly when `runs`
  // changes. Caching inside the hook instead would mean two components
  // watching different missions invalidating each other on every render.
  runsByMission.clear();
  for (const fn of subscribers) fn();
}

const runsByMission = new Map<string, MissionRun[]>();

function runsFor(missionId: string): MissionRun[] {
  let slice = runsByMission.get(missionId);
  if (!slice) {
    slice = runs.filter((r) => r.missionId === missionId);
    runsByMission.set(missionId, slice);
  }
  return slice;
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function patchRun(id: string, patch: Partial<MissionRun> | ((run: MissionRun) => Partial<MissionRun>)) {
  runs = runs.map((r) => (r.id === id ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r));
  emit();
}

// --- per-mission serialization ------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` with exclusive access to one mission, queued behind anything else
 * already touching it. `fn` is handed the document read fresh from disk at the
 * moment it acquires the lock, never a copy captured earlier.
 */
function withMission<T>(missionId: string, fn: (mission: Mission) => Promise<T>): Promise<T> {
  const previous = locks.get(missionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const mission = await loadMission(missionId);
      return fn(mission);
    });
  locks.set(
    missionId,
    next.catch(() => undefined),
  );
  return next;
}

/** Publishes a mission document to every component watching it. */
function publish(mission: Mission) {
  missions.set(mission.id, mission);
  emit();
}

async function persist(mission: Mission): Promise<Mission> {
  await saveMission(mission);
  publish(mission);
  return mission;
}

// --- hooks ---------------------------------------------------------------

/** Every run, or just one mission's. `runs` is replaced rather than mutated on
 *  every change, so the unfiltered case is already a stable snapshot. */
export function useRuns(missionId?: string): MissionRun[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => (missionId ? runsFor(missionId) : runs), [missionId]),
  );
}

export function useMission(missionId: string, fallback: Mission): Mission {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => missions.get(missionId) ?? fallback, [missionId, fallback]),
  );
}

export function useLeanEnv(): LeanEnv | null {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => leanEnv, []),
  );
}

/** Re-reads the workspace's environment. Called on opening a mission and after
 *  anything that could have moved the checkout. */
export async function refreshLeanEnv(workspaceDir: string | null) {
  if (!workspaceDir) return;
  const next = await workspaceLeanEnv(workspaceDir).catch(() => null);
  if (!next) return;
  // Compared before publishing so an unchanged environment doesn't churn every
  // subscriber on every poll.
  const same =
    leanEnv &&
    leanEnv.physlibRev === next.physlibRev &&
    leanEnv.mathlibRev === next.mathlibRev &&
    leanEnv.toolchain === next.toolchain &&
    leanEnv.physlibBranch === next.physlibBranch;
  if (same) return;
  leanEnv = next;
  emit();
}

export function useVerifying(missionId: string) {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => verifying[missionId], [missionId]),
  );
}

/** Seeds the cache when a mission is opened, so the first render has it. */
export function primeMission(mission: Mission) {
  if (!missions.has(mission.id)) missions.set(mission.id, mission);
}

/** Applies a local edit (a node change, a settings change) under the same lock
 *  agent results use, so a user edit can't be lost to a run finishing. */
export function editMission(missionId: string, edit: (mission: Mission) => Mission): Promise<Mission> {
  return withMission(missionId, (mission) => persist(edit(mission)));
}

// --- starting runs -------------------------------------------------------

export interface StartRunOptions {
  mission: Mission;
  kind: RunKind;
  workspaceDir: string;
  claudeOauthToken: string | null;
  /** Node names to work on. Empty means "the agent chooses". */
  targets?: string[];
}

/**
 * Whether a run can start right now, given what's already in flight.
 *
 * Runs are only serialized where they would actually collide on disk, not as a
 * blanket rule:
 *
 *  - `generate` and `extend` both rewrite the mission's statements, so only one
 *    of them may touch a mission at a time.
 *  - `prove` runs write one `Solutions/Sol_<node>.lean` per target, so any
 *    number can run together as long as no two are aimed at the same node.
 *  - Different missions never collide - separate scratch trees, separate
 *    records - so they are always free to run together.
 */
export function canStart(missionId: string, kind: RunKind, targets: string[] = []): { ok: boolean; reason?: string } {
  const live = runs.filter((r) => r.missionId === missionId && r.status === "running");

  if (kind === "generate" || kind === "extend") {
    const blocker = live.find((r) => r.kind === "generate" || r.kind === "extend");
    if (blocker) {
      return {
        ok: false,
        reason: `A ${blocker.kind} run is already rewriting this graph. Stop it first, or wait for it to finish.`,
      };
    }
    return { ok: true };
  }

  const claimed = new Set(live.flatMap((r) => (r.kind === "prove" ? r.targets : [])));
  // A run with no explicit targets picks its own from the frontier, so a
  // second one could pick the same nodes; only one open-ended prove run.
  if (targets.length === 0) {
    const openEnded = live.find((r) => r.kind === "prove" && r.targets.length === 0);
    if (openEnded) {
      return { ok: false, reason: "Another run is already working through the frontier on its own." };
    }
    return { ok: true };
  }
  const clash = targets.filter((t) => claimed.has(t));
  if (clash.length) {
    return { ok: false, reason: `Already being worked on by another run: ${clash.join(", ")}.` };
  }
  return { ok: true };
}

export async function startRun(options: StartRunOptions): Promise<string> {
  const { mission, kind, workspaceDir, claudeOauthToken } = options;
  const targets = options.targets ?? [];

  const allowed = canStart(mission.id, kind, targets);
  if (!allowed.ok) throw new Error(allowed.reason);

  const runId = newRunId();
  const run: MissionRun = {
    id: runId,
    missionId: mission.id,
    missionTitle: mission.title,
    kind,
    targets,
    model: mission.model,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    feed: [],
    error: null,
    summary: null,
  };
  runs = [...runs, run];
  emit();

  // Attached before the process exists: a short run could otherwise finish
  // before we were listening and appear to hang forever.
  await attachListeners(runId, kind, mission.id, workspaceDir);

  try {
    if (kind === "generate") {
      await generateGraph({
        runId,
        workspaceDir,
        missionId: mission.id,
        title: mission.title,
        problem: mission.problem,
        sources: mission.sources.map(toSourceInput),
        knownStatus: mission.knownStatus,
        model: mission.model,
        claudeOauthToken,
      });
    } else {
      // The agent reads and edits the same files the app checks, so the
      // scratch tree is brought up to date with the current graph first.
      await materializeLean(workspaceDir, mission.id, unitsFor(mission));
      const req = {
        runId,
        workspaceDir,
        missionId: mission.id,
        mission,
        targets,
        model: mission.model,
        claudeOauthToken,
      };
      if (kind === "prove") await runProveAgent(req);
      else await runExtendAgent(req);
    }
  } catch (e) {
    finishRun(runId, { status: "failed", error: String(e) });
    throw e;
  }
  return runId;
}

async function attachListeners(runId: string, kind: RunKind, missionId: string, workspaceDir: string) {
  const prefix = `mission-run:${runId}`;
  const handles = await Promise.all([
    listen<unknown>(`${prefix}:event`, (e) => {
      const item = describeEvent(e.payload);
      if (item) appendFeed(runId, item);
    }),
    listen<string>(`${prefix}:stderr`, (e) => {
      if (e.payload.trim()) appendFeed(runId, { id: `err-${Date.now()}`, icon: "⚠", text: e.payload, tone: "danger" });
    }),
    listen<MissionAgentFinished>(`${prefix}:finished`, async (e) => {
      await handleFinished(runId, kind, missionId, workspaceDir, e.payload);
    }),
  ]);
  unlisteners.set(runId, handles);
}

function appendFeed(runId: string, line: FeedLine) {
  // Bounded: a long agent run can emit thousands of events, and the feed is
  // held for every run at once.
  patchRun(runId, (run) => ({ feed: [...run.feed, line].slice(-400) }));
}

function finishRun(runId: string, patch: Partial<MissionRun>) {
  patchRun(runId, { ...patch, endedAt: new Date().toISOString() });
  unlisteners.get(runId)?.forEach((fn) => fn());
  unlisteners.delete(runId);
}

async function handleFinished(
  runId: string,
  kind: RunKind,
  missionId: string,
  workspaceDir: string,
  payload: MissionAgentFinished,
) {
  // A stopped run still arrives here, because stopping kills the process and
  // the backend then reads its result file like any other exit. Its status is
  // preserved - it was stopped, not completed - but whatever partial work it
  // had written is still merged. See `stopRun`.
  const wasStopped = runs.find((r) => r.id === runId)?.status === "stopped";
  const endStatus = wasStopped ? ("stopped" as const) : ("finished" as const);

  if (payload.error) {
    finishRun(runId, wasStopped ? { status: "stopped", error: payload.error } : { status: "failed", error: payload.error });
    return;
  }
  if (!payload.result) {
    finishRun(runId, {
      status: endStatus,
      summary: wasStopped ? "Stopped before it had written anything." : "The agent finished without producing a result.",
    });
    return;
  }

  try {
    const summary = (payload.result as AgentGraph & AgentWork).summary ?? "The agent finished.";
    // Under the lock: re-read, merge, save. A second run finishing at the same
    // moment queues behind this and merges onto the result, rather than onto
    // the stale copy it started from.
    const merged = await withMission(missionId, async (current) => {
      const next =
        kind === "generate"
          ? mergeGraph(current, payload.result as AgentGraph, "generate")
          : applyWork(current, payload.result as AgentWork, kind);
      return persist(withLog(next, kind, summary));
    });
    finishRun(runId, { status: endStatus, summary: wasStopped ? `Stopped. Kept what it had finished: ${summary}` : summary });
    // Straight into Lean - an agent's own compile is a good sign, not a
    // verdict this app is willing to display as one.
    await verifyMission(missionId, workspaceDir, undefined, merged);
  } catch (e) {
    finishRun(runId, { status: "failed", error: String(e) });
  }
}

/**
 * Stops a run without throwing its work away.
 *
 * The agents are told to keep their result file valid and up to date as they
 * go, not to write it once at the end, so a killed run usually has real work
 * on disk. Killing the process makes the backend read that file and emit
 * `:finished` exactly as a natural exit would - so the listeners are left
 * attached here, and `handleFinished` merges whatever was salvaged.
 *
 * The timeout is the backstop for a process that dies without the backend
 * getting to emit anything; without it the run would sit in `stopped` with its
 * listeners never released.
 */
export async function stopRun(runId: string) {
  patchRun(runId, { status: "stopped", endedAt: new Date().toISOString(), summary: "Stopping — keeping whatever it finished…" });
  await cancelMissionAgent(runId).catch(() => undefined);
  setTimeout(() => {
    if (unlisteners.has(runId)) {
      finishRun(runId, { status: "stopped", summary: "Stopped. Nothing was recovered from it." });
    }
  }, 15_000);
}

/** Clears a finished/failed/stopped run out of the list. */
export function dismissRun(runId: string) {
  runs = runs.filter((r) => r.id !== runId);
  emit();
}

/**
 * Drops runs the backend has no process for. Covers the case where the app
 * reloaded (dev hot-reload, or a crash) and the store's idea of "running" no
 * longer matches reality - without this those runs would sit there live
 * forever with a Stop button that does nothing.
 */
export async function reconcileRuns() {
  const live = new Set(await listMissionRuns().catch(() => [] as string[]));
  const stale = runs.filter((r) => r.status === "running" && !live.has(r.id));
  for (const run of stale) {
    finishRun(run.id, { status: "stopped", summary: "This run is no longer attached to a process." });
  }
}

// --- verification --------------------------------------------------------

/**
 * Typechecks a mission (or just the given node/sketch ids) with Lean. Takes
 * the same per-mission lock as agent results, since it writes the shared
 * scratch tree - two verifications of one mission at once would fight over the
 * same `.lean` files.
 */
export async function verifyMission(
  missionId: string,
  workspaceDir: string,
  only?: Set<string>,
  known?: Mission,
): Promise<Mission | null> {
  return withMission(missionId, async (loaded) => {
    // `known` is the document the caller just wrote; preferring it avoids a
    // redundant round-trip, and it is the same one on disk either way.
    const mission = known?.id === missionId ? known : loaded;
    const units = unitsFor(mission, only);
    if (units.length === 0) return mission;

    verifying = { ...verifying, [missionId]: { done: 0, total: units.length, module: "" } };
    emit();
    try {
      const checks = await verifyLean({ workspaceDir, missionId, units });
      // The checks carry the environment they ran in; adopt it so staleness is
      // measured against what actually just happened.
      if (checks[0]) {
        leanEnv = checks[0].env;
      }
      const failed = checks.filter((c) => !c.ok).length;
      return await persist(
        withLog(
          applyChecks(mission, checks),
          "verify",
          `Checked ${checks.length} ${checks.length === 1 ? "file" : "files"} with Lean — ${checks.length - failed} passed, ${failed} failed.`,
        ),
      );
    } finally {
      const { [missionId]: _dropped, ...rest } = verifying;
      verifying = rest;
      emit();
    }
  });
}

// One global progress listener rather than one per component, attached the
// first time this module is used.
void listen<VerifyProgress>("mission-verify:progress", (e) => {
  const { missionId, index, total, module, phase } = e.payload;
  if (phase === "done" || !verifying[missionId]) return;
  verifying = { ...verifying, [missionId]: { done: index, total, module } };
  emit();
});
