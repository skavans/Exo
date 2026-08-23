/** HTML-escape text. The quote-escaping variant is used for attribute values. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Escape for use inside a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/"/g, '&quot;');
}
