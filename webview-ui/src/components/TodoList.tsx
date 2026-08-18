import { useState } from 'preact/hooks';
import type { Plan, PlanItem } from '../types';

interface Props {
	plan: Plan;
}

function StepIcon({ status }: { status: PlanItem['status'] }) {
	switch (status) {
		case 'done':
			return <span class="todo-step-icon done">✓</span>;
		case 'in_progress':
			return <span class="todo-step-icon active">●</span>;
		case 'pending':
			return <span class="todo-step-icon pending">○</span>;
	}
}

export function TodoList({ plan }: Props) {
	const [expanded, setExpanded] = useState(false);

	const doneCount = plan.items.filter((i) => i.status === 'done').length;
	const totalCount = plan.items.length;
	const allDone = doneCount === totalCount;

	// Find current step (in_progress, or first pending if nothing active yet)
	const currentStep = plan.items.find((i) => i.status === 'in_progress')
		|| plan.items.find((i) => i.status === 'pending');

	const progressPercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

	const headerTitle = currentStep?.title || 'Plan';

	return (
		<div class={`todo-list${expanded ? ' expanded' : ''}${allDone ? ' all-done' : ''}`}>
			<div class="todo-header" onClick={() => setExpanded((e) => !e)}>
				<div class="todo-header-row">
					<div class="todo-header-left">
						{allDone ? (
							<span class="todo-step-icon done" style="width:14px;height:14px;font-size:8px;margin-top:0">✓</span>
						) : currentStep?.status === 'in_progress' ? (
							<span class="todo-step-icon active" style="width:14px;height:14px;margin-top:0" />
						) : (
							<span class="todo-step-icon pending" style="width:14px;height:14px;margin-top:0" />
						)}
						<span class="todo-title">{headerTitle}</span>
						<span class="todo-progress">{doneCount}/{totalCount}</span>
					</div>
				</div>
			</div>
			{expanded && (
				<div class="todo-steps">
					{plan.items.map((item) => (
						<div key={item.id} class={`todo-step ${item.status}`}>
							<StepIcon status={item.status} />
							<div class="todo-step-content">
								<span class="todo-step-title">{item.title}</span>
								{(item.status === 'in_progress') && item.description && (
									<span class="todo-step-desc">{item.description}</span>
								)}
							</div>
						</div>
					))}
				</div>
			)}
			<div class="todo-progress-bar">
				<div class="todo-progress-fill" style={`width: ${progressPercent}%`} />
			</div>
		</div>
	);
}
