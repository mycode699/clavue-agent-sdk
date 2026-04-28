/**
 * TodoWriteTool - Session todo/checklist management
 *
 * Manages a session-scoped todo list for tracking work items.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

export interface TodoItem {
  id: number
  text: string
  done: boolean
  priority?: 'high' | 'medium' | 'low'
}

interface TodoNamespaceState {
  list: TodoItem[]
  counter: number
}

const todoNamespaces = new Map<string, TodoNamespaceState>()

function getTodoState(context?: RuntimeNamespaceContext): TodoNamespaceState {
  const namespace = getRuntimeNamespace(context)
  let state = todoNamespaces.get(namespace)
  if (!state) {
    state = { list: [], counter: 0 }
    todoNamespaces.set(namespace, state)
  }
  return state
}

/**
 * Get all todos.
 */
export function getTodos(context?: RuntimeNamespaceContext): TodoItem[] {
  return [...getTodoState(context).list]
}

/**
 * Clear all todos.
 */
export function clearTodos(context?: RuntimeNamespaceContext): void {
  const namespace = getRuntimeNamespace(context)
  if (namespace === 'default') {
    todoNamespaces.clear()
    return
  }
  todoNamespaces.delete(namespace)
}

export const TodoWriteTool: ToolDefinition = {
  name: 'TodoWrite',
  description: 'Manage a session todo/checklist. Supports add, toggle, remove, and list operations.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'toggle', 'remove', 'list', 'clear'],
        description: 'Operation to perform',
      },
      text: { type: 'string', description: 'Todo item text (for add)' },
      id: { type: 'number', description: 'Todo item ID (for toggle/remove)' },
      priority: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Priority level (for add)',
      },
    },
    required: ['action'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Manage session todo list.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getTodoState(context)
    switch (input.action) {
      case 'add': {
        if (!input.text) {
          return { type: 'tool_result', tool_use_id: '', content: 'text required', is_error: true }
        }
        const item: TodoItem = {
          id: ++state.counter,
          text: input.text,
          done: false,
          priority: input.priority,
        }
        state.list.push(item)
        return { type: 'tool_result', tool_use_id: '', content: `Todo added: #${item.id} "${item.text}"` }
      }

      case 'toggle': {
        const item = state.list.find(t => t.id === input.id)
        if (!item) {
          return { type: 'tool_result', tool_use_id: '', content: `Todo #${input.id} not found`, is_error: true }
        }
        item.done = !item.done
        return { type: 'tool_result', tool_use_id: '', content: `Todo #${item.id} ${item.done ? 'completed' : 'reopened'}` }
      }

      case 'remove': {
        const idx = state.list.findIndex(t => t.id === input.id)
        if (idx === -1) {
          return { type: 'tool_result', tool_use_id: '', content: `Todo #${input.id} not found`, is_error: true }
        }
        state.list.splice(idx, 1)
        return { type: 'tool_result', tool_use_id: '', content: `Todo #${input.id} removed` }
      }

      case 'list': {
        if (state.list.length === 0) {
          return { type: 'tool_result', tool_use_id: '', content: 'No todos.' }
        }
        const lines = state.list.map(t =>
          `${t.done ? '[x]' : '[ ]'} #${t.id} ${t.text}${t.priority ? ` (${t.priority})` : ''}`
        )
        return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
      }

      case 'clear': {
        state.list.length = 0
        return { type: 'tool_result', tool_use_id: '', content: 'All todos cleared.' }
      }

      default:
        return { type: 'tool_result', tool_use_id: '', content: `Unknown action: ${input.action}`, is_error: true }
    }
  },
}
