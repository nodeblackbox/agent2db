/// <reference types="vite/client" />
import type { Agent2DbApi } from '../../shared/types';

declare global {
  interface Window {
    agent2db: Agent2DbApi;
  }
}
