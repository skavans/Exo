/** A single plan step that agents render in the plan widget. */
export interface PlanItem {
	id: string;
	title: string;
	description: string;
	status: 'pending' | 'in_progress' | 'done';
}

/** Execution plan (UI model, mapped from ACP `PlanEntry[]`). */
export interface Plan {
	items: PlanItem[];
}
