/**
 * Example 22: Capability Tokens (v3.2 prototype)
 *
 * Mint per-resource, expiring, use-limited grants. Show the 4 deny reasons
 * the registry distinguishes — peer SDKs only have a coarse `permissionMode`
 * + per-call hook; tokens give per-call, per-resource decisions traceable to
 * a specific grant id.
 *
 * No real LLM call. Run:
 *
 *   npx tsx examples/22-capability-tokens.ts
 *
 * @module
 */

import { CapabilityRegistry } from '../src/index.js'

function show(label: string, fn: () => unknown): void {
  console.log(`  ${label.padEnd(28)} → ${JSON.stringify(fn())}`)
}

async function main() {
  console.log('--- Example 22: Capability Tokens ---\n')

  const reg = new CapabilityRegistry()

  // Mint a few realistic grants ----------------------------------------------
  const readSrc = reg.mint({
    capability: 'fs.read',
    resource: 'file:///repo/src/**',
    meta: { issuedTo: 'planner' },
  })
  reg.mint({
    capability: 'fs.write',
    resource: 'file:///repo/dist/**',
    maxUses: 3,
    meta: { issuedTo: 'builder' },
  })
  reg.mint({
    capability: 'net.fetch',
    resource: 'https://api.github.com/**',
    expiresAt: Date.now() + 60_000,
    meta: { issuedTo: 'researcher' },
  })

  console.log(`minted ${reg.size()} tokens. fresh list:`)
  for (const t of reg.list()) {
    console.log(`  ${t.id}  ${t.capability.padEnd(10)}  ${t.resource}`)
  }

  // 1. Allow path -----------------------------------------------------------
  console.log('\n1. allow within scope')
  show('read src/index.ts', () => reg.check('fs.read', 'file:///repo/src/index.ts'))
  show('read src/a/b/c.ts', () => reg.check('fs.read', 'file:///repo/src/a/b/c.ts'))

  // 2. resource_mismatch ----------------------------------------------------
  console.log('\n2. resource_mismatch (right capability, wrong path)')
  show('read /etc/passwd', () => reg.check('fs.read', 'file:///etc/passwd'))

  // 3. capability_mismatch --------------------------------------------------
  console.log('\n3. capability_mismatch (no token has this capability)')
  show('exec /bin/sh', () => reg.check('proc.exec', 'cmd:/bin/sh'))

  // 4. exhausted ------------------------------------------------------------
  console.log('\n4. exhausted (maxUses=3 budget runs out)')
  show('write dist/a.js  #1', () => reg.check('fs.write', 'file:///repo/dist/a.js'))
  show('write dist/b.js  #2', () => reg.check('fs.write', 'file:///repo/dist/b.js'))
  show('write dist/c.js  #3', () => reg.check('fs.write', 'file:///repo/dist/c.js'))
  show('write dist/d.js  #4', () => reg.check('fs.write', 'file:///repo/dist/d.js'))

  // 5. expired --------------------------------------------------------------
  console.log('\n5. expired')
  reg.mint({
    capability: 'cache.read',
    resource: 'mem://**',
    expiresAt: Date.now() - 5,
  })
  show('cache lookup', () => reg.check('cache.read', 'mem://session-1'))

  // 6. revoke ---------------------------------------------------------------
  console.log('\n6. revoke')
  console.log(`  revoking ${readSrc.id} …`)
  reg.revoke(readSrc.id)
  show('read src/index.ts (post-revoke)', () =>
    reg.check('fs.read', 'file:///repo/src/index.ts'),
  )

  console.log('\n— done —')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
