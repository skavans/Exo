/**
 * Simple greedy fuzzy matcher in the style of fzf.
 * Returns a score (higher = better) and the indices of the matched positions in target.
 * Bonuses: consecutive match, boundary char (/, ., _, -, space, line start).
 */

export interface FuzzyMatch {
	score: number;
	indices: number[];
}

const BOUNDARY_CHARS = new Set(['/', '.', '_', '-', ' ', '\n', '\t']);

function isBoundary(ch: string | undefined): boolean {
	return ch === undefined || BOUNDARY_CHARS.has(ch);
}

/**
 * Matches query as a subsequence of target chars (case-insensitive).
 * Greedy pass: take the first matching char.
 * Returns null if not all query chars are found in target, in order.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
	if (!query) {
		return { score: 0, indices: [] };
	}
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	const indices: number[] = [];
	let qi = 0;
	let prevIdx = -1;
	let score = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] !== q[qi]) {
			continue;
		}
		indices.push(ti);
		// consecutive bonus
		if (prevIdx === ti - 1) {
			score += 5;
		} else {
			score += 1;
		}
		// boundary bonus
		if (isBoundary(t[ti - 1])) {
			score += 3;
		}
		prevIdx = ti;
		qi++;
	}
	if (qi < q.length) {
		return null;
	}
	// Penalize in match spread — prefer dense matches.
	score -= (indices[indices.length - 1] - indices[0] - indices.length + 1) * 0.1;
	return { score, indices };
}

export interface FuzzyResult<T> {
	item: T;
	match: FuzzyMatch;
}

/**
 * Filter items by query, return them sorted by descending score, with
 * match data for highlighting.
 */
export function fuzzyFilter<T>(
	query: string,
	items: T[],
	getText: (item: T) => string,
): FuzzyResult<T>[] {
	const results: FuzzyResult<T>[] = [];
	for (const item of items) {
		const match = fuzzyMatch(query, getText(item));
		if (match) {
			results.push({ item, match });
		}
	}
	results.sort((a, b) => b.match.score - a.match.score);
	return results;
}
