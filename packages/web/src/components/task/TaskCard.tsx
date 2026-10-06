import { memo, useState } from "react";
import {
  TaskCard as RuiTaskCard,
  TaskCardBody,
  TaskCardChannel,
  TaskCardDescription,
  TaskCardLegacy,
  TaskCardMeta,
  TaskCardNumber,
  TaskCardRow,
  TaskCardTitle,
} from "raft-ui";
import type { Task, TaskStatus } from "../../store/taskStore";
import { useTaskStore } from "../../store/taskStore";
import { useAuthStore } from "../../store/authStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import InlineBadgeEditor from "../InlineBadgeEditor";
import { useIntl } from "react-intl";
import { StatusBadge } from "./StatusBadge";

import { STATUS_STYLES, TASK_STATUS_UI, canEditTaskStatus, getTaskStatusBadgeClassName, getTaskStatusOptions } from "./taskStatusUi";

// Memoized so a single task update (status change, drag-reorder, socket
// task:* broadcast) re-renders only the changed card, not the whole board.
// `onOpen` takes the task so callsites can pass a *stable* handler instead of
// an inline `() => open(task)` closure that would break this memo for every row
// (#proj-frontend render-perf, same churn class as the channelActivity slice).
function TaskCard({ task, onOpen, onDragStart, showChannelName = true }: {
  task: Task;
  onOpen: (task: Task) => void;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>, task: Task) => void;
  showChannelName?: boolean;
}) {
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const currentUser = useAuthStore((s) => s.user);
  const { capabilities, role } = useServerPermissions();
  const [editingStatus, setEditingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const canManageServer = capabilities.deleteAnyTask;
  const canEditStatus = canEditTaskStatus(task, currentUser?.id, canManageServer, role);
  const { formatMessage } = useIntl();
  const statusOptions = getTaskStatusOptions(task, currentUser?.id, canManageServer)
    .map((option) => ({ id: option.id, label: formatMessage({ id: option.labelId }) }));
  const style = STATUS_STYLES[task.status];

  const handleStatusSelect = async (id: string) => {
    const nextStatus = id as TaskStatus;
    if (nextStatus === task.status) {
      setEditingStatus(false);
      return;
    }
    setBusy(true);
    try {
      await updateTaskStatus(task.channelId, task.id, nextStatus);
      setEditingStatus(false);
    } catch (err) {
      console.error("Failed to update task status:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RuiTaskCard
      draggable={!!onDragStart}
      onDragStart={(event: React.DragEvent<HTMLDivElement>) => onDragStart?.(event, task)}
      className="w-full"
    >
      <button type="button" onClick={() => onOpen(task)} className="w-full text-left">
        <TaskCardRow>
          <TaskCardBody>
            <TaskCardMeta>
              {showChannelName && (
                <TaskCardChannel>
                  #{task.channelName || formatMessage({ id: "task.legacyPanel.unknownChannel" })}
                </TaskCardChannel>
              )}
              <TaskCardNumber>#{task.taskNumber}</TaskCardNumber>
              {task.isLegacy && (
                <TaskCardLegacy>
                  {formatMessage({ id: "task.badge.legacy" })}
                </TaskCardLegacy>
              )}
            </TaskCardMeta>
            <TaskCardTitle>{task.title}</TaskCardTitle>
            {task.description && (
              <TaskCardDescription>
                {task.description}
              </TaskCardDescription>
            )}
          </TaskCardBody>
        </TaskCardRow>
      </button>
      <div className="mt-2 flex justify-end">
        {canEditStatus ? (
          <div className={`relative shrink-0 ${busy ? "pointer-events-none opacity-60" : ""}`}>
            <InlineBadgeEditor
              badgeVariant={TASK_STATUS_UI[task.status].variant}
              displayValue={formatMessage({ id: style.labelId })}
              selectedId={task.status}
              options={statusOptions}
              onSelect={handleStatusSelect}
              open={editingStatus}
              onToggle={() => setEditingStatus((prev) => !prev)}
              onRequestClose={() => setEditingStatus(false)}
              badgeClassName={getTaskStatusBadgeClassName(task.status)}
              uppercase={false}
              dropdownMinWidth="min-w-[140px]"
              dropdownAlign="right"
              dropdownTestId="task-status-menu"
              optionTestIdPrefix="task-status-option"
            />
          </div>
        ) : (
          <StatusBadge status={task.status} data-testid="task-status-readonly">
            {formatMessage({ id: style.labelId })}
          </StatusBadge>
        )}
      </div>
    </RuiTaskCard>
  );
}

export default memo(TaskCard);
