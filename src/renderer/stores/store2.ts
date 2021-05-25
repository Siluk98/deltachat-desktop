import { useRef } from 'react'
import { useState, useEffect, useLayoutEffect } from 'react'
import { getLogger } from '../../shared/logger'

export type Action<S, C> =
  | ((context: C, state: S) => void)
  | 'DECREASE_CURRENTLY_DISPATCHED_COUNTER'

export interface EffectInterface<S, C> {
  (
    action: Action<S, C>,
    state: S,
    log: ReturnType<typeof getLogger>
  ): Promise<S>
}

export interface StoreListener<S, C> {
  onStateChange: (state: S) => void
  onForceTriggerEffect: () => void
  onPushEffect: (a: Action<S, C>) => void
  onPushLayoutEffect: (a: Action<S, C>) => void
}

export interface StoreDispatchSetState<S> {
  (state: S): Promise<void>
}

export interface OnDispatchParameters {
  currentlyDispatchedCounter: number
  incrementingDispatchedCounter: number
  name: string
}

export interface OnDispatchCheck {
  (checkState: OnDispatchParameters): boolean
}

export interface BeforeSetStateParameters {
  currentlyDispatchedCounter: number
  incrementingDispatchedCounter: number
  yourIncrementingDispatchedCounter: number
  name: string
}

export interface BeforeSetStateCheck {
  (checkState: BeforeSetStateParameters): boolean
}

export function OnlyDispatchIfCurrentlyDispatchedCounterEqualsZero(
  args: OnDispatchParameters
) {
  if (args.currentlyDispatchedCounter !== 0) return false
  return true
}

export function OnlySetStateIfIncrementingDispatchedCounterDidntIncrease(
  args: BeforeSetStateParameters
) {
  if (
    args.incrementingDispatchedCounter !==
    args.yourIncrementingDispatchedCounter
  )
    return false
  return true
}

// A store focused on tight communication between store and render cycle.
// This stores allows sending "effects" to the component that can be executed
// after the store updated. Respectively on useEffect or useLayoutEffect.
export default class Store2<S, C> {
  private listeners: StoreListener<S, C>[] = []
  private effects: { [key: string]: EffectInterface<S, C> } = {}
  private _log: ReturnType<typeof getLogger>
  public currentlyDispatchedCounter = 0
  public incrementingDispatchedCounter = 0

  constructor(public state: S, name?: string) {
    if (!name) name = 'Store2'
    this._log = getLogger('renderer/stores/' + name)
    this.init()
  }

  init() {}
  destroy() {}

  private get log() {
    return this._log
  }

  getState(): S {
    return this.state
  }

  async dispatch(
    name: string,
    effect: (
      state: S,
      setState: StoreDispatchSetState<S>,
      yourIncrementingDispatchedCounter: number
    ) => Promise<void>,
    onDispatchCheck?: OnDispatchCheck,
    beforeSetStateCheck?: BeforeSetStateCheck
  ): Promise<void> {
    this.log.debug('DISPATCH of type', name)
    if (onDispatchCheck) {
      const shouldDispatch = onDispatchCheck({
        currentlyDispatchedCounter: this.currentlyDispatchedCounter,
        incrementingDispatchedCounter: this.incrementingDispatchedCounter,
        name,
      })

      if (!shouldDispatch) {
        this.log.debug(
          `DISPATCHING of "${name}" aborted. onDispatchCheck was false.`
        )
        return
      }
    }

    this.incrementingDispatchedCounter++
    if (this.incrementingDispatchedCounter >= Number.MAX_SAFE_INTEGER - 1) {
      this.incrementingDispatchedCounter = 0
    }

    const yourIncrementingDispatchedCounter = this.incrementingDispatchedCounter
    this.currentlyDispatchedCounter++
    this.log.debug(
      `DISPATCHING OF ${name} increased the currentlyDispatchedCounter ${this.currentlyDispatchedCounter}`
    )

    let calledSetState = false
    const setState = async (updatedState: S) => {
      calledSetState = true
      if (updatedState === this.state) {
        this.log.debug(
          `DISPATCHING of "${name}" didn't change the state. Returning.`
        )
        this.currentlyDispatchedCounter--
        return
      }
      this.log.debug(
        `DISPATCHING of "${name}" changed the state. Before:`,
        this.state,
        'After:',
        updatedState
      )

      if (beforeSetStateCheck) {
        const shouldSetState = beforeSetStateCheck({
          currentlyDispatchedCounter: this.currentlyDispatchedCounter,
          incrementingDispatchedCounter: this.incrementingDispatchedCounter,
          yourIncrementingDispatchedCounter,
          name,
        })

        if (!shouldSetState) {
          this.log.debug(
            `DISPATCHING of "${name}" aborted. beforeSetStateCheck was false.`
          )
          this.currentlyDispatchedCounter--
          return
        }
      }
      this.pushEffect('DECREASE_CURRENTLY_DISPATCHED_COUNTER')
      await this.setState(async _state => {
        return updatedState
      })
    }

    await effect.call(
      this,
      this.state,
      setState,
      yourIncrementingDispatchedCounter
    )
    if (!calledSetState) this.currentlyDispatchedCounter--
  }

