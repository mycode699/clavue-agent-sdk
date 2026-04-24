#!/usr/bin/env node
import { query, run } from './agent.js'
import type { AgentOptions } from './types.js'
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
  --deny <tools>            Comma-separated deny-list, e.g. Bash,Write,Edit
  --json                    Print the final run artifact as JSON
  -h, --help                Show this help

Environment:
  CLAVUE_AGENT_API_KEY      API key
  CLAVUE_AGENT_API_TYPE     anthropic-messages or openai-completions
  CLAVUE_AGENT_MODEL        Default model
  CLAVUE_AGENT_BASE_URL     Custom API endpoint
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

function parseArgs(argv: string[]): { prompt: string; options: AgentOptions; json: boolean; help: boolean } {
  const options: AgentOptions = {}
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
      case '--deny':
        options.disallowedTools = parseCommaSeparatedList(readValue(argv, i, arg))
        i++
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

  if (parsed.json) {
    const result = await run({ prompt: parsed.prompt, options: parsed.options })
    console.log(JSON.stringify(result, null, 2))
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
