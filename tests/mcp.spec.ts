import { describe, expect, it } from 'vitest'
import { mapMcpServers, toServerName, type AcpMcpServer } from '../src/mcp.ts'

describe('server names', () => {
  it('passes a name the plugin already accepts through untouched', () => {
    // smelt sends exactly this name for its agent bus, so the identity case is
    // the one that must never drift.
    expect(toServerName('smelt')).toBe('smelt')
  })

  it('coerces characters outside the plugin alphabet', () => {
    expect(toServerName('my server.v2')).toBe('my_server_v2')
  })

  it('truncates to the plugin budget', () => {
    expect(toServerName('a'.repeat(40))).toBe('a'.repeat(32))
  })

  it('is deterministic, so a resumed transcript still matches live tool names', () => {
    expect(toServerName('a b/c')).toBe(toServerName('a b/c'))
  })

  it('refuses a name with nothing left to coerce', () => {
    expect(toServerName('')).toBeUndefined()
  })
})

describe('mapping session servers', () => {
  it('maps the untagged variant to a stdio child inheriting the session cwd', () => {
    const servers: AcpMcpServer[] = [{
      name: 'smelt',
      command: '/usr/local/bin/smelt-mcp',
      args: ['--stdio'],
      env: [{ name: 'SMELT_TOKEN', value: 'abc' }],
    }]
    const { mounted, rejected } = mapMcpServers(servers, '/workspace')
    expect(rejected).toEqual([])
    expect(mounted).toEqual([{
      transport: 'stdio',
      serverName: 'smelt',
      command: '/usr/local/bin/smelt-mcp',
      args: ['--stdio'],
      env: { SMELT_TOKEN: 'abc' },
      cwd: '/workspace',
    }])
  })

  it('defaults absent args and env rather than passing undefined on', () => {
    const { mounted } = mapMcpServers([{ name: 'bus', command: 'bus' }], '/w')
    expect(mounted[0]).toMatchObject({ args: [], env: {} })
  })

  it('maps http to the streamable-http transport with collapsed headers', () => {
    const servers: AcpMcpServer[] = [{
      name: 'remote',
      type: 'http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    }]
    const { mounted } = mapMcpServers(servers, '/workspace')
    expect(mounted).toEqual([{
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t' },
    }])
  })

  it('skips a transport the harness client cannot speak, keeping the rest', () => {
    const servers: AcpMcpServer[] = [
      { name: 'legacy', type: 'sse', url: 'https://example.test/sse' },
      { name: 'smelt', command: 'bus' },
    ]
    const { mounted, rejected } = mapMcpServers(servers, '/workspace')
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ serverName: 'smelt' })
    expect(rejected).toEqual([{ name: 'legacy', reason: 'unsupported transport sse' }])
  })

  it('skips an acp-transport server', () => {
    const { mounted, rejected } = mapMcpServers([{ name: 'peer', type: 'acp' }], '/w')
    expect(mounted).toEqual([])
    expect(rejected[0]?.reason).toBe('unsupported transport acp')
  })

  it('drops a collision instead of letting it fail the whole agent scope', () => {
    // The plugin treats a duplicate namespace as a load-time error, which would
    // take down the session rather than one server.
    const servers: AcpMcpServer[] = [
      { name: 'a.b', command: 'first' },
      { name: 'a/b', command: 'second' },
    ]
    const { mounted, rejected } = mapMcpServers(servers, '/w')
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ command: 'first' })
    expect(rejected).toEqual([{ name: 'a/b', reason: 'duplicate namespace a_b' }])
  })

  it('reports a name it cannot coerce', () => {
    const { mounted, rejected } = mapMcpServers([{ name: '', command: 'x' }], '/w')
    expect(mounted).toEqual([])
    expect(rejected[0]?.reason).toBe('name has no valid mcp-client namespace')
  })

  it('maps an empty list to nothing at all', () => {
    expect(mapMcpServers([], '/w')).toEqual({ mounted: [], rejected: [] })
  })
})
