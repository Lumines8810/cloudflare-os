// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import AddModelModal from './AddModelModal'

vi.mock('@cloudflare/kumo', async () => {
  const { createContext, useContext } = await import('react')
  const select = createContext<(value: string) => void>(() => {})
  const Panel = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return {
    Dialog: Object.assign(Panel, { Root: Panel, Title: Panel,
      Close: () => null }),
    Select: Object.assign(({ children, onValueChange }: {
      children: ReactNode; onValueChange: (value: string) => void
    }) => <select.Provider value={onValueChange}>{children}</select.Provider>, {
      Option: ({ value, children }: { value: string; children: ReactNode }) => {
        const choose = useContext(select)
        return <button onClick={() => choose(value)}>{children}</button>
      },
    }),
    Button: ({ children, onClick, disabled }: ComponentProps<'button'>) =>
      <button disabled={disabled} onClick={onClick}>{children}</button>,
    Input: ({ label, ...props }: ComponentProps<'input'> & { label: string }) =>
      <input aria-label={label} value={props.value} onChange={props.onChange} />,
    SensitiveInput: ({ label, value, onValueChange }: {
      label: string; value: string; onValueChange: (value: string) => void
    }) => <input aria-label={label} value={value} onChange={event => onValueChange(event.target.value)} />,
    Collapsible: { Root: Panel, DefaultTrigger: Panel, DefaultPanel: Panel },
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

let root: Root
let container: HTMLDivElement
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.useRealTimers()
})

async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}

async function mount(connected: boolean) {
  const api = {
    isChatgptConnected: vi.fn<AuthenticatedApi["isChatgptConnected"]>(async () => connected),
    startChatgptLogin: vi.fn<AuthenticatedApi["startChatgptLogin"]>(async () => ({ loginId: 'attempt', userCode: 'CODE-1234',
      verificationUri: 'https://auth.openai.com/codex/device', intervalMs: 5000,
      expiresAt: Date.now() + 900000 })),
    pollChatgptLogin: vi.fn<AuthenticatedApi["pollChatgptLogin"]>(async () => true),
    disconnectChatgpt: vi.fn<AuthenticatedApi["disconnectChatgpt"]>(async () => {}),
    addModel: vi.fn<AuthenticatedApi["addModel"]>(async () => {}),
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<AddModelModal visible onCancel={vi.fn<() => void>()} onSuccess={vi.fn<() => void>()}
    authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}
    aiConfig={{ enabled: true, enabledProviders: ['cloudflare'] }} />))
  return api
}

describe('LLM connection selection', () => {
  it('offers API keys even when the deployment gateway only enables Cloudflare', async () => {
    const api = await mount(false)
    await click('OpenAI API key · usage-based billing')
    await click('GPT 5.6 Sol')
    const input = container.querySelector<HTMLInputElement>('input[aria-label="API Token"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'existing-test-key')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Add Model')
    expect(api.addModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai:apiKey:gpt-5.6-sol' }),
      expect.objectContaining({ authMode: 'apiKey', apiToken: 'existing-test-key', provider: 'openai' }))
  })

  it('completes device login and adds a separately selectable subscription model without a bearer token', async () => {
    vi.useFakeTimers()
    const api = await mount(false)
    await click('Sign in with ChatGPT · subscription')
    await click('Sign in with ChatGPT')
    expect(container.textContent).toContain('CODE-1234')
    expect(container.querySelector('a')?.href).toBe('https://auth.openai.com/codex/device')
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.pollChatgptLogin).toHaveBeenCalledWith('attempt')
    await click('GPT 5.6 Sol')
    expect(container.querySelector('input[aria-label="API Token"]')).toBeNull()
    await click('Add Model')
    expect(api.addModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai:chatgpt:gpt-5.6-sol' }),
      { provider: 'openai', model: 'gpt-5.6-sol', authMode: 'chatgpt', apiToken: '' })
  })
})

// Restore the surrounding test runner's React setting after this file.
afterAll(() => {
  if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous
})
