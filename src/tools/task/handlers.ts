/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem <taazkareem@icloud.com>
 * SPDX-License-Identifier: MIT
 *
 * ClickUp MCP Task Operation Handlers
 * 
 * This module implements the handlers for task operations, both for single task
 * and bulk operations. These handlers are used by the tool definitions.
 */

import { ClickUpComment, ClickUpTask, TaskPriority, UpdateTaskData, TaskFilters, toTaskPriority, CreateTaskData, TaskSummary } from '../../services/clickup/types.js';
import { clickUpServices } from '../../services/shared.js';
import { BulkService } from '../../services/clickup/bulk.js';
import { BatchResult } from '../../utils/concurrency-utils.js';
import { parseDueDate } from '../utils.js';
import {
  validateTaskIdentification,
  validateListIdentification,
  validateTaskUpdateData,
  validateBulkTasks,
  parseBulkOptions,
  resolveListIdWithValidation,
  formatTaskData
} from './utilities.js';
import { TaskService } from '../../services/clickup/task/task-service.js';
import { ExtendedTaskFilters } from '../../services/clickup/types.js';
import { handleResolveAssignees } from '../member.js';
import { findListIDByName } from '../list.js';
import { workspaceService } from '../../services/shared.js';
import { isNameMatch } from '../../utils/resolver-utils.js';
import { Logger } from '../../logger.js';

// Use shared services instance
const { task: taskService, list: listService } = clickUpServices;

// Create a bulk service instance that uses the task service
const bulkService = new BulkService(taskService);

// Create a logger instance for task handlers
const logger = new Logger('TaskHandlers');

// Token limit constant for workspace tasks - AGGRESSIVE OPTIMIZATION
const WORKSPACE_TASKS_TOKEN_LIMIT = 5000;

// Cache for task context between sequential operations
const taskContextCache = new Map<string, { id: string, timestamp: number }>();
const TASK_CONTEXT_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Store task context for sequential operations
 */
function storeTaskContext(taskName: string, taskId: string) {
  taskContextCache.set(taskName, {
    id: taskId,
    timestamp: Date.now()
  });
}

/**
 * Get cached task context if valid
 */
function getCachedTaskContext(taskName: string): string | null {
  const context = taskContextCache.get(taskName);
  if (!context) return null;

  if (Date.now() - context.timestamp > TASK_CONTEXT_TTL) {
    taskContextCache.delete(taskName);
    return null;
  }

  return context.id;
}

//=============================================================================
// SHARED UTILITY FUNCTIONS
//=============================================================================

/**
 * Parse time estimate string into minutes
 * Supports formats like "2h 30m", "150m", "2.5h"
 */
function parseTimeEstimate(timeEstimate: string | number): number {
  // If it's already a number, return it directly
  if (typeof timeEstimate === 'number') {
    return timeEstimate;
  }

  if (!timeEstimate || typeof timeEstimate !== 'string') return 0;

  // If it's just a number as string, parse it
  if (/^\d+$/.test(timeEstimate)) {
    return parseInt(timeEstimate, 10);
  }

  let totalMinutes = 0;

  // Extract hours
  const hoursMatch = timeEstimate.match(/(\d+\.?\d*)h/);
  if (hoursMatch) {
    totalMinutes += parseFloat(hoursMatch[1]) * 60;
  }

  // Extract minutes
  const minutesMatch = timeEstimate.match(/(\d+)m/);
  if (minutesMatch) {
    totalMinutes += parseInt(minutesMatch[1], 10);
  }

  return Math.round(totalMinutes); // Return minutes
}

/**
 * Resolve assignees from mixed input (user IDs, emails, usernames) to user IDs
 */
