#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

import { query, run } from './agent.js'
import type { AgentOptions, ToolsetName } from './types.js'
import { isToolsetName } from './tools/index.js'
import { parseCommaSeparatedList } from './utils/parsing.js'

function printHelp(): void {
  console.log(`Clavue Agent SDK CLI

Usage:
  npx clavue-agent-sdk "Read package.json and summarize it"
  npx clavue-agent-sdk --prompt "Review src for obvious bugs" --allow Read,Glob,Grep

Options:
  -p, --prompt <text>       Prompt to send to the agent
  -m, --model <id>          Model ID (defaults to CLAVUE_AGENT_MODEL or claude-sonnet-4-6)
  --api-type <type>         anthropic-messages or openai-completions
  --api-key <key>           API key (defaults to CLAVUE_AGENT_API_KEY)
  --base-url <url>          API base URL (defaults to CLAVUE_AGENT_BASE_URL)
  --cwd <path>              Working directory (defaults to current directory)
  --max-turns <number>      Maximum agentic turns (default: 10)
  --allow <tools>           Comma-separated allow-list, e.g. Read,Glob,Grep
  --toolset <names>         Comma-separated toolsets, e.g. repo-readonly,research
  --deny <tools>            Comma-separated deny-list, e.g. Bash,Write,Edit
  --self-improvement        Save bounded improvement memories after the run
  --json                    Print the final run artifact as JSON
  -h, --help                Show this help

Environment:
  CLAVUE_AGENT_API_KEY      API key
  CLAVUE_AGENT_API_TYPE     anthropic-messages or openai-completions
  CLAVUE_AGENT_MODEL        Default model
  CLAVUE_AGENT_BASE_URL     Custom API endpoint
  CLAVUE_AGENT_SELF_IMPROVEMENT  Set to 1/true/yes to enable run learning
`)
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function readApiType(value: string): AgentOptions['apiType'] {
  if (value === 'anthropic-messages' || value === 'openai-completions') {
    return value
  }
  throw new Error('--api-type must be anthropic-messages or openai-completions')
}

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function readToolsets(value: string): ToolsetName[] {
  const toolsets: ToolsetName[] = []
  for (const toolset of parseCommaSeparatedList(value)) {
    if (!isToolsetName(toolset)) {
      throw new Error(`Unknown toolset: ${toolset}`)
    }
    toolsets.push(toolset)
  }
  return toolsets
}

function applySelfImprovementDefaults(options: AgentOptions): void {
  if (!options.selfImprovement) return

  options.memory = {
    ...options.memory,
    enabled: true,
    autoInject: options.memory?.autoInject ?? true,
    repoPath: options.memory?.repoPath || options.cwd || process.cwd(),
  }
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): { prompt: string; options: AgentOptions; json: boolean; help: boolean } {
  const options: AgentOptions = {
    selfImprovement: envFlagEnabled(env.CLAVUE_AGENT_SELF_IMPROVEMENT) || undefined,
  }
  const promptParts: string[] = []
  let json = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    switch (arg) {
      case '-h':
      case '--help':
        help = true
        break
      case '-p':
      case '--prompt':
        promptParts.push(readValue(argv, i, arg))
        i++
        break
      case '-m':
      case '--model':
        options.model = readValue(argv, i, arg)
        i++
        break
      case '--api-type':
        options.apiType = readApiType(readValue(argv, i, arg))
        i++
        break
      case '--api-key':
        options.apiKey = readValue(argv, i, arg)
        i++
        break
      case '--base-url':
        options.baseURL = readValue(argv, i, arg)
        i++
        break
      case '--cwd':
        options.cwd = readValue(argv, i, arg)
        i++
        break
      case '--max-turns': {
        const value = Number(readValue(argv, i, arg))
        if (!Number.isInteger(value) || value < 1) {
          throw new Error('--max-turns must be a positive integer')
        }
        options.maxTurns = value
        i++
        break
      }
      case '--allow':
        options.allowedTools = parseCommaSeparatedList(readValue(argv, i, arg))
        i++
        break
      case '--toolset':
        options.toolsets = readToolsets(readValue(argv, i, arg))
        i++
        break
      case '--deny':
        options.disallowedTools = parseCommaSeparatedList(readValue(argv, i, arg))
        i++
        break
      case '--self-improvement':
        options.selfImprovement = true
        break
      case '--json':
        json = true
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`)
        }
        promptParts.push(arg)
        break
    }
  }

  applySelfImprovementDefaults(options)

  return {
    prompt: promptParts.join(' ').trim(),
    options,
    json,
    help,
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.help || !parsed.prompt) {
    printHelp()
    process.exitCode = parsed.help ? 0 : 1
    return
  }

  if (parsed.json || parsed.options.selfImprovement) {
    const result = await run({ prompt: parsed.prompt, options: parsed.options })
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (result.text) console.log(result.text)
      const savedCount = result.self_improvement?.savedMemories.length ?? 0
      console.error(`[self-improvement] saved ${savedCount} improvement memor${savedCount === 1 ? 'y' : 'ies'}`)
      if (result.self_improvement?.errors?.length) {
        console.error(`[self-improvement] ${result.self_improvement.errors.join('; ')}`)
      }
    }
    process.exitCode = result.status === 'completed' ? 0 : 1
    return
  }

  for await (const event of query({ prompt: parsed.prompt, options: parsed.options })) {
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          console.error(`[tool] ${block.name}`)
        } else if (block.type === 'text') {
          process.stdout.write(block.text)
          if (!block.text.endsWith('\n')) process.stdout.write('\n')
        }
      }
    } else if (event.type === 'result' && event.is_error) {
      console.error(`Run ended with ${event.subtype}`)
      process.exitCode = 1
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
