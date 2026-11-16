/**
 * Moves `id` to index `to` (clamped), shifting the others. Returns the same array
 * when nothing moves, so callers can skip a save.
 */
export function moveId(order: readonly string[], id: string, to: number): readonly string[] {
	const from = order.indexOf(id);
	const target = Math.max(0, Math.min(order.length - 1, to));
	if (from === -1 || from === target) return order;
	const next = order.filter((x) => x !== id);
	next.splice(target, 0, id);
	return next;
}