async function resolveAssignees(assignees: (number | string)[]): Promise<number[]> {
  if (!assignees || !Array.isArray(assignees) || assignees.length === 0) {
    return [];
  }

  const resolved: number[] = [];
  const toResolve: string[] = [];

  // Separate numeric IDs from strings that need resolution
  for (const assignee of assignees) {
    if (typeof assignee === 'number') {
      resolved.push(assignee);
    } else if (typeof assignee === 'string') {
      // Check if it's a numeric string
      const numericId = parseInt(assignee, 10);
      if (!isNaN(numericId) && numericId.toString() === assignee) {
        resolved.push(numericId);
      } else {
        // It's an email or username that needs resolution
        toResolve.push(assignee);
      }
    }
  }

  // Resolve emails/usernames to user IDs if any
  if (toResolve.length > 0) {
    try {
      const result = await handleResolveAssignees({ assignees: toResolve });
      // The result is wrapped by sponsorService.createResponse, so we need to parse the JSON
      if (result.content && Array.isArray(result.content) && result.content.length > 0) {
        const dataText = result.content[0].text;
        const parsedData = JSON.parse(dataText);
        if (parsedData.userIds && Array.isArray(parsedData.userIds)) {
          for (const userId of parsedData.userIds) {
            if (userId !== null && typeof userId === 'number') {
              resolved.push(userId);
            }
          }
        }
      }
    } catch (error) {
      console.warn('Failed to resolve some assignees:', error.message);
      // Continue with the IDs we could resolve
    }
  }

  return resolved;
}

/**
 * Build task update data from parameters
 */
async function buildUpdateData(params: any): Promise<UpdateTaskData> {
  const updateData: UpdateTaskData = {};

  if (params.name !== undefined) updateData.name = params.name;
  if (params.description !== undefined) updateData.description = params.description;
  if (params.markdown_description !== undefined) updateData.markdown_description = params.markdown_description;
  if (params.status !== undefined) updateData.status = params.status;

  // Use toTaskPriority to properly handle null values and validation
  if (params.priority !== undefined) {
    updateData.priority = toTaskPriority(params.priority);
  }

  if (params.dueDate !== undefined) {
    const parsedDueDate = parseDueDate(params.dueDate);
    if (parsedDueDate !== undefined) {
      updateData.due_date = parsedDueDate;
      updateData.due_date_time = true;
    } else {
      // Clear the due date by setting it to null
      updateData.due_date = null;
      updateData.due_date_time = false;
    }
  }

  if (params.startDate !== undefined) {
    const parsedStartDate = parseDueDate(params.startDate);
    if (parsedStartDate !== undefined) {
      updateData.start_date = parsedStartDate;
      updateData.start_date_time = true;
    } else {
      // Clear the start date by setting it to null
      updateData.start_date = null;
      updateData.start_date_time = false;
    }
  }

  // Handle time estimate if provided - convert from string to minutes
  if (params.time_estimate !== undefined) {
    // Log the time estimate for debugging
    console.log(`Original time_estimate: ${params.time_estimate}, typeof: ${typeof params.time_estimate}`);

    // Parse and convert to number in minutes
    const minutes = parseTimeEstimate(params.time_estimate);

    console.log(`Converted time_estimate: ${minutes}`);
    updateData.time_estimate = minutes;
  }

  // Handle custom fields if provided
  if (params.custom_fields !== undefined) {
    updateData.custom_fields = params.custom_fields;
  }

  // Handle assignees if provided - resolve emails/usernames to user IDs
  if (params.assignees !== undefined) {
    // Parse assignees if it's a string (from MCP serialization)
    let assigneesArray = params.assignees;
    if (typeof params.assignees === 'string') {
      try {
        assigneesArray = JSON.parse(params.assignees);
      } catch (error) {
        console.warn('Failed to parse assignees string:', params.assignees, error);
        assigneesArray = [];
      }
    }

    const resolvedAssignees = await resolveAssignees(assigneesArray);

    // Store the resolved assignees for processing in the updateTask method
    // The actual add/rem logic will be handled there based on current vs new assignees
    updateData.assignees = resolvedAssignees;
  }

  return updateData;
}

/**
 * Core function to find a task by ID or name
 * This consolidates all task lookup logic in one place for consistency
 */
