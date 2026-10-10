// Session goals: when the Finish button unlocks. Pure.
//   time only   -> a hidden end time inside the range
//   edges only  -> after that many edges
//   both        -> whichever comes first, but time leads: edges alone only
//                  unlock once the session is close to the hidden time
//   neither     -> continual; Finish is always available

export const CLOSE_TO_TIME = 0.8;

function positive(n) {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? v : null;
}

export function createGoals({ minMinutes, maxMinutes, minEdges } = {}, rand = Math.random) {
    let lo = positive(minMinutes);
    let hi = positive(maxMinutes);
    if (lo === null && hi !== null) lo = hi;
    if (lo !== null && (hi === null || hi < lo)) hi = lo;
    const endMs = lo === null ? null : Math.round((lo + rand() * (hi - lo)) * 60000);
    const edges = positive(minEdges) === null ? null : Math.round(positive(minEdges));
    return { endMs, edges, continual: endMs === null && edges === null };
}

export function goalsMet(goals, { elapsedMs, edges }) {
    if (goals.continual) return true;
    const timeMet = goals.endMs !== null && elapsedMs >= goals.endMs;
    if (goals.edges === null) return timeMet;
    const edgesMet = edges >= goals.edges;
    if (goals.endMs === null) return edgesMet;
    return timeMet || (edgesMet && elapsedMs >= goals.endMs * CLOSE_TO_TIME);
}
