/**
 * Who spends time with whom (T9.1). Pure: it only sees activity segments and returns the
 * weighted pairs of the player network.
 *
 * Two players count as together when their segments in the **same channel** overlap in time.
 * AFK time and excluded channels are filtered out before this function sees them – here only
 * the arithmetic happens, so every special case is testable without a database.
 */

export interface CoPresenceSegment {
  /** The person a segment belongs to; linked UIDs are mapped to one subject beforehand. */
  subject: number;
  channelId: number;
  startAt: number;
  endAt: number;
}

export interface CoPresenceOptions {
  /** Window the segments are clipped to. */
  from: number;
  to: number;
  /** A single encounter shorter than this is ignored – walking through a channel is not company. */
  minEncounterS: number;
  /** Pairs with less total time than this are dropped. */
  minPairS: number;
}

export interface CoPresenceEdge {
  /** Always the smaller subject id, so a pair has exactly one representation. */
  a: number;
  b: number;
  seconds: number;
  /** How many separate encounters the time is made of. */
  encounters: number;
}

export interface CoPresenceResult {
  /** Time each subject spent in counted channels, seconds – the size of a node. */
  nodes: Map<number, number>;
  edges: CoPresenceEdge[];
  /** Pairs that existed but stayed below `minPairS`. */
  droppedPairs: number;
  /** Encounters that stayed below `minEncounterS`. */
  droppedEncounters: number;
}

interface Open {
  subject: number;
  endAt: number;
}

const key = (a: number, b: number) => `${String(a)}:${String(b)}`;

/**
 * Sweep line over the segments, which must be ordered by `startAt`. For each segment only the
 * segments still open in the same channel are compared, so the cost grows with the number of
 * people online at the same time – not with the square of the segment count.
 */
export function buildCoPresence(
  segments: Iterable<CoPresenceSegment>,
  options: CoPresenceOptions,
): CoPresenceResult {
  const nodes = new Map<number, number>();
  const pairs = new Map<string, CoPresenceEdge>();
  const open = new Map<number, Open[]>();
  let droppedEncounters = 0;
  let last = Number.NEGATIVE_INFINITY;

  for (const segment of segments) {
    const start = Math.max(segment.startAt, options.from);
    const end = Math.min(segment.endAt, options.to);
    if (end <= start) continue;
    if (start < last) {
      throw new Error('buildCoPresence expects segments ordered by startAt');
    }
    last = start;

    nodes.set(segment.subject, (nodes.get(segment.subject) ?? 0) + (end - start));

    let list = open.get(segment.channelId);
    if (!list) {
      list = [];
      open.set(segment.channelId, list);
    }
    // Walk backwards so finished segments can be dropped while iterating.
    for (let i = list.length - 1; i >= 0; i--) {
      const other = list[i] as Open;
      if (other.endAt <= start) {
        list.splice(i, 1);
        continue;
      }
      // Two accounts of the same person in one channel are not company.
      if (other.subject === segment.subject) continue;
      const seconds = Math.min(end, other.endAt) - start;
      if (seconds <= 0) continue;
      if (seconds < options.minEncounterS) {
        droppedEncounters++;
        continue;
      }
      const a = Math.min(other.subject, segment.subject);
      const b = Math.max(other.subject, segment.subject);
      const edge = pairs.get(key(a, b));
      if (edge) {
        edge.seconds += seconds;
        edge.encounters++;
      } else {
        pairs.set(key(a, b), { a, b, seconds, encounters: 1 });
      }
    }
    list.push({ subject: segment.subject, endAt: end });
  }

  const edges: CoPresenceEdge[] = [];
  let droppedPairs = 0;
  for (const edge of pairs.values()) {
    if (edge.seconds < options.minPairS) {
      droppedPairs++;
      continue;
    }
    edges.push(edge);
  }
  edges.sort((x, y) => y.seconds - x.seconds || x.a - y.a || x.b - y.b);
  return { nodes, edges, droppedPairs, droppedEncounters };
}
