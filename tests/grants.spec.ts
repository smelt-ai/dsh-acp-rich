import { describe, expect, it } from 'vitest'
import { GrantStore, interpretPermission, PERMISSION_OPTIONS } from '../src/grants.ts'

describe('PERMISSION_OPTIONS', () => {
  it('offers both one-shot and standing decisions in both directions', () => {
    expect(PERMISSION_OPTIONS.map(option => option.kind)).toEqual([
      'allow_once', 'allow_always', 'reject_once', 'reject_always',
    ])
  })

  it('states the exact scope of a standing decision in the label', () => {
    // The store keys grants by tool name within one session; a label promising
    // less (or more) than that is the bug this asserts against.
    const always = PERMISSION_OPTIONS.find(option => option.kind === 'allow_always')
    expect(always?.name).toContain('tool')
    expect(always?.name).toContain('session')
  })
})

describe('interpretPermission', () => {
  it('grants once without remembering', () => {
    expect(interpretPermission({ outcome: 'selected', optionId: 'allow-once' }))
      .toEqual({ outcome: 'allowed-once' })
  })

  it('grants once AND remembers when the user chose always', () => {
    // The harness has no durable grant, so even an "always" answer still
    // returns its one-shot outcome; the memory lives on this side.
    expect(interpretPermission({ outcome: 'selected', optionId: 'allow-always' }))
      .toEqual({ outcome: 'allowed-once', remember: 'allowed' })
  })

  it('remembers a standing rejection', () => {
    expect(interpretPermission({ outcome: 'selected', optionId: 'reject-always' }))
      .toEqual({ outcome: 'rejected', remember: 'rejected' })
  })

  it('propagates a withdrawn question', () => {
    expect(interpretPermission({ outcome: 'cancelled' })).toEqual({ outcome: 'cancelled' })
  })

  it('fails closed on an option this bridge never offered', () => {
    expect(interpretPermission({ outcome: 'selected', optionId: 'allow-forever-everywhere' }))
      .toEqual({ outcome: 'rejected' })
  })
})

describe('GrantStore', () => {
  it('answers a later request for the same tool in the same session', () => {
    const store = new GrantStore()
    store.remember('s1', 'bash', 'allowed')
    expect(store.lookup('s1', 'bash')).toBe('allowed')
  })

  it('never leaks a decision across tools or sessions', () => {
    const store = new GrantStore()
    store.remember('s1', 'bash', 'allowed')
    expect(store.lookup('s1', 'write')).toBeUndefined()
    expect(store.lookup('s2', 'bash')).toBeUndefined()
  })

  it('lets a later decision supersede an earlier one', () => {
    const store = new GrantStore()
    store.remember('s1', 'bash', 'allowed')
    store.remember('s1', 'bash', 'rejected')
    expect(store.lookup('s1', 'bash')).toBe('rejected')
  })

  it('drops one session\u2019s decisions without touching another\u2019s', () => {
    const store = new GrantStore()
    store.remember('s1', 'bash', 'allowed')
    store.remember('s2', 'bash', 'allowed')
    store.forget('s1')
    expect(store.lookup('s1', 'bash')).toBeUndefined()
    expect(store.lookup('s2', 'bash')).toBe('allowed')
  })

  it('clears everything on bridge teardown', () => {
    const store = new GrantStore()
    store.remember('s1', 'bash', 'allowed')
    store.clear()
    expect(store.lookup('s1', 'bash')).toBeUndefined()
  })
})
