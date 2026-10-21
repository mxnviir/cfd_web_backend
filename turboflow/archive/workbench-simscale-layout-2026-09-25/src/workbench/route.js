// The URL is what is selected. Build spec 1.2.
//
// Not a state variable that the URL is kept in step with: the URL itself, read
// on every render and written by every navigation. That is the only way the
// three things the spec asks for come out right at once. Reloading restores
// the same panel because the panel was never stored anywhere else. Back goes
// to the previous node because the browser's own history is the history. And a
// link to a boundary condition opens that boundary condition.
//
//   /workbench/{groupId}
//   /workbench/{groupId}/geometry/{geometryId}
//   /workbench/{groupId}/geometry/{geometryId}/cad
//   /workbench/{groupId}/sim/{simulationId}
//   /workbench/{groupId}/sim/{simulationId}/{nodePath}
//   /workbench/{groupId}/sim/{simulationId}/run/{runId}/post
import { useCallback, useEffect, useState } from "react";

/** Turn a pathname into what the Workbench should be showing. */
export function parse(pathname = location.pathname) {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "workbench") return { groupId: null };
  const groupId = parts[1] || null;
  const what = parts[2];

  if (what === "geometry") {
    return {
      groupId,
      kind: "geometry",
      geometryId: parts[3] || null,
      cad: parts[4] === "cad",
    };
  }
  if (what === "sim") {
    const simulationId = parts[3] || null;
    const rest = parts.slice(4);
    // The post-processor is the only node that hangs off a run, and it is the
    // only one worth naming here: everything else is an opaque node path that
    // the tree and the panels agree on between themselves.
    if (rest[0] === "run" && rest[2] === "post") {
      return { groupId, kind: "sim", simulationId, node: "post", runId: rest[1] };
    }
    return {
      groupId, kind: "sim", simulationId,
      node: rest.length ? rest.join("/") : null,
      runId: rest[0] === "run" ? rest[1] : null,
    };
  }
  return { groupId, kind: null };
}

/** The inverse, so nothing has to build these strings by hand. */
export function href(r) {
  if (!r?.groupId) return "/dashboard";
  const base = `/workbench/${r.groupId}`;
  if (r.kind === "geometry" && r.geometryId) {
    return `${base}/geometry/${r.geometryId}${r.cad ? "/cad" : ""}`;
  }
  if (r.kind === "sim" && r.simulationId) {
    if (r.node === "post" && r.runId) return `${base}/sim/${r.simulationId}/run/${r.runId}/post`;
    return `${base}/sim/${r.simulationId}${r.node ? "/" + r.node : ""}`;
  }
  return base;
}

/**
 * The current route, and a way to change it.
 *
 * `go` pushes; `replace` swaps the current entry, which is what selecting a
 * default node on load should do so that Back leaves the Workbench rather than
 * stepping through nodes the user never chose.
 */
export function useRoute() {
  const [path, setPath] = useState(() => location.pathname);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((r) => {
    const next = typeof r === "string" ? r : href(r);
    if (next === location.pathname) return;
    history.pushState(null, "", next);
    setPath(next);
  }, []);

  const replace = useCallback((r) => {
    const next = typeof r === "string" ? r : href(r);
    if (next === location.pathname) return;
    history.replaceState(null, "", next);
    setPath(next);
  }, []);

  return [parse(path), go, replace];
}