async function findTask(params: {
  taskId?: string,
  taskName?: string,
  listName?: string,
  customTaskId?: string,
  requireId?: boolean,
  includeSubtasks?: boolean
}) {
  const { taskId, taskName, listName, customTaskId, requireId = false, includeSubtasks = false } = params;

  // Validate that we have enough information to identify a task
  const validationResult = validateTaskIdentification(
    { taskId, taskName, listName, customTaskId },
    { requireTaskId: requireId, useGlobalLookup: true }
  );

  if (!validationResult.isValid) {
    throw new Error(validationResult.errorMessage);
  }

  try {
    // Direct path for taskId - most efficient (now includes automatic custom ID detection)
    if (taskId) {
      const task = await taskService.getTask(taskId);

      // Add subtasks if requested
      if (includeSubtasks) {
        const subtasks = await taskService.getSubtasks(task.id);
        return { task, subtasks };
      }

      return { task };
    }

    // Direct path for customTaskId - for explicit custom ID requests
    // Note: This is now mainly for backward compatibility since getTask() handles custom IDs automatically
    if (customTaskId) {
      const task = await taskService.getTaskByCustomId(customTaskId);

      // Add subtasks if requested
      if (includeSubtasks) {
        const subtasks = await taskService.getSubtasks(task.id);
        return { task, subtasks };
      }

      return { task };
    }

    // Special optimized path for taskName + listName combination
    if (taskName && listName) {
      const listId = await resolveListIdWithValidation(null, listName);

      // Get all tasks in the list
      const allTasks = await taskService.getTasks(listId);

      // Find the task that matches the name
      const matchingTask = findTaskByName(allTasks, taskName);

      if (!matchingTask) {
        throw new Error(`Task "${taskName}" not found in list "${listName}"`);
      }

      // Add subtasks if requested
      if (includeSubtasks) {
        const subtasks = await taskService.getSubtasks(matchingTask.id);
        return { task: matchingTask, subtasks };
      }

      return { task: matchingTask };
    }

    // Fallback to searching all lists for taskName-only case
    if (taskName) {
      logger.debug(`Searching all lists for task: "${taskName}"`);

      // Get workspace hierarchy which contains all lists
      const hierarchy = await workspaceService.getWorkspaceHierarchy();

      // Extract all list IDs from the hierarchy
      const listIds: string[] = [];
      const extractListIds = (node: any) => {
        if (node.type === 'list') {
          listIds.push(node.id);
        }
        if (node.children) {
          node.children.forEach(extractListIds);
        }
      };

      // Start from the root's children
      hierarchy.root.children.forEach(extractListIds);

      // Search through each list
      const searchPromises = listIds.map(async (listId) => {
        try {
          const tasks = await taskService.getTasks(listId);
          const matchingTask = findTaskByName(tasks, taskName);
          if (matchingTask) {
            logger.debug(`Found task "${matchingTask.name}" (ID: ${matchingTask.id}) in list with ID "${listId}"`);
            return matchingTask;
          }
          return null;
        } catch (error) {
          logger.warn(`Error searching list ${listId}: ${error.message}`);
          return null;
        }
      });

      // Wait for all searches to complete
      const results = await Promise.all(searchPromises);

      // Filter out null results and sort by match quality and recency
      const matchingTasks = results
        .filter(task => task !== null)
        .sort((a, b) => {
          const aMatch = isNameMatch(a.name, taskName);
          const bMatch = isNameMatch(b.name, taskName);

          // First sort by match quality
          if (bMatch.score !== aMatch.score) {
            return bMatch.score - aMatch.score;
          }

          // Then sort by recency
          return parseInt(b.date_updated) - parseInt(a.date_updated);
        });

      if (matchingTasks.length === 0) {
        throw new Error(`Task "${taskName}" not found in any list across your workspace. Please check the task name and try again.`);
      }

      const bestMatch = matchingTasks[0];

      // Add subtasks if requested
      if (includeSubtasks) {
        const subtasks = await taskService.getSubtasks(bestMatch.id);
        return { task: bestMatch, subtasks };
      }

      return { task: bestMatch };
    }

    // We shouldn't reach here if validation is working correctly
    throw new Error("No valid task identification provided");

  } catch (error) {
    // Enhance error message for non-existent tasks
    if (taskName && error.message.includes('not found')) {
      throw new Error(`Task "${taskName}" not found. Please check the task name and try again.`);
    }

    // Pass along other formatted errors
    throw error;
  }
}

