import test from 'node:test'
import assert from 'node:assert/strict'

import {
  composeMiddleware,
  createMiddlewareContext,
  type Middleware,
  type MiddlewareContext,
} from '../src/middleware/index.ts'

// ---------------------------------------------------------------------------
// composeMiddleware — pure runtime, no Agent / engine dependency
// ---------------------------------------------------------------------------

test('composeMiddleware runs middlewares in registration order around core', async () => {
  const order: string[] = []
  const a: Middleware = async (_ctx, next) => {
    order.push('a:before')
    await next()
    order.push('a:after')
  }
  const b: Middleware = async (_ctx, next) => {
    order.push('b:before')
    await next()
    order.push('b:after')
  }
  const dispatch = composeMiddleware([a, b])
  const ctx = createMiddlewareContext('hi')
  await dispatch(ctx, async () => {
    order.push('core')
  })
  assert.deepEqual(order, [
    'a:before',
    'b:before',
    'core',
    'b:after',
    'a:after',
  ])
})

test('composeMiddleware short-circuits when a middleware skips next()', async () => {
  let coreRan = false
  const a: Middleware = async (ctx) => {
    ctx.metadata['short_circuited'] = true
    // intentionally do not call next()
  }
  const dispatch = composeMiddleware([a])
  const ctx = createMiddlewareContext('hi')
  await dispatch(ctx, async () => {
    coreRan = true
  })
  assert.equal(coreRan, false)
  assert.equal(ctx.metadata['short_circuited'], true)
})

test('composeMiddleware throws if next() is called twice in the same middleware', async () => {
  const bad: Middleware = async (_ctx, next) => {
    await next()
    await next()
  }
  const dispatch = composeMiddleware([bad])
  const ctx = createMiddlewareContext('hi')
  await assert.rejects(
    () =>
      dispatch(ctx, async () => {
        /* core */
      }),
    /next\(\) called multiple times/i,
  )
})

test('composeMiddleware propagates errors from core through the chain', async () => {
  const seen: string[] = []
  const wrap: Middleware = async (_ctx, next) => {
    try {
      await next()
    } catch (err) {
      seen.push(`caught:${(err as Error).message}`)
      throw err
    }
  }
  const dispatch = composeMiddleware([wrap])
  const ctx = createMiddlewareContext('hi')
  await assert.rejects(
    () =>
      dispatch(ctx, async () => {
        throw new Error('boom')
      }),
    /boom/,
  )
  assert.deepEqual(seen, ['caught:boom'])
})

test('composeMiddleware lets middleware mutate prompt + options before next()', async () => {
  const observed: { prompt: string; opts: unknown } = { prompt: '', opts: undefined }
  const inject: Middleware = async (ctx, next) => {
    ctx.prompt = ctx.prompt + ' [tagged]'
    ctx.options.maxTurns = 1
    await next()
  }
  const dispatch = composeMiddleware([inject])
  const ctx = createMiddlewareContext('hello')
  await dispatch(ctx, async (mwCtx: MiddlewareContext) => {
    observed.prompt = mwCtx.prompt
    observed.opts = mwCtx.options.maxTurns
  })
  assert.equal(observed.prompt, 'hello [tagged]')
  assert.equal(observed.opts, 1)
})

test('composeMiddleware with empty array still runs core', async () => {
  let ran = false
  const dispatch = composeMiddleware([])
  const ctx = createMiddlewareContext('hi')
  await dispatch(ctx, async () => {
    ran = true
  })
  assert.equal(ran, true)
})

// ---------------------------------------------------------------------------
// Built-in patterns expressed as middleware
// (rate-limit, audit-log, PII-redact) — these are the v3 spec requirements
// ---------------------------------------------------------------------------

test('rate-limit middleware: rejects when budget exhausted', async () => {
  let remaining = 1
  const rateLimit: Middleware = async (ctx, next) => {
    if (remaining <= 0) {
      ctx.metadata['rejected'] = 'rate_limit'
      return // skip next()
    }
    remaining -= 1
    await next()
  }
  const dispatch = composeMiddleware([rateLimit])

  let coreCalls = 0
  const core = async () => {
    coreCalls += 1
  }

  const ctx1 = createMiddlewareContext('first')
  await dispatch(ctx1, core)
  const ctx2 = createMiddlewareContext('second')
  await dispatch(ctx2, core)

  assert.equal(coreCalls, 1)
  assert.equal(ctx1.metadata['rejected'], undefined)
  assert.equal(ctx2.metadata['rejected'], 'rate_limit')
})

test('audit-log middleware: records timing + success', async () => {
  const audit: Array<{ ok: boolean; ms: number }> = []
  const auditMw: Middleware = async (ctx, next) => {
    const t0 = Date.now()
    let ok = true
    try {
      await next()
    } catch (err) {
      ok = false
      throw err
    } finally {
      audit.push({ ok, ms: Date.now() - t0 })
    }
  }
  const dispatch = composeMiddleware([auditMw])
  const ctx = createMiddlewareContext('hi')
  await dispatch(ctx, async () => {
    /* core ran */
  })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].ok, true)
  assert.ok(audit[0].ms >= 0)
})

test('PII-redact middleware: rewrites prompt before core', async () => {
  const observed: string[] = []
  const redact: Middleware = async (ctx, next) => {
    ctx.prompt = ctx.prompt.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]')
    await next()
  }
  const dispatch = composeMiddleware([redact])
  const ctx = createMiddlewareContext('My SSN is 123-45-6789, please help.')
  await dispatch(ctx, async (mwCtx: MiddlewareContext) => {
    observed.push(mwCtx.prompt)
  })
  assert.equal(observed[0], 'My SSN is [SSN], please help.')
})

test('cross-middleware metadata communication via ctx.metadata', async () => {
  const tag: Middleware = async (ctx, next) => {
    ctx.metadata['traceId'] = 'abc-123'
    await next()
  }
  const consume: Middleware = async (ctx, next) => {
    ctx.metadata['observed_traceId'] = ctx.metadata['traceId']
    await next()
  }
  const dispatch = composeMiddleware([tag, consume])
  const ctx = createMiddlewareContext('hi')
  await dispatch(ctx, async () => {
    /* core */
  })
  assert.equal(ctx.metadata['traceId'], 'abc-123')
  assert.equal(ctx.metadata['observed_traceId'], 'abc-123')
})

// ---------------------------------------------------------------------------
// Agent.use() integration — type-only smoke test (no live LLM)
// ---------------------------------------------------------------------------

test('Agent.use() returns the agent for chaining and stores middleware', async () => {
  const { Agent } = await import('../src/agent.ts')
  // Constructing without API keys is safe; setup() lazily resolves.
  const agent = new Agent({ apiKey: 'sk-test', model: 'gpt-4o-mini' })
  const noop: Middleware = async (_ctx, next) => {
    await next()
  }
  const ret = agent.use(noop)
  assert.equal(ret, agent)
})

test('Agent.use() rejects non-function middlewares', async () => {
  const { Agent } = await import('../src/agent.ts')
  const agent = new Agent({ apiKey: 'sk-test', model: 'gpt-4o-mini' })
  assert.throws(() => agent.use(undefined as unknown as Middleware), TypeError)
  assert.throws(() => agent.use(42 as unknown as Middleware), TypeError)
})
