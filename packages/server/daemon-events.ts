import type { DaemonRouterEvent } from "./daemon-router";

export type DaemonEventListener = (event: DaemonRouterEvent) => void;

export interface DaemonEventBus {
  dispatch: (event: DaemonRouterEvent) => void;
  emit: (event: DaemonRouterEvent) => void;
  publish: (event: DaemonRouterEvent) => void;
  subscribe: (listener: DaemonEventListener) => () => void;
}

export function createDaemonEventBus(): DaemonEventBus {
  const listeners = new Set<DaemonEventListener>();

  const publish = (event: DaemonRouterEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    dispatch: publish,
    emit: publish,
    publish,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