/**
 * Helper function to find a task by name in an array of tasks
 */
function findTaskByName(tasks, name) {
  if (!tasks || !Array.isArray(tasks) || !name) return null;

  const normalizedSearchName = name.toLowerCase().trim();

  // Get match scores for all tasks
  const taskMatchScores = tasks.map(task => {
    const matchResult = isNameMatch(task.name, name);
    return {
      task,
      matchResult,
      // Parse the date_updated field as a number for sorting
      updatedAt: task.date_updated ? parseInt(task.date_updated, 10) : 0
    };
  }).filter(result => result.matchResult.isMatch);

  if (taskMatchScores.length === 0) {
    return null;
  }

  // First, try to find exact matches
  const exactMatches = taskMatchScores
    .filter(result => result.matchResult.exactMatch)
    .sort((a, b) => {
      // For exact matches with the same score, sort by most recently updated
      if (b.matchResult.score === a.matchResult.score) {
        return b.updatedAt - a.updatedAt;
      }
      return b.matchResult.score - a.matchResult.score;
    });

  // Get the best matches based on whether we have exact matches or need to fall back to fuzzy matches
  const bestMatches = exactMatches.length > 0 ? exactMatches : taskMatchScores.sort((a, b) => {
    // First sort by match score (highest first)
    if (b.matchResult.score !== a.matchResult.score) {
      return b.matchResult.score - a.matchResult.score;
    }
    // Then sort by most recently updated
    return b.updatedAt - a.updatedAt;
  });

  // Get the best match
  return bestMatches[0].task;
}

/**
 * Handler for getting a task - uses the consolidated findTask function
 */
export async function getTaskHandler(params) {
  try {
    const result = await findTask({
      taskId: params.taskId,
      taskName: params.taskName,
      listName: params.listName,
      customTaskId: params.customTaskId,
      includeSubtasks: params.subtasks
    });

    if (result.subtasks) {
      return { ...result.task, subtasks: result.subtasks };
    }

    return result.task;
  } catch (error) {
    throw error;
  }
}

/**
 * Get task ID from various identifiers - uses the consolidated findTask function
 */
export async function getTaskId(taskId?: string, taskName?: string, listName?: string, customTaskId?: string, requireId?: boolean, includeSubtasks?: boolean): Promise<string> {
  // Check task context cache first if we have a task name
  if (taskName && !taskId && !customTaskId) {
    const cachedId = getCachedTaskContext(taskName);
    if (cachedId) {
      return cachedId;
    }
  }

  const result = await findTask({
    taskId,
    taskName,
    listName,
    customTaskId,
    requireId,
    includeSubtasks
  });

  // Store task context for future operations
  if (taskName && result.task.id) {
    storeTaskContext(taskName, result.task.id);
  }

  return result.task.id;
}

/**
 * Process a list identification validation, returning the list ID
 */
async function getListId(listId?: string, listName?: string): Promise<string> {
  validateListIdentification(listId, listName);
  return await resolveListIdWithValidation(listId, listName);
}

/**
 * Extract and build task filters from parameters
 */
function buildTaskFilters(params: any): TaskFilters {
  const { subtasks, statuses, page, order_by, reverse } = params;
  const filters: TaskFilters = {};

  if (subtasks !== undefined) filters.subtasks = subtasks;
  if (statuses !== undefined) filters.statuses = statuses;
  if (page !== undefined) filters.page = page;
  if (order_by !== undefined) filters.order_by = order_by;
  if (reverse !== undefined) filters.reverse = reverse;

  return filters;
}

