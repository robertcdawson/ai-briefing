// Generated from src/tuneSession.ts. Do not edit by hand.
/**
 * Tune-page session. "Loaded", "saving", and "dirty" are one phase, so a
 * finished save cannot claim a clean form that changed underneath it, and a
 * conflict reload cannot wipe its own notice.
 *
 * The browser copy is `docs/tune/session.js`. Regenerate it with
 * `npx tsx scripts/emit-tune-session.ts` when this file changes.
 */
export const TUNE_COPY = {
    loading: "Loading…",
    loaded: "Loaded from main.",
    saved: "Saved. The next morning's episode will use this.",
    savedDiverged: "Saved. Edits made while saving are not in that version yet.",
    conflictLoading: "The file changed. Loading the saved version.",
    conflictLoaded: "The file changed on main. Showing the saved version.",
    replacedTyping: "Loaded from main. Typing during that load was replaced.",
    stillSaving: "Save is still finishing.",
    stillLoading: "The show is still loading.",
    needLoad: "Load the show before saving.",
    forgot: "Token removed from this browser.",
};
function quiet() {
    return { text: "", tone: "" };
}
function notice(text, tone) {
    return { text, tone };
}
export function initialTuneSession() {
    return {
        phase: { phase: "idle" },
        connect: quiet(),
        save: quiet(),
    };
}
export function tuneView(session) {
    const phase = session.phase;
    switch (phase.phase) {
        case "idle":
            return { showEditor: false, loadEnabled: true, saveEnabled: false, warnOnLeave: false, sha: "" };
        case "loading":
            return {
                showEditor: phase.showEditor,
                loadEnabled: false,
                saveEnabled: false,
                warnOnLeave: phase.dirty,
                sha: phase.sha,
            };
        case "ready":
            return {
                showEditor: true,
                loadEnabled: true,
                saveEnabled: true,
                warnOnLeave: phase.dirty,
                sha: phase.sha,
            };
        case "saving":
            return {
                showEditor: true,
                loadEnabled: false,
                saveEnabled: false,
                warnOnLeave: true,
                sha: phase.sha,
            };
    }
}
function transition(session, accepted) {
    return { session, accepted };
}
export function reduceTuneSession(session, event) {
    const phase = session.phase;
    switch (event.type) {
        case "load":
            if (phase.phase === "saving") {
                return transition({ ...session, connect: notice(TUNE_COPY.stillSaving, "") }, false);
            }
            if (phase.phase === "loading")
                return transition(session, false);
            if (phase.phase === "ready") {
                return transition({
                    phase: {
                        phase: "loading",
                        sha: phase.sha,
                        dirty: phase.dirty,
                        showEditor: true,
                        preserveSaveNotice: false,
                        editedDuringLoad: false,
                    },
                    connect: notice(TUNE_COPY.loading, ""),
                    save: session.save,
                }, true);
            }
            return transition({
                phase: {
                    phase: "loading",
                    sha: "",
                    dirty: false,
                    showEditor: false,
                    preserveSaveNotice: false,
                    editedDuringLoad: false,
                },
                connect: notice(TUNE_COPY.loading, ""),
                save: session.save,
            }, true);
        case "load_ok": {
            if (phase.phase !== "loading")
                return transition(session, false);
            const sha = event.sha.trim();
            if (!sha) {
                return reduceTuneSession(session, {
                    type: "load_err",
                    message: "GitHub returned the file without content.",
                });
            }
            const save = phase.preserveSaveNotice
                ? notice(TUNE_COPY.conflictLoaded, "error")
                : phase.editedDuringLoad
                    ? notice(TUNE_COPY.replacedTyping, "")
                    : quiet();
            const connect = phase.preserveSaveNotice
                ? notice(TUNE_COPY.loaded, "ok")
                : phase.editedDuringLoad
                    ? notice(TUNE_COPY.replacedTyping, "")
                    : notice(TUNE_COPY.loaded, "ok");
            return transition({
                phase: { phase: "ready", sha, dirty: false },
                connect,
                save,
            }, true);
        }
        case "load_err": {
            if (phase.phase !== "loading")
                return transition(session, false);
            const connect = notice(event.message, "error");
            const save = phase.preserveSaveNotice ? notice(event.message, "error") : session.save;
            if (!phase.showEditor) {
                return transition({ phase: { phase: "idle" }, connect, save }, true);
            }
            return transition({
                phase: { phase: "ready", sha: phase.sha, dirty: phase.dirty },
                connect,
                save,
            }, true);
        }
        case "edit":
            if (phase.phase === "ready") {
                const save = session.save.tone === "ok" ? quiet() : session.save;
                return transition({ ...session, phase: { phase: "ready", sha: phase.sha, dirty: true }, save }, true);
            }
            if (phase.phase === "saving") {
                return transition({
                    ...session,
                    phase: { phase: "saving", sha: phase.sha, dirty: true, diverged: true },
                }, true);
            }
            if (phase.phase === "loading") {
                return transition({
                    ...session,
                    phase: { ...phase, dirty: true, editedDuringLoad: true },
                }, true);
            }
            return transition(session, false);
        case "save":
            if (phase.phase === "saving")
                return transition(session, false);
            if (phase.phase === "loading") {
                if (phase.preserveSaveNotice)
                    return transition(session, false);
                return transition({ ...session, connect: notice(TUNE_COPY.stillLoading, "") }, false);
            }
            if (phase.phase === "idle") {
                return transition({ ...session, save: notice(TUNE_COPY.needLoad, "error") }, false);
            }
            if (event.missing.length > 0) {
                return transition({
                    ...session,
                    save: notice(`Still needed: ${event.missing.join(", ")}.`, "error"),
                }, false);
            }
            return transition({
                phase: { phase: "saving", sha: phase.sha, dirty: phase.dirty, diverged: false },
                connect: session.connect,
                save: notice("Saving…", ""),
            }, true);
        case "save_ok": {
            if (phase.phase !== "saving")
                return transition(session, false);
            const sha = event.sha.trim() || phase.sha;
            const connect = session.connect.text === TUNE_COPY.stillSaving
                ? notice(TUNE_COPY.loaded, "ok")
                : session.connect;
            if (phase.diverged) {
                return transition({
                    phase: { phase: "ready", sha, dirty: true },
                    connect,
                    save: notice(TUNE_COPY.savedDiverged, ""),
                }, true);
            }
            return transition({
                phase: { phase: "ready", sha, dirty: false },
                connect,
                save: notice(TUNE_COPY.saved, "ok"),
            }, true);
        }
        case "save_conflict":
            if (phase.phase !== "saving")
                return transition(session, false);
            return transition({
                phase: {
                    phase: "loading",
                    sha: phase.sha,
                    dirty: true,
                    showEditor: true,
                    preserveSaveNotice: true,
                    editedDuringLoad: false,
                },
                connect: notice(TUNE_COPY.loading, ""),
                save: notice(TUNE_COPY.conflictLoading, "error"),
            }, true);
        case "save_err":
            if (phase.phase !== "saving")
                return transition(session, false);
            return transition({
                phase: { phase: "ready", sha: phase.sha, dirty: phase.dirty || phase.diverged },
                connect: session.connect.text === TUNE_COPY.stillSaving
                    ? notice(TUNE_COPY.loaded, "ok")
                    : session.connect,
                save: notice(event.message, "error"),
            }, true);
        case "forget":
            return transition({ ...session, connect: notice(TUNE_COPY.forgot, "ok") }, true);
    }
}
