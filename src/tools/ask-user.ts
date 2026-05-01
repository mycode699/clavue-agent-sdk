/**
 * AskUserQuestionTool - Interactive user questions
 *
 * In SDK mode, returns a permission_request event and waits
 * for the consumer to provide an answer.
 * In non-interactive mode, returns a default or denies.
 */

import type { PendingInputAnswer, PendingInputQuestion, ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

type StructuredQuestionHandler = (
  question: PendingInputQuestion,
  options?: string[],
) => Promise<string | string[] | PendingInputAnswer>

type LegacyQuestionHandler = (
  question: string,
  options?: string[],
) => Promise<string | string[] | PendingInputAnswer>

type QuestionHandler = StructuredQuestionHandler | LegacyQuestionHandler

function normalizePendingAnswer(answer: string | string[] | PendingInputAnswer): string {
  if (typeof answer === 'string') return answer
  if (Array.isArray(answer)) return answer.join(', ')
  if (Array.isArray(answer.value)) return answer.value.join(', ')
  return answer.value
}

function normalizePendingQuestion(input: any): PendingInputQuestion {
  const timeoutMs = typeof input.timeout_ms === 'number' && Number.isFinite(input.timeout_ms)
    ? input.timeout_ms
    : undefined

  return {
    id: `pending_input_${crypto.randomUUID()}`,
    prompt: String(input.question ?? ''),
    options: Array.isArray(input.options)
      ? input.options.filter((option: unknown): option is string => typeof option === 'string')
      : undefined,
    allow_multiselect: input.allow_multiselect === true,
    default_behavior: 'continue_without_answer',
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
  }
}

const questionHandlerNamespaces = new Map<string, { handler: QuestionHandler; structured: boolean }>()

function getQuestionHandler(context?: RuntimeNamespaceContext): { handler: QuestionHandler; structured: boolean } | undefined {
  return questionHandlerNamespaces.get(getRuntimeNamespace(context))
}

/**
 * Set the question handler for AskUserQuestion.
 */
export function setQuestionHandler(
  handler: LegacyQuestionHandler,
  context?: RuntimeNamespaceContext,
): void {
  questionHandlerNamespaces.set(getRuntimeNamespace(context), {
    handler,
    structured: false,
  })
}

/**
 * Set a structured pending input handler for AskUserQuestion.
 */
export function setPendingInputHandler(
  handler: StructuredQuestionHandler,
  context?: RuntimeNamespaceContext,
): void {
  questionHandlerNamespaces.set(getRuntimeNamespace(context), {
    handler,
    structured: true,
  })
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
      timeout_ms: {
        type: 'number',
        description: 'Optional timeout in milliseconds for the pending user input',
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
    const pendingInput = normalizePendingQuestion(input)
    const questionHandler = getQuestionHandler(context)
    if (questionHandler) {
      try {
        const answer = questionHandler.structured
          ? await (questionHandler.handler as StructuredQuestionHandler)(pendingInput, pendingInput.options)
          : await (questionHandler.handler as LegacyQuestionHandler)(pendingInput.prompt, pendingInput.options)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: normalizePendingAnswer(answer),
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
      content: `[Non-interactive mode] Question: ${pendingInput.prompt}${pendingInput.options ? `\nOptions: ${pendingInput.options.join(', ')}` : ''}\n\nNo user available to answer. Proceeding with best judgment.`,
      pending_input: pendingInput,
    }
  },
}