/**
 * Map tasks for bulk operations, resolving task IDs
 * Uses smart disambiguation for tasks without list context
 */
async function mapTaskIds(tasks: any[]): Promise<string[]> {
  return Promise.all(tasks.map(async (task) => {
    const validationResult = validateTaskIdentification(
      { taskId: task.taskId, taskName: task.taskName, listName: task.listName, customTaskId: task.customTaskId },
      { useGlobalLookup: true }
    );

    if (!validationResult.isValid) {
      throw new Error(validationResult.errorMessage);
    }

    return await getTaskId(task.taskId, task.taskName, task.listName, task.customTaskId);
  }));
}

//=============================================================================
// SINGLE TASK OPERATIONS
//=============================================================================

/**
 * Handler for creating a task
 */
export async function createTaskHandler(params) {
  const {
    name,
    description,
    markdown_description,
    status,
    dueDate,
    startDate,
    parent,
    tags,
    custom_fields,
    check_required_custom_fields,
    assignees
  } = params;

  if (!name) throw new Error("Task name is required");

  // Use our helper function to validate and convert priority
  const priority = toTaskPriority(params.priority);

  const listId = await getListId(params.listId, params.listName);

  // Resolve assignees if provided
  let resolvedAssignees = undefined;
  if (assignees) {
    // Parse assignees if it's a string (from MCP serialization)
    let assigneesArray = assignees;
    if (typeof assignees === 'string') {
      try {
        assigneesArray = JSON.parse(assignees);
      } catch (error) {
        console.warn('Failed to parse assignees string in createTask:', assignees, error);
        assigneesArray = [];
      }
    }
    resolvedAssignees = await resolveAssignees(assigneesArray);
  }

  const taskData: CreateTaskData = {
    name,
    description,
    markdown_description,
    status,
    parent,
    tags,
    custom_fields,
    check_required_custom_fields,
    assignees: resolvedAssignees
  };

  // Only include priority if explicitly provided by the user
  if (priority !== undefined) {
    taskData.priority = priority;
  }

  // Add due date if specified
  if (dueDate) {
    taskData.due_date = parseDueDate(dueDate);
    taskData.due_date_time = true;
  }

  // Add start date if specified
  if (startDate) {
    taskData.start_date = parseDueDate(startDate);
    taskData.start_date_time = true;
  }

  return await taskService.createTask(listId, taskData);
}

/**
 * Handler for updating a task
 */