  private subscribe(listener: StoreListener<S, C>) {
    this.listeners.push(listener)
    return this.unsubscribe.bind(this, listener)
  }

  private unsubscribe(listener: StoreListener<S, C>) {
    const index = this.listeners.indexOf(listener)
    this.listeners.splice(index, 1)
  }

  async setState(cb: (state: S) => Promise<S> | S) {
    const updatedState = await cb(this.state)
    if (!updatedState || updatedState === this.state) {
      this.log.info("setState: state didn't change")
      return
    }
    this.log.info('setState: state changed')
    this.state = updatedState
    for (const listener of this.listeners) {
      listener.onStateChange(this.state)
    }
  }

  async pushEffect(action: Action<S, C>, forceUpdate?: boolean) {
    this.log.info(
      `pushEffect: pushed effect ${
        typeof action !== 'function' ? action : action.name
      } ${action}`
    )
    for (const listener of this.listeners) {
      listener.onPushEffect(action)
    }
    if (forceUpdate === true) {
      for (const listener of this.listeners) {
        listener.onForceTriggerEffect()
      }
    }
  }

  async pushLayoutEffect(action: Action<S, C>, forceUpdate?: boolean) {
    this.log.info(
      `pushLayoutEffect: pushed layout effect ${
        typeof action !== 'function' ? action : action.name
      } ${action}`
    )
    for (const listener of this.listeners) {
      listener.onPushLayoutEffect(action)
    }
    if (forceUpdate === true) {
      for (const listener of this.listeners) {
        listener.onForceTriggerEffect()
      }
    }
  }

  useStore(
    context: C,
    beforeSetState?: () => void
  ): { state: S; layoutEffectQueue: React.MutableRefObject<Action<S, C>[]> } {
    const [state, _setState] = useState(this.getState())
    const [forceTriggerEffect, setForceTriggerEffect] = useState(false)
    const effectQueue = useRef<Action<S, C>[]>([])
    const layoutEffectQueue = useRef<Action<S, C>[]>([])

    const setState = (state: S) => {
      if (beforeSetState) beforeSetState()
      _setState(state)
    }

    useEffect(() => {
      return this.subscribe({
        onStateChange: setState,
        onForceTriggerEffect: () =>
          setForceTriggerEffect(prevState => !prevState),
        onPushEffect: a => effectQueue.current.push(a),
        onPushLayoutEffect: a => layoutEffectQueue.current.push(a),
      })
    }, [])

    useEffect(() => {
      this.log.debug('useEffect')

      while (effectQueue.current.length > 0) {
        const effect = effectQueue.current.pop()
        if (typeof effect === 'function') {
          effect(context, state)
        } else if (effect === 'DECREASE_CURRENTLY_DISPATCHED_COUNTER') {
          this.currentlyDispatchedCounter--
          this.log.debug(
            'useEffect: DECREASE_CURRENTLY_DISPATCHED_COUNTER',
            this.currentlyDispatchedCounter
          )
          continue
        }
      }
    }, [state, forceTriggerEffect])

    useLayoutEffect(() => {
      this.log.debug('useLayoutEffect')
      while (layoutEffectQueue.current.length > 0) {
        const effect = layoutEffectQueue.current.pop()
        if (typeof effect === 'function') {
          effect(context, state)
        }
      }
    }, [state, forceTriggerEffect])

    return { state, layoutEffectQueue }
  }
}