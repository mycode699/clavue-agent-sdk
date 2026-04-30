/**
 * SendMessageTool - Inter-agent messaging
 *
 * Supports plain text and structured protocol messages
 * between teammates in a multi-agent setup.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

/**
 * Message inbox for inter-agent communication.
 */
export interface AgentMessage {
  from: string
  to: string
  content: string
  timestamp: string
  type: 'text' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response'
}

const mailboxNamespaces = new Map<string, Map<string, AgentMessage[]>>()

function getMailboxes(context?: RuntimeNamespaceContext): Map<string, AgentMessage[]> {
  const namespace = getRuntimeNamespace(context)
  let mailboxes = mailboxNamespaces.get(namespace)
  if (!mailboxes) {
    mailboxes = new Map()
    mailboxNamespaces.set(namespace, mailboxes)
  }
  return mailboxes
}

/**
 * Read messages from a mailbox.
 */
export function readMailbox(agentName: string, context?: RuntimeNamespaceContext): AgentMessage[] {
  const mailboxes = getMailboxes(context)
  const messages = mailboxes.get(agentName) || []
  mailboxes.set(agentName, []) // Clear after reading
  return messages
}

/**
 * Write to a mailbox.
 */
export function writeToMailbox(
  agentName: string,
  message: AgentMessage,
  context?: RuntimeNamespaceContext,
): void {
  const mailboxes = getMailboxes(context)
  const messages = mailboxes.get(agentName) || []
  messages.push(message)
  mailboxes.set(agentName, messages)
}

/**
 * Clear all mailboxes.
 */
export function clearMailboxes(context?: RuntimeNamespaceContext): void {
  const namespace = getRuntimeNamespace(context)
  if (namespace === 'default') {
    mailboxNamespaces.clear()
    return
  }
  mailboxNamespaces.delete(namespace)
}

export const SendMessageTool: ToolDefinition = {
  name: 'SendMessage',
  description: 'Send a message to another agent or teammate. Supports plain text and structured protocol messages.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient agent name or ID. Use "*" for broadcast.' },
      content: { type: 'string', description: 'Message content' },
      type: {
        type: 'string',
        enum: ['text', 'shutdown_request', 'shutdown_response', 'plan_approval_response'],
        description: 'Message type (default: text)',
      },
    },
    required: ['to', 'content'],
  },
  safety: {
    write: true,
    externalState: true,
    approvalRequired: true,
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Send a message to another agent.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const message: AgentMessage = {
      from: 'self',
      to: input.to,
      content: input.content,
      timestamp: new Date().toISOString(),
      type: input.type || 'text',
    }

    if (input.to === '*') {
      // Broadcast to all known mailboxes
      const mailboxes = getMailboxes(context)
      for (const [name] of mailboxes) {
        writeToMailbox(name, { ...message, to: name }, context)
      }
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Message broadcast to all agents`,
      }
    }

    writeToMailbox(input.to, message, context)
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Message sent to ${input.to}`,
    }
  },
}
