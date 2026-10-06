export type SidebarDndContainerKind =
  | "pinned"
  | "custom"
  | "jointChannels"
  | "channels"
  | "dms";

export interface SidebarDndContainerData {
  type: "container";
  containerId: string;
  kind: SidebarDndContainerKind;
  manual: boolean;
}

export interface SidebarDndItemData {
  type: "item";
  containerId: string;
  itemId: string;
}

export type SidebarDndData = SidebarDndContainerData | SidebarDndItemData;
export type SidebarDndProjection = Record<string, string[]>;

const CONTAINER_PREFIX = "sidebar:container:";

export const SIDEBAR_PINNED_CONTAINER_ID = `${CONTAINER_PREFIX}pinned`;
export const SIDEBAR_JOINT_CHANNELS_CONTAINER_ID = `${CONTAINER_PREFIX}joint-channels`;
export const SIDEBAR_CHANNELS_CONTAINER_ID = `${CONTAINER_PREFIX}channels`;
export const SIDEBAR_DMS_CONTAINER_ID = `${CONTAINER_PREFIX}dms`;

export function isSidebarDndData(value: unknown): value is SidebarDndData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<SidebarDndData>;
  if (typeof data.containerId !== "string") return false;
  if (data.type === "container") {
    return typeof data.kind === "string" && typeof data.manual === "boolean";
  }
  return data.type === "item" && typeof data.itemId === "string";
}

export function sidebarCustomContainerId(sectionId: string): string {
  return `${CONTAINER_PREFIX}custom:${sectionId}`;
}

export function sidebarCustomSectionId(containerId: string): string | null {
  const prefix = `${CONTAINER_PREFIX}custom:`;
  return containerId.startsWith(prefix) ? containerId.slice(prefix.length) : null;
}

export function findSidebarDndContainer(
  projection: SidebarDndProjection,
  itemId: string,
): string | null {
  for (const [containerId, itemIds] of Object.entries(projection)) {
    if (itemIds.includes(itemId)) return containerId;
  }
  return null;
}

export interface SidebarDndPoint {
  x: number;
  y: number;
}

export interface SidebarDndRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Whether the pointer is inside the bounding box of all sidebar droppables
 * (sections and drop zones), i.e. somewhere in the section list, including the
 * gaps and headers between drop zones. Outside it (below the last section,
 * beside the sidebar, or past an auto-scrolling edge) the drag has no local
 * target and snaps to the nearest valid container instead.
 */
export function isPointerWithinSidebarDndBounds(
  pointer: SidebarDndPoint,
  rects: Iterable<SidebarDndRect>,
): boolean {
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  for (const rect of rects) {
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
    left = Math.min(left, rect.left);
  }
  return pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= bottom;
}

/**
 * The container a sidebar item drag should stay attached to while the pointer
 * is not over any valid destination (a gap between sections, a section header,
 * or a section the item may not enter, such as Joint Channels for a regular
 * channel): wherever the live projection already placed the item, else the
 * drag-start container.
 *
 * This must not depend on droppable geometry. Moving the item changes the
 * height of the containers it leaves and enters (an empty section swaps its
 * hint for a row), so a geometry-based fallback — "nearest valid container" or
 * "back to the drag-start container" — can move the item, shrink the container
 * the pointer just entered, lose it, move the item back, regrow the container,
 * and so on. dnd-kit re-runs collision detection on every remeasure without any
 * pointer movement, so that ping-pong loops until React throws #185 (maximum
 * update depth). Staying put is a fixed point: it never changes the projection.
 */
export function resolveSidebarDndRetainedContainer(
  projection: SidebarDndProjection | null,
  snapshot: SidebarDndProjection | null,
  itemId: string,
): string | null {
  return (projection ? findSidebarDndContainer(projection, itemId) : null)
    ?? (snapshot ? findSidebarDndContainer(snapshot, itemId) : null);
}

/**
 * Height (px) a sidebar drop container reserves as its min-height, re-evaluated
 * after every render. While an item drag is active the reservation only ratchets
 * up to the tallest height the container has had during this drag; otherwise it
 * is cleared (null).
 *
 * The live projection moves the dragged row between containers, and without a
 * reservation that changes the geometry collision detection just ran against:
 * an empty section swaps its (possibly multi-line) hint for one shorter row and
 * shrinks, and a section above the pointer that the row leaves shrinks and
 * pulls everything below it up. Either can push the pointer out of the
 * container it just entered and onto a neighbouring *valid* container; the
 * projection then moves there, the first container regrows under the pointer,
 * and dnd-kit (which re-runs collision detection on every remeasure) ping-pongs
 * until React throws #185. With heights that never shrink mid-drag, a
 * projection can only grow containers below the pointer's top edge, so the
 * geometry settles after a bounded number of steps and cannot alternate.
 */
export function nextSidebarDndReservedHeight(
  itemDragActive: boolean,
  reservedHeight: number | null,
  measuredHeight: number,
): number | null {
  if (!itemDragActive) return null;
  return Math.max(reservedHeight ?? 0, measuredHeight);
}

export function moveSidebarDndItem(
  projection: SidebarDndProjection,
  activeId: string,
  destinationContainerId: string,
  destinationIndex: number,
): SidebarDndProjection {
  const sourceContainerId = findSidebarDndContainer(projection, activeId);
  if (!sourceContainerId || !projection[destinationContainerId]) return projection;

  const sourceItems = projection[sourceContainerId];
  const sourceIndex = sourceItems.indexOf(activeId);
  if (sourceIndex === -1) return projection;

  const nextSourceItems = sourceItems.filter((itemId) => itemId !== activeId);
  const destinationItems = sourceContainerId === destinationContainerId
    ? nextSourceItems
    : projection[destinationContainerId].filter((itemId) => itemId !== activeId);
  const boundedIndex = Math.max(0, Math.min(Math.trunc(destinationIndex), destinationItems.length));

  if (
    sourceContainerId === destinationContainerId
    && sourceIndex === boundedIndex
  ) {
    return projection;
  }

  const nextDestinationItems = [...destinationItems];
  nextDestinationItems.splice(boundedIndex, 0, activeId);

  return {
    ...projection,
    ...(sourceContainerId === destinationContainerId
      ? { [sourceContainerId]: nextDestinationItems }
      : {
          [sourceContainerId]: nextSourceItems,
          [destinationContainerId]: nextDestinationItems,
        }),
  };
}

export function replaceSidebarSubsetOrder(
  fullOrder: string[],
  previousSubset: string[],
  nextSubset: string[],
): string[] {
  const subsetIds = new Set(previousSubset);
  let nextIndex = 0;
  const nextOrder = fullOrder.map((id) => {
    if (!subsetIds.has(id)) return id;
    const replacement = nextSubset[nextIndex];
    nextIndex += 1;
    return replacement ?? id;
  });

  for (; nextIndex < nextSubset.length; nextIndex += 1) {
    nextOrder.push(nextSubset[nextIndex]);
  }
  return nextOrder;
}
