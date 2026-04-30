/**
 * AskUserQuestionTool - Interactive user questions
 *
 * In SDK mode, returns a permission_request event and waits
 * for the consumer to provide an answer.
 * In non-interactive mode, returns a default or denies.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

type QuestionHandler = (question: string, options?: string[]) => Promise<string>

const questionHandlerNamespaces = new Map<string, QuestionHandler>()

function getQuestionHandler(context?: RuntimeNamespaceContext): QuestionHandler | undefined {
  return questionHandlerNamespaces.get(getRuntimeNamespace(context))
}

/**
 * Set the question handler for AskUserQuestion.
 */
export function setQuestionHandler(
  handler: QuestionHandler,
  context?: RuntimeNamespaceContext,
): void {
  questionHandlerNamespaces.set(getRuntimeNamespace(context), handler)
}

/**
 * Clear the question handler.
 */
export function clearQuestionHandler(context?: RuntimeNamespaceContext): void {
  const namespace = getRuntimeNamespace(context)
  if (namespace === 'default') {
    questionHandlerNamespaces.clear()
    return
  }
  questionHandlerNamespaces.delete(namespace)
}

export const AskUserQuestionTool: ToolDefinition = {
  name: 'AskUserQuestion',
  description: 'Ask the user a question and wait for their response. Use when you need clarification or input from the user.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of choices for the user',
      },
      allow_multiselect: {
        type: 'boolean',
        description: 'Whether to allow multiple selections (for options)',
      },
    },
    required: ['question'],
  },
  safety: {
    read: true,
    externalState: true,
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Ask the user a question.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const questionHandler = getQuestionHandler(context)
    if (questionHandler) {
      try {
        const answer = await questionHandler(input.question, input.options)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: answer,
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `User declined to answer: ${err.message}`,
          is_error: true,
        }
      }
    }

    // Non-interactive: return informative message
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `[Non-interactive mode] Question: ${input.question}${input.options ? `\nOptions: ${input.options.join(', ')}` : ''}\n\nNo user available to answer. Proceeding with best judgment.`,
    }
  },
}