export async function updateTaskHandler(
  taskService: TaskService,
  params: UpdateTaskData & {
    taskId?: string;
    taskName?: string;
    listName?: string;
    customTaskId?: string;
  }
): Promise<ClickUpTask> {
  const { taskId, taskName, listName, customTaskId, ...rawUpdateData } = params;

  // Validate task identification with global lookup enabled
  const validationResult = validateTaskIdentification(params, { useGlobalLookup: true });
  if (!validationResult.isValid) {
    throw new Error(validationResult.errorMessage);
  }

  // Build properly formatted update data from raw parameters (now async)
  const updateData = await buildUpdateData(rawUpdateData);

  // Validate update data
  validateTaskUpdateData(updateData);

  try {
    // Get the task ID using global lookup
    const id = await getTaskId(taskId, taskName, listName, customTaskId);
    return await taskService.updateTask(id, updateData);
  } catch (error) {
    throw new Error(`Failed to update task: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handler for moving a task
 */
export async function moveTaskHandler(params) {
  const taskId = await getTaskId(params.taskId, params.taskName, undefined, params.customTaskId, false);
  const listId = await getListId(params.listId, params.listName);
  return await taskService.moveTask(taskId, listId);
}

/**
 * Handler for duplicating a task
 */
export async function duplicateTaskHandler(params) {
  const taskId = await getTaskId(params.taskId, params.taskName, undefined, params.customTaskId, false);
  let listId;

  if (params.listId || params.listName) {
    listId = await getListId(params.listId, params.listName);
  }

  return await taskService.duplicateTask(taskId, listId);
}

/**
 * Handler for getting tasks
 */
export async function getTasksHandler(params) {
  const listId = await getListId(params.listId, params.listName);
  return await taskService.getTasks(listId, buildTaskFilters(params));
}

/**
 * Handler for getting task comments
 */
export async function getTaskCommentsHandler(params) {
  const taskId = await getTaskId(params.taskId, params.taskName, params.listName);
  const { start, startId } = params;
  return await taskService.getTaskComments(taskId, start, startId);
}

/**
 * Handler for creating a task comment
 */
export async function createTaskCommentHandler(params) {
  // Validate required parameters
  if (!params.commentText) {
    throw new Error('Comment text is required');
  }

  try {
    // Resolve the task ID
    const taskId = await getTaskId(params.taskId, params.taskName, params.listName);

    // Extract other parameters with defaults
    const {
      commentText,
      notifyAll = false,
      assignee = null
    } = params;

    // Create the comment
    return await taskService.createTaskComment(taskId, commentText, notifyAll, assignee);
  } catch (error) {
    // If this is a task lookup error, provide more helpful message
    if (error.message?.includes('not found') || error.message?.includes('identify task')) {
      if (params.taskName) {
        throw new Error(`Could not find task "${params.taskName}" in list "${params.listName}"`);
      } else {
        throw new Error(`Task with ID "${params.taskId}" not found`);
      }
    }

    // Otherwise, rethrow the original error
    throw error;
  }
}

/**
 * Estimate tokens for a task response
 * This is a simplified estimation - adjust based on actual token counting needs
 */
function estimateTaskResponseTokens(task: ClickUpTask): number {
  // Base estimation for task structure
  let tokenCount = 0;

  // Core fields
  tokenCount += (task.name?.length || 0) / 4; // Approximate tokens for name
  tokenCount += (task.description?.length || 0) / 4; // Approximate tokens for description
  tokenCount += (task.text_content?.length || 0) / 4; // Use text_content instead of markdown_description

  // Status and other metadata
  tokenCount += 5; // Basic metadata fields

  // Custom fields
  if (task.custom_fields) {
    tokenCount += Object.keys(task.custom_fields).length * 10; // Rough estimate per custom field
  }

  // Add overhead for JSON structure
  tokenCount *= 1.1;

  return Math.ceil(tokenCount);
}

/**
 * Check if response would exceed token limit
 */
function wouldExceedTokenLimit(response: any): boolean {
  if (!response.tasks?.length) return false;

  // Calculate total estimated tokens
  const totalTokens = response.tasks.reduce((sum: number, task: ClickUpTask) =>
    sum + estimateTaskResponseTokens(task), 0
  );

  // Add overhead for response structure
  const estimatedTotal = totalTokens * 1.1;

  return estimatedTotal > WORKSPACE_TASKS_TOKEN_LIMIT;
}

/**
 * Handler for getting workspace tasks with AGGRESSIVE token limiting
 */
export async function getWorkspaceTasksHandler(
  taskService: TaskService,
  params: Record<string, any>
): Promise<Record<string, any>> {
  try {
    // STEP 1: Force token-efficient parameters - keep all original params
    const optimizedParams: Record<string, any> = {
      ...params,
      detail_level: "summary",        // Always use summary mode
      subtasks: false,               // No subtasks
      include_closed: false,         // No closed tasks
      include_archived_lists: false, // No archived
      page: 0,                       // First page only
      // Force recent date filter (last 7 days) if not provided
      date_updated_gt: params.date_updated_gt || (Date.now() - (7 * 24 * 60 * 60 * 1000))
    };

    // STEP 2: Limit list_ids to prevent overload
    if (optimizedParams.list_ids && Array.isArray(optimizedParams.list_ids) && optimizedParams.list_ids.length > 3) {
      optimizedParams.list_ids = optimizedParams.list_ids.slice(0, 3);
      logger.warn('Limited list_ids to 3 for token efficiency');
    }

    logger.info('🔄 getWorkspaceTasksHandler with aggressive optimization');

    // Require at least one filter parameter
    const hasFilter = [
      'tags',
      'list_ids', 
      'folder_ids',
      'space_ids',
      'statuses',
      'assignees',
      'date_created_gt',
      'date_created_lt',
      'date_updated_gt',
      'date_updated_lt',
      'due_date_gt',
      'due_date_lt'
    ].some(key => optimizedParams[key] !== undefined);

    if (!hasFilter) {
      throw new Error('At least one filter parameter is required');
    }

    // STEP 3: Get tasks with aggressive filtering
    const filters: ExtendedTaskFilters = {
      tags: optimizedParams.tags,
      list_ids: optimizedParams.list_ids,
      folder_ids: optimizedParams.folder_ids,
      space_ids: optimizedParams.space_ids,
      statuses: optimizedParams.statuses,
      include_closed: false,            // Force no closed
      include_archived_lists: false,    // Force no archived
      archived: false,                  // Force no archived
      order_by: optimizedParams.order_by,
      reverse: optimizedParams.reverse,
      due_date_gt: optimizedParams.due_date_gt,
      due_date_lt: optimizedParams.due_date_lt,
      date_created_gt: optimizedParams.date_created_gt,
      date_created_lt: optimizedParams.date_created_lt,
      date_updated_gt: optimizedParams.date_updated_gt,
      date_updated_lt: optimizedParams.date_updated_lt,
      assignees: optimizedParams.assignees,
      page: 0,                          // Force first page only
      detail_level: 'summary',          // Force summary mode
      subtasks: false,                  // Force no subtasks
      custom_fields: optimizedParams.custom_fields
    };

    // STEP 4: Get response and aggressively filter
    const response = await taskService.getWorkspaceTasks(filters);
    
    // Type-safe response handling
    if ('tasks' in response && response.tasks) {
      logger.info(`📊 Original response: ${response.tasks.length} tasks`);
      
      // STEP 5: Hard limit to 30 tasks maximum
      const limitedTasks = response.tasks.slice(0, 30);
      
      // STEP 6: Strip to absolute essentials only
      const ultraLightTasks = limitedTasks.map(task => ({
        id: task.id,
        name: task.name?.substring(0, 80) || '', // Truncate long names
        status: task.status?.status || task.status || '',
        url: task.url || '',
        priority: task.priority?.priority || null,
        list: {
          id: task.list?.id || '',
          name: task.list?.name?.substring(0, 40) || ''
        },
        due_date: task.due_date || null,
        tags: (task.tags || []).slice(0, 3).map(t => (typeof t === 'object' && t.name) ? t.name : t).filter(Boolean)
        // STRIPPED: description, custom_fields, assignees, attachments, time_entries, etc.
      }));

      logger.info(`✅ Token-optimized response: ${ultraLightTasks.length} tasks`);
      logger.info(`📉 Estimated size: ${JSON.stringify(ultraLightTasks).length} chars`);

      return {
        tasks: ultraLightTasks,
        total_count: Math.min(response.total_count || 0, 30),
        has_more: false, // Always false to prevent further requests
        next_page: 0,
        _optimization_note: "Response limited to 30 tasks with essential fields only for token efficiency"
      };
    }

    // STEP 7: Handle summary responses
    if ('summaries' in response && response.summaries) {
      const limitedSummaries = response.summaries.slice(0, 30).map(summary => ({
        id: summary.id,
        name: summary.name?.substring(0, 80) || '',
        status: summary.status || '',
        url: summary.url || '',
        list: {
          id: summary.list?.id || '',
          name: summary.list?.name?.substring(0, 40) || ''
        },
        due_date: summary.due_date || null,
        priority: summary.priority || null,
        tags: (summary.tags || []).slice(0, 3).map(t => (typeof t === 'object' && t.name) ? t.name : t).filter(Boolean)
      }));

      logger.info(`✅ Token-optimized summaries: ${limitedSummaries.length} items`);

      return {
        summaries: limitedSummaries,
        total_count: Math.min(response.total_count || 0, 30),
        has_more: false,
        next_page: 0,
        _optimization_note: "Response limited to 30 summaries for token efficiency"
      };
    }

    // Empty response
    return {
      tasks: [],
      total_count: 0,
      has_more: false,
      next_page: 0
    };

  } catch (error: any) {
    logger.error('❌ getWorkspaceTasksHandler error:', error.message);
    throw new Error(`Failed to get workspace tasks: ${error.message}`);
  }
}

//=============================================================================
// BULK TASK OPERATIONS
//=============================================================================

/**
 * Handler for creating multiple tasks
 */
export async function createBulkTasksHandler(params: any) {
  const { tasks, listId, listName, options } = params;

  // Validate tasks array
  validateBulkTasks(tasks, 'create');

  // Validate and resolve list ID
  const targetListId = await resolveListIdWithValidation(listId, listName);

  // Format tasks for creation - resolve assignees for each task
  const formattedTasks: CreateTaskData[] = await Promise.all(tasks.map(async task => {
    // Resolve assignees if provided
    const resolvedAssignees = task.assignees ? await resolveAssignees(task.assignees) : undefined;

    const taskData: CreateTaskData = {
      name: task.name,
      description: task.description,
      markdown_description: task.markdown_description,
      status: task.status,
      tags: task.tags,
      custom_fields: task.custom_fields,
      assignees: resolvedAssignees
    };

    // Only include priority if explicitly provided by the user
    const priority = toTaskPriority(task.priority);
    if (priority !== undefined) {
      taskData.priority = priority;
    }

    // Add due date if specified
    if (task.dueDate) {
      taskData.due_date = parseDueDate(task.dueDate);
      taskData.due_date_time = true;
    }

    // Add start date if specified
    if (task.startDate) {
      taskData.start_date = parseDueDate(task.startDate);
      taskData.start_date_time = true;
    }

    return taskData;
  }));

  // Parse bulk options
  const bulkOptions = parseBulkOptions(options);

  // Create tasks - pass arguments in correct order: listId, tasks, options
  return await bulkService.createTasks(targetListId, formattedTasks, bulkOptions);
}

/**
 * Handler for updating multiple tasks
 */
export async function updateBulkTasksHandler(params: any) {
  const { tasks, options } = params;

  // Validate tasks array
  validateBulkTasks(tasks, 'update');

  // Parse bulk options
  const bulkOptions = parseBulkOptions(options);

  // Update tasks
  return await bulkService.updateTasks(tasks, bulkOptions);
}

/**
 * Handler for moving multiple tasks
 */
export async function moveBulkTasksHandler(params: any) {
  const { tasks, targetListId, targetListName, options } = params;

  // Validate tasks array
  validateBulkTasks(tasks, 'move');

  // Validate and resolve target list ID
  const resolvedTargetListId = await resolveListIdWithValidation(targetListId, targetListName);

  // Parse bulk options
  const bulkOptions = parseBulkOptions(options);

  // Move tasks
  return await bulkService.moveTasks(tasks, resolvedTargetListId, bulkOptions);
}

/**
 * Handler for deleting multiple tasks
 */
export async function deleteBulkTasksHandler(params: any) {
  const { tasks, options } = params;

  // Validate tasks array
  validateBulkTasks(tasks, 'delete');

  // Parse bulk options
  const bulkOptions = parseBulkOptions(options);

  // Delete tasks
  return await bulkService.deleteTasks(tasks, bulkOptions);
}

/**
 * Handler for deleting a task
 */
export async function deleteTaskHandler(params) {
  const taskId = await getTaskId(params.taskId, params.taskName, params.listName);
  await taskService.deleteTask(taskId);
  return true;
}
